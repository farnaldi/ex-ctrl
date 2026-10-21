-- Personal access tokens: for agents that can't do the MCP OAuth flow (own scripts, n8n, Agent SDK...).
-- Created in the web app, belong to one user, revocable, optionally read-only. Only a hash is stored.
-- Writes made with a token are audited as an agent, with the token's name, so the history shows which agent did what.

create table api_tokens (
  user_id      uuid not null default app_user_id() references users(id) on delete cascade,
  id           serial primary key,
  name         text not null,
  prefix       text not null,                          -- first characters, to recognise it in the list
  token_hash   text not null unique,                   -- sha256 of the full token
  read_only    boolean not null default false,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  unique (user_id, id),
  unique (user_id, name)
);

alter table api_tokens enable row level security;
alter table api_tokens force row level security;
create policy tenant on api_tokens using (user_id = app_user_id()) with check (user_id = app_user_id());

-- Token -> user, before any user is known (so RLS can't apply yet). Runs as the table owner, takes only the
-- hash, returns only the owner of a live token, and records its use. Nothing else is reachable through it.
create function resolve_api_token(p_token_hash text)
returns table (user_id uuid, token_id int, name text, read_only boolean)
language sql security definer set search_path = public, pg_temp as $$
  update api_tokens t set last_used_at = now()
   where t.token_hash = p_token_hash and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
  returning t.user_id, t.id, t.name, t.read_only
$$;
revoke all on function resolve_api_token(text) from public;

-- Which agent made a change: the OAuth client's name or the token's name
alter table audit_log add column agent text;

create or replace function trg_audit() returns trigger language plpgsql as $$
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
  insert into audit_log (user_id, op_id, actor, source, agent, operation, table_name, op, row_key, before, after)
  values ((v_row ->> 'user_id')::uuid,
          coalesce(app_op_id(), gen_random_uuid()),
          v_actor,
          nullif(current_setting('app.source', true), ''),
          nullif(current_setting('app.agent', true), ''),
          nullif(current_setting('app.op', true), ''),
          tg_table_name, lower(tg_op), v_key,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;

drop view v_operations;
create view v_operations with (security_invoker = true) as
select op_id,
       min(at)                              as at,
       min(actor)                           as actor,
       min(source)                          as source,
       min(agent)                           as agent,
       min(operation)                       as operation,
       count(*)                             as rows_changed,
       array_agg(distinct table_name)       as tables,
       bool_or(undone_by is not null)       as undone,
       min(undone_by::text)::uuid           as undone_by
from audit_log
group by op_id;
