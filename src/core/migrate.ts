/**
 * Schema migrations and database roles.
 *
 * Runs with ADMIN_DATABASE_URL (the database owner, e.g. Railway's postgres user):
 *   1. db/schema.sql once (recorded as 000_schema), then db/migrations/*.sql in order, each once.
 *   2. Roles taken from the other two URLs, so there is one source of truth for their passwords:
 *        DATABASE_URL       -> app role: RLS applies (no superuser, no bypassrls), data tables only
 *        AUTH_DATABASE_URL  -> auth role: owns schema "auth" (Better Auth tables), no access to the data
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function roleFrom(envVar: string): { name: string; password: string } | null {
  const url = process.env[envVar];
  if (!url) return null;
  const u = new URL(url);
  if (!u.username || !u.password) throw new Error(`${envVar} must include a user and password`);
  return { name: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

async function ensureRole(db: pg.Client, role: { name: string; password: string }) {
  const ident = (await db.query<{ q: string }>(`select quote_ident($1) as q`, [role.name])).rows[0].q;
  const lit = (await db.query<{ q: string }>(`select quote_literal($1) as q`, [role.password])).rows[0].q;
  const exists = (await db.query(`select 1 from pg_roles where rolname = $1`, [role.name])).rows.length > 0;
  await db.query(`${exists ? 'alter' : 'create'} role ${ident} login nosuperuser nobypassrls password ${lit}`);
  return ident;
}

export async function migrate(log: (s: string) => void = console.log) {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error('ADMIN_DATABASE_URL is not set');
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  try {
    await db.query(`select pg_advisory_lock(727271)`); // one migrator at a time (several deploys starting together)
    await db.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const applied = new Set((await db.query<{ name: string }>(`select name from schema_migrations`)).rows.map((r) => r.name));

    const files: [string, string][] = [['000_schema', join(root, 'db/schema.sql')]];
    for (const f of readdirSync(join(root, 'db/migrations')).filter((f) => f.endsWith('.sql')).sort())
      files.push([f.replace(/\.sql$/, ''), join(root, 'db/migrations', f)]);

    for (const [name, path] of files) {
      if (applied.has(name)) continue;
      if (name === '000_schema' && (await db.query(`select to_regclass('public.users') as t`)).rows[0].t) {
        // database created before migrations were tracked
        await db.query(`insert into schema_migrations (name) values ($1)`, [name]);
        log(`  ${name}: already present, recorded`);
        continue;
      }
      await db.query('begin');
      try {
        await db.query(readFileSync(path, 'utf8'));
        await db.query(`insert into schema_migrations (name) values ($1)`, [name]);
        await db.query('commit');
        log(`  ${name}: applied`);
      } catch (e) {
        await db.query('rollback');
        throw new Error(`${name}: ${(e as Error).message}`);
      }
    }

    const app = roleFrom('DATABASE_URL');
    if (app) {
      const r = await ensureRole(db, app);
      await db.query(`grant usage on schema public to ${r}`);
      await db.query(`grant select, insert, update, delete on all tables in schema public to ${r}`);
      await db.query(`revoke delete, truncate on audit_log from ${r}`); // history can be read and marked undone, never erased
      await db.query(`revoke update on audit_log from ${r}`);
      await db.query(`grant update (undone_by) on audit_log to ${r}`);
      await db.query(`revoke all on schema_migrations from ${r}`);
      await db.query(`grant usage on all sequences in schema public to ${r}`);
      await db.query(`grant execute on all functions in schema public to ${r}`);
      log(`  role ${app.name}: ready (RLS applies)`);
    }
    const auth = roleFrom('AUTH_DATABASE_URL');
    if (auth) {
      if (app && auth.name === app.name) throw new Error('AUTH_DATABASE_URL and DATABASE_URL must use different roles');
      const r = await ensureRole(db, auth);
      await db.query(`create schema if not exists auth authorization ${r}`);
      await db.query(`alter role ${r} set search_path = auth`);
      await db.query(`revoke all on schema public from ${r}`);
      await db.query(`revoke all on schema auth from public`);
      log(`  role ${auth.name}: ready (schema auth)`);
    }
  } finally {
    await db.query(`select pg_advisory_unlock(727271)`).catch(() => {});
    await db.end();
  }
}
