-- Undo: never remove a row that later work still hangs off.
-- Reverting an insert (e.g. undoing an import) used to delete the row even when a later operation had added
-- something that references it: tags were lost through ON DELETE CASCADE, and a one-off note made the undo
-- fail with a raw foreign-key error. Now any row still referencing it blocks the undo with a clear message.
-- (Rows the operation itself created are reverted first, newest first, so they never block.)

create index if not exists context_notes_transaction on context_notes (user_id, transaction_id);

create or replace function undo_operation(p_op_id uuid) returns int language plpgsql as $$
declare
  r record;
  fk record;
  n int := 0;
  v_where text;
  v_cols text;
  v_current jsonb;
  v_dependents bigint;
begin
  if app_op_id() is null then raise exception 'undo must run inside an operation (app.op_id not set)'; end if;
  if not exists (select 1 from audit_log where op_id = p_op_id) then raise exception 'operation % not found', p_op_id; end if;
  if exists (select 1 from audit_log where op_id = p_op_id and undone_by is not null) then
    raise exception 'operation % was already undone', p_op_id;
  end if;

  perform set_config('app.replaying', 'on', true);
  for r in select * from audit_log where op_id = p_op_id order by id desc loop
    select string_agg(format('%I = (%L::jsonb ->> %L)::%s', k, r.row_key, k, format_type(a.atttypid, a.atttypmod)), ' and ')
      into v_where
      from jsonb_object_keys(r.row_key) k
      join pg_attribute a on a.attrelid = r.table_name::regclass and a.attname = k;

    execute format('select to_jsonb(t) from %I t where %s', r.table_name, v_where) into v_current;
    if r.op in ('insert','update') and v_current is distinct from r.after then
      raise exception 'cannot undo: % % changed after this operation (undo the later operation first)', r.table_name, r.row_key;
    end if;
    if r.op = 'delete' and v_current is not null then
      raise exception 'cannot undo: % % was re-created after this operation', r.table_name, r.row_key;
    end if;

    if r.op = 'insert' then
      -- rows in other tables that still reference this one (foreign keys onto its "id")
      if r.row_key ? 'id' then
        for fk in
          select c.conrelid::regclass::text as tbl, ca.attname as col
          from pg_constraint c
          cross join lateral unnest(c.conkey, c.confkey) as k(child, parent)
          join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = k.parent and pa.attname = 'id'
          join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = k.child
          where c.contype = 'f' and c.confrelid = r.table_name::regclass
        loop
          execute format('select count(*) from %I d where d.%I::text = $1', fk.tbl, fk.col) into v_dependents using r.row_key ->> 'id';
          if v_dependents > 0 then
            raise exception 'cannot undo: % % still has % row(s) in % added after this operation (undo those first)',
              r.table_name, r.row_key, v_dependents, fk.tbl;
          end if;
        end loop;
      end if;
      execute format('delete from %I where %s', r.table_name, v_where);
    elsif r.op = 'delete' then
      execute format('insert into %I select * from jsonb_populate_record(null::%I, $1)', r.table_name, r.table_name) using r.before;
    else
      select string_agg(quote_ident(attname), ', ' order by attnum) into v_cols
        from pg_attribute
       where attrelid = r.table_name::regclass and attnum > 0 and not attisdropped and attgenerated = '';
      execute format('update %I set (%s) = (select %s from jsonb_populate_record(null::%I, $1)) where %s',
                     r.table_name, v_cols, v_cols, r.table_name, v_where) using r.before;
    end if;
    n := n + 1;
  end loop;

  perform set_config('app.replaying', '', true);
  update audit_log set undone_by = app_op_id() where op_id = p_op_id;
  return n;
end $$;
