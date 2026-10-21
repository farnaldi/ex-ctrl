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
import { createAuthMiddleware, isAPIError } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { jwt } from 'better-auth/plugins';
import pg from 'pg';
import { pool } from '../src/core/db.ts';
import { recordSignIn, signInLocked } from './security.ts';

const isProd = process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build';
// Fail at startup rather than run with a default secret or a wrong public URL (OAuth issuer and redirects depend on it)
if (isProd) {
  for (const v of ['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'DATABASE_URL', 'AUTH_DATABASE_URL'])
    if (!process.env[v]) throw new Error(`${v} is not set`);
  if ((process.env.BETTER_AUTH_SECRET ?? '').length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
}

const baseURL = (process.env.BETTER_AUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '');
export const mcpResource = `${baseURL}/api/mcp`;

/**
 * Domains MCP clients may redirect to without a warning on the consent screen (comma-separated; subdomains
 * included). Any other domain still works, but the user sees in red that it is not on the list.
 */
export const trustedRedirectDomains = () =>
  (process.env.TRUSTED_REDIRECT_DOMAINS ?? 'claude.ai,claude.com,chatgpt.com')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

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
  advanced: {
    database: { generateId: 'uuid' },
    useSecureCookies: baseURL.startsWith('https://'),
    // Client IP for rate limiting: only a header set by our own edge. Railway sets X-Real-IP; X-Forwarded-For
    // can be prepended by the client, which let anyone dodge the limit by sending a different value each time.
    ipAddress: { ipAddressHeaders: [(process.env.TRUSTED_IP_HEADER ?? 'x-real-ip').toLowerCase()] },
  },
  rateLimit: {
    enabled: process.env.NODE_ENV === 'production' || process.env.RATE_LIMIT === 'on',
    storage: 'database', // survives restarts and deploys
    window: 60,
    max: 100,
    customRules: {
      '/sign-in/email': { window: 60, max: 5 },
      '/sign-up/email': { window: 3600, max: 5 },
      '/oauth2/register': { window: 3600, max: 20 },
      '/oauth2/token': { window: 60, max: 30 },
    },
  },
  hooks: {
    // per-account lockout: 10 failed sign-ins in 15 minutes lock that email for the rest of the window
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/sign-in/email' && typeof ctx.body?.email === 'string' && signInLocked(ctx.body.email))
        throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many failed attempts. Try again in 15 minutes.' });
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/sign-in/email' && typeof ctx.body?.email === 'string')
        recordSignIn(ctx.body.email, !isAPIError(ctx.context.returned));
    }),
  },
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
      // Short-lived access tokens: a disconnected or leaked one stops working soon (clients refresh silently)
      accessTokenExpiresIn: 15 * 60,
      refreshTokenExpiresIn: 30 * 24 * 3600,
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

const clientNames = new Map<string, string | null>();

/** Name the MCP client registered with (shown in the change history as the agent). */
export async function oauthClientName(clientId: string): Promise<string | null> {
  if (!clientId) return null;
  if (clientNames.has(clientId)) return clientNames.get(clientId)!;
  const r = await authPool.query<{ name: string | null }>(`select name from "oauthClient" where "clientId" = $1`, [clientId]);
  const name = r.rows[0]?.name ?? null;
  clientNames.set(clientId, name);
  return name;
}

const known = new Map<string, number>(); // user id -> checked at (ms)

/**
 * The user an MCP token or a session belongs to: must exist in auth (a token whose subject is not a real
 * user is rejected), and gets its finance row ensured. Checked once a minute per user and process.
 */
export async function resolveUser(userId: string): Promise<boolean> {
  const at = known.get(userId);
  if (at && Date.now() - at < 60_000) return true;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return false;
  const r = await authPool.query<{ email: string; name: string | null }>(`select email, name from "user" where id = $1`, [userId]);
  if (!r.rows.length) return false;
  await ensureFinanceUser(userId, r.rows[0].email, r.rows[0].name || null);
  known.set(userId, Date.now());
  return true;
}

// ---- connected agents (OAuth): list and disconnect

export async function listConnectedAgents(userId: string) {
  const r = await authPool.query<{ id: string; client_id: string; name: string | null; uri: string | null; created_at: Date; last_used: Date | null }>(
    `select c.id, c."clientId" as client_id, o.name, o.uri, c."createdAt" as created_at,
            (select max(t."createdAt") from "oauthRefreshToken" t where t."userId" = c."userId" and t."clientId" = c."clientId") as last_used
     from "oauthConsent" c left join "oauthClient" o on o."clientId" = c."clientId"
     where c."userId" = $1 order by c."createdAt" desc`,
    [userId],
  );
  return r.rows;
}

/** Removes the consent and revokes its refresh tokens; /api/mcp stops accepting its access tokens within a minute. */
export async function disconnectAgent(userId: string, consentId: string) {
  const c = await authPool.query<{ clientId: string }>(`delete from "oauthConsent" where id = $1 and "userId" = $2 returning "clientId"`, [consentId, userId]);
  if (!c.rows.length) return false;
  await authPool.query(`update "oauthRefreshToken" set revoked = now() where "userId" = $1 and "clientId" = $2 and revoked is null`, [userId, c.rows[0].clientId]);
  consentCache.delete(`${userId}|${c.rows[0].clientId}`);
  return true;
}

const consentCache = new Map<string, number>();

/** The user still allows this client (checked at most once a minute). */
export async function hasConsent(userId: string, clientId: string): Promise<boolean> {
  const key = `${userId}|${clientId}`;
  const at = consentCache.get(key);
  if (at && Date.now() - at < 60_000) return true;
  const r = await authPool.query(`select 1 from "oauthConsent" where "userId" = $1 and "clientId" = $2`, [userId, clientId]);
  if (!r.rows.length) return false;
  consentCache.set(key, Date.now());
  return true;
}
