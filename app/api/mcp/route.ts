/**
 * MCP endpoint (Streamable HTTP). Bearer token issued by our own OAuth server (Better Auth mcp plugin):
 * the token's subject is the user id, so every tool call runs under that user's row-level security.
 * Serves both the 2026-07-28 protocol and 2025-era stateless clients.
 */
import { requireMcpAuth } from '@better-auth/mcp';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { auth, mcpResource } from '@/lib/auth';
import { buildMcpServer } from '@/src/mcp/server';

export const dynamic = 'force-dynamic';

const handler = createMcpHandler(({ authInfo }) => {
  const userId = authInfo?.extra?.userId;
  if (typeof userId !== 'string') throw new Error('unauthenticated');
  return buildMcpServer({ userId, actor: 'claude', source: 'mcp' });
});

const protectedHandler = requireMcpAuth(
  auth,
  (request, claims) => {
    if (!claims.sub) return new Response('token has no subject', { status: 401 });
    return handler.fetch(request, {
      authInfo: {
        token: '',
        clientId: String(claims.azp ?? claims.client_id ?? ''),
        scopes: typeof claims.scope === 'string' ? claims.scope.split(' ') : [],
        expiresAt: claims.exp,
        resource: new URL(mcpResource),
        extra: { userId: claims.sub },
      },
    });
  },
  { resource: mcpResource },
);

export const POST = protectedHandler;
export const GET = protectedHandler;
export const DELETE = protectedHandler;
