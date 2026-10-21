/**
 * Personal access tokens for agents that can't do the MCP OAuth flow.
 * Format: fin_<8 chars>_<43 chars>. Only the sha256 hash is stored; the token is shown once.
 */
import { createHash, randomBytes } from 'node:crypto';
import { pool, read, write, type Ctx } from './db.ts';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export const isApiToken = (t: string) => /^fin_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/.test(t);

export async function createApiToken(ctx: Ctx, opts: { name: string; readOnly?: boolean; expiresInDays?: number | null }) {
  const name = opts.name.trim();
  if (!name || name.length > 60) throw new Error('name: 1 to 60 characters');
  const prefix = randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);
  const token = `fin_${prefix}_${randomBytes(32).toString('base64url')}`;
  const { result } = await write(ctx, `create API token "${name}"`, async (db) => {
    const r = await db.query<{ id: number }>(
      `insert into api_tokens (name, prefix, token_hash, read_only, expires_at)
       values ($1, $2, $3, $4, case when $5::int is null then null else now() + make_interval(days => $5::int) end)
       returning id`,
      [name, `fin_${prefix}`, hash(token), opts.readOnly ?? false, opts.expiresInDays ?? null],
    );
    return r.rows[0].id;
  });
  return { id: result, name, token };
}

export async function listApiTokens(ctx: Ctx) {
  return read(ctx, async (db) =>
    (
      await db.query<{
        id: number; name: string; prefix: string; read_only: boolean;
        created_at: Date; last_used_at: Date | null; expires_at: Date | null; revoked_at: Date | null;
      }>(`select id, name, prefix, read_only, created_at, last_used_at, expires_at, revoked_at from api_tokens order by revoked_at nulls first, created_at desc`)
    ).rows,
  );
}

export async function revokeApiToken(ctx: Ctx, id: number) {
  await write(ctx, `revoke API token ${id}`, async (db) => {
    const r = await db.query(`update api_tokens set revoked_at = now() where id = $1 and revoked_at is null`, [id]);
    if (!r.rowCount) throw new Error(`token ${id} not found or already revoked`);
  });
}

/** Token -> its user (null when unknown, revoked or expired). Runs before any user is known. */
export async function verifyApiToken(token: string) {
  if (!isApiToken(token)) return null;
  const r = await pool().query<{ user_id: string; token_id: number; name: string; read_only: boolean }>(
    `select * from resolve_api_token($1)`,
    [hash(token)],
  );
  return r.rows[0] ?? null;
}
