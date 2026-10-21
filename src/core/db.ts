/**
 * Database access for the web app and the MCP server.
 *
 * Every read and write goes through withUser(): one transaction with app.user_id set, so Postgres row-level
 * security scopes it to that user. Writes also set the actor and an operation id, so the audit log records
 * who changed what (user in the web app, claude through MCP) and the whole operation can be undone.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';

// numeric -> number, date -> 'YYYY-MM-DD' string (no timezone shifts)
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Actor = 'user' | 'claude';
export type Source = 'web' | 'mcp' | 'cli';

export interface Ctx {
  userId: string;
  /** 'user' = a person in the web app; 'claude' = any agent (Claude or another MCP client / API token) */
  actor: Actor;
  source: Source;
  /** Which agent: the OAuth client's name or the API token's name (shown in the history) */
  agent?: string;
}

export type Tx = pg.PoolClient;

const g = globalThis as unknown as { __financePool?: pg.Pool };

/** App-role pool (DATABASE_URL): never a superuser, so RLS applies. */
export function pool(): pg.Pool {
  if (!g.__financePool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    g.__financePool = new pg.Pool({ connectionString: url, max: 10 });
  }
  return g.__financePool;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run<T>(ctx: Ctx, operation: string | null, readOnly: boolean, fn: (db: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(ctx.userId)) throw new Error('invalid user id');
  const db = await pool().connect();
  try {
    await db.query(readOnly ? 'begin read only' : 'begin');
    await db.query(
      `select set_config('app.user_id', $1, true), set_config('app.actor', $2, true), set_config('app.source', $3, true),
              set_config('app.op_id', $4, true), set_config('app.op', $5, true), set_config('app.agent', $6, true)`,
      [ctx.userId, readOnly ? '' : ctx.actor, ctx.source, readOnly ? '' : randomUUID(), operation ?? '', ctx.agent ?? ''],
    );
    const result = await fn(db);
    await db.query('commit');
    return result;
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

/** Read-only transaction as the user. */
export function read<T>(ctx: Ctx, fn: (db: Tx) => Promise<T>): Promise<T> {
  return run(ctx, null, true, fn);
}

/**
 * Write transaction as the user: one audited operation. Returns the result plus the operation id
 * (pass it to undo to revert everything this operation changed).
 */
export async function write<T>(ctx: Ctx, operation: string, fn: (db: Tx) => Promise<T>): Promise<{ result: T; opId: string }> {
  let opId = '';
  const result = await run(ctx, operation, false, async (db) => {
    opId = (await db.query<{ op: string }>(`select current_setting('app.op_id') as op`)).rows[0].op;
    return fn(db);
  });
  return { result, opId };
}

/** Postgres error -> message safe to show to the user / agent. */
export function dbErrorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const err = e as { message: string; detail?: string; hint?: string };
    return [err.message, err.detail, err.hint].filter(Boolean).join(' — ');
  }
  return String(e);
}
