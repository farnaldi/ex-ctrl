/**
 * Better Auth: sign-in for the web app, and the OAuth 2.1 authorization server the MCP connector uses.
 *
 * Its tables live in schema "auth", reached through AUTH_DATABASE_URL (a role with no access to the finance data).
 * Auth user ids are uuids and equal public.users.id, so a session's user id is exactly what RLS needs.
 */
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import { APIError, betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { jwt } from 'better-auth/plugins';
import pg from 'pg';
import { pool } from '../src/core/db.ts';

const isProd = process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build';
// Fail at startup rather than run with a default secret or a wrong public URL (OAuth issuer and redirects depend on it)
if (isProd) {
  for (const v of ['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'DATABASE_URL', 'AUTH_DATABASE_URL'])
    if (!process.env[v]) throw new Error(`${v} is not set`);
  if ((process.env.BETTER_AUTH_SECRET ?? '').length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
}

const baseURL = (process.env.BETTER_AUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '');
export const mcpResource = `${baseURL}/api/mcp`;

/** Comma-separated emails allowed to create an account. Empty = nobody new (existing users still sign in). */
const allowedEmails = () =>
  (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

const g = globalThis as unknown as { __authPool?: pg.Pool };
const authPool = (g.__authPool ??= new pg.Pool({ connectionString: process.env.AUTH_DATABASE_URL, max: 5 }));

export const auth = betterAuth({
  appName: 'Finanzas',
  baseURL,
  database: authPool,
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  advanced: { database: { generateId: 'uuid' } },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!allowedEmails().includes(user.email.toLowerCase()))
            throw new APIError('FORBIDDEN', { message: 'Registration is closed for this email.' });
          return { data: user };
        },
        // The finance side's users row (same id). Also ensured on every request (resolveUser), so a failure here
        // never leaves an account that can't write.
        after: async (user) => {
          await ensureFinanceUser(user.id, user.email, user.name || null);
        },
      },
    },
  },
  plugins: [
    jwt(),
    mcp({
      loginPage: '/login',
      consentPage: '/consent',
      resource: mcpResource,
      // MCP clients (Claude's custom connectors) register themselves before the user signs in;
      // the consent screen is what grants access.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // Only user-delegated tokens: no client_credentials (machine tokens with no user behind them)
      grantTypes: ['authorization_code', 'refresh_token'],
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;

/** Creates the user's public.users row if missing. RLS lets a session insert only its own row. */
async function ensureFinanceUser(id: string, email: string, name: string | null) {
  const db = await pool().connect();
  try {
    await db.query('begin');
    await db.query(`select set_config('app.user_id', $1, true)`, [id]);
    await db.query(`insert into users (id, email, display_name) values ($1, $2, $3) on conflict (id) do nothing`, [id, email, name]);
    await db.query('commit');
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

const known = new Map<string, number>(); // user id -> checked at (ms)

/**
 * The user an MCP token or a session belongs to: must exist in auth (a token whose subject is not a real
 * user is rejected), and gets its finance row ensured. Checked once every 5 minutes per user and process.
 */
export async function resolveUser(userId: string): Promise<boolean> {
  const at = known.get(userId);
  if (at && Date.now() - at < 5 * 60_000) return true;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return false;
  const r = await authPool.query<{ email: string; name: string | null }>(`select email, name from "user" where id = $1`, [userId]);
  if (!r.rows.length) return false;
  await ensureFinanceUser(userId, r.rows[0].email, r.rows[0].name || null);
  known.set(userId, Date.now());
  return true;
}
