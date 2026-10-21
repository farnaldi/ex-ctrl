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
        // The finance side's users row (same id). RLS lets a session insert only its own row.
        after: async (user) => {
          const db = await pool().connect();
          try {
            await db.query('begin');
            await db.query(`select set_config('app.user_id', $1, true)`, [user.id]);
            await db.query(`insert into users (id, email, display_name) values ($1, $2, $3) on conflict (id) do nothing`, [
              user.id, user.email, user.name || null,
            ]);
            await db.query('commit');
          } catch (e) {
            await db.query('rollback');
            throw e;
          } finally {
            db.release();
          }
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
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
