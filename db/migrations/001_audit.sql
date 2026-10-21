-- ============================================================
-- Who changed what, and undo.
--
-- Every write made through the web app or the MCP agent runs in one transaction that sets:
--   app.actor  'user' (web) | 'claude' (MCP agent)      -- null for imports run from the CLI and the knowledge file
--   app.op_id  one uuid per operation (a tool call, a form submit)
--   app.source 'web' | 'mcp' | 'cli'
--   app.op     short description of the operation ("categorize transaction 123")
-- Triggers then (1) record 'claude' instead of 'user' in the "who decided" columns when the agent did it,
-- and (2) log every changed row (before/after) in audit_log, so any operation can be undone as a unit.
-- ============================================================

create function app_actor() returns text language sql stable as $$
  select nullif(current_setting('app.actor', true), '')
$$;

create function app_op_id() returns uuid language sql stable as $$
  select nullif(current_setting('app.op_id', true), '')::uuid
$$;

-- True while undo_operation replays logged rows: the log already holds every side effect
-- (inherited tags, "who decided"), so triggers that derive data must not run again.
create function app_replaying() returns boolean language sql stable as $$
  select coalesce(current_setting('app.replaying', true), '') = 'on'
$$;

create or replace function trg_inherit_tags() returns trigger language plpgsql as $$
begin
  if app_replaying() then return null; end if;
  if new.commitment_id is not null then
    insert into transaction_tags (transaction_id, tag_id, tagged_by)
    select new.id, ct.tag_id, 'commitment' from commitment_tags ct
    where ct.commitment_id = new.commitment_id and ct.user_id = new.user_id
    on conflict do nothing;
  end if;
  if new.merchant_id is not null then
    insert into transaction_tags (transaction_id, tag_id, tagged_by)
    select new.id, mt.tag_id, 'merchant' from merchant_tags mt
    where mt.merchant_id = new.merchant_id and mt.user_id = new.user_id
    on conflict do nothing;
  end if;
  return null;
end $$;

-- ---- "who decided": knowledge functions write 'user'; when the agent made the change it becomes 'claude'
create function trg_decided_by() returns trigger language plpgsql as $$
declare col text := tg_argv[0];
begin
  if app_actor() = 'claude' and not app_replaying() and to_jsonb(new) ->> col = 'user' then
    new := jsonb_populate_record(new, jsonb_build_object(col, 'claude'));
  end if;
  return new;
end $$;

create trigger transactions_decided_by before insert or update on transactions
  for each row execute function trg_decided_by('categorized_by');
create trigger transaction_tags_decided_by before insert or update on transaction_tags
  for each row execute function trg_decided_by('tagged_by');
create trigger merchant_rules_decided_by before insert or update on merchant_rules
  for each row execute function trg_decided_by('source');
create trigger merchants_decided_by before insert or update on merchants
  for each row execute function trg_decided_by('created_by');
create trigger commitments_decided_by before insert or update on commitments
  for each row execute function trg_decided_by('detected_by');

-- ---- audit log
create table audit_log (
  user_id    uuid not null default app_user_id() references users(id) on delete cascade,
  id         bigserial primary key,
  op_id      uuid not null,
  at         timestamptz not null default now(),
  actor      text not null check (actor in ('user','claude')),
  source     text,
  operation  text,
  table_name text not null,
  op         text not null check (op in ('insert','update','delete')),
  row_key    jsonb not null,
  before     jsonb,
  after      jsonb,
  undone_by  uuid,                                    -- op_id of the operation that undid this one
  unique (user_id, id)
);
create index on audit_log (user_id, op_id);
create index on audit_log (user_id, at desc);

alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy tenant on audit_log using (user_id = app_user_id()) with check (user_id = app_user_id());

-- Trigger args: the table's key columns
create function trg_audit() returns trigger language plpgsql as $$
declare
  v_actor text := app_actor();
  v_row jsonb;
  v_key jsonb := '{}';
  k text;
begin
  if v_actor is null then return null; end if;             -- imports / CLI: not audited
  if tg_op = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then return null; end if;
  v_row := case tg_op when 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  foreach k in array tg_argv loop
    v_key := v_key || jsonb_build_object(k, v_row -> k);
  end loop;
  insert into audit_log (user_id, op_id, actor, source, operation, table_name, op, row_key, before, after)
  values ((v_row ->> 'user_id')::uuid,
          coalesce(app_op_id(), gen_random_uuid()),
          v_actor,
          nullif(current_setting('app.source', true), ''),
          nullif(current_setting('app.op', true), ''),
          tg_table_name, lower(tg_op), v_key,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;

create trigger audit after insert or update or delete on accounts           for each row execute function trg_audit('id');
create trigger audit after insert or update or delete on import_batches     for each row execute function trg_audit('id');
create trigger audit after insert or update or delete on categories         for each row execute function trg_audit('id');
create trigger audit after insert or update or delete on merchants          for each row execute function trg_audit('id');
create trigger audit after insert or update or delete on commitments        for each row execute function trg_audit('id');
create trigger audit after insert or update or delete on transactions       for each row execute function trg_audit('id');
create trigger audit after insert or update or delete on merchant_rules     for each row execute function trg_audit('id');
create trigger audit after insert or update or delete on context_notes      for each row execute function trg_audit('id');
create trigger audit after insert or update or delete on tags               for each row execute function trg_audit('id');
create trigger audit after insert or update or delete on anomalies          for each row execute function trg_audit('id');
create trigger audit after insert or update or delete on transaction_tags   for each row execute function trg_audit('transaction_id', 'tag_id');
create trigger audit after insert or update or delete on commitment_tags    for each row execute function trg_audit('commitment_id', 'tag_id');
create trigger audit after insert or update or delete on merchant_tags      for each row execute function trg_audit('merchant_id', 'tag_id');
create trigger audit after insert or update or delete on merchant_rule_tags for each row execute function trg_audit('merchant_rule_id', 'tag_id');
create trigger audit after insert or update or delete on context_note_tags  for each row execute function trg_audit('context_note_id', 'tag_id');

-- Undo one operation: every row it touched goes back to how it was, newest change first.
-- Refuses when a row was changed again afterwards (undo the later operation first), so an undo never
-- silently overwrites newer work. The undo is itself an audited operation (undo it to redo).
create function undo_operation(p_op_id uuid) returns int language plpgsql as $$
declare
  r record;
  n int := 0;
  v_where text;
  v_cols text;
  v_current jsonb;
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

-- One row per operation, for the "history" screen and the agent
create view v_operations with (security_invoker = true) as
select op_id,
       min(at)                              as at,
       min(actor)                           as actor,
       min(source)                          as source,
       min(operation)                       as operation,
       count(*)                             as rows_changed,
       array_agg(distinct table_name)       as tables,
       bool_or(undone_by is not null)       as undone,
       min(undone_by::text)::uuid           as undone_by
from audit_log
group by op_id;
