/**
 * MCP endpoint (Streamable HTTP), for any MCP client. Two ways in:
 *   - OAuth (Claude, ChatGPT and other clients with MCP auth): bearer token issued by our own authorization
 *     server (Better Auth mcp plugin); its subject is the user id.
 *   - Personal access token (fin_…), created in the web app, for agents without MCP OAuth. Can be read-only.
 * Either way every tool call runs under that user's row-level security, and writes are audited with the
 * agent's name. Serves both the 2026-07-28 protocol and 2025-era stateless clients.
 */
import { requireMcpAuth } from '@better-auth/mcp';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { auth, hasConsent, mcpResource, oauthClientName, resolveUser } from '@/lib/auth';
import { mcpOriginAllowed, mcpRateLimited } from '@/lib/security';
import { isApiToken, verifyApiToken } from '@/src/core/tokens';
import { buildMcpServer } from '@/src/mcp/server';

export const dynamic = 'force-dynamic';

const handler = createMcpHandler(({ authInfo }) => {
  const extra = authInfo?.extra as { userId?: string; agent?: string; readOnly?: boolean } | undefined;
  if (typeof extra?.userId !== 'string') throw new Error('unauthenticated');
  return buildMcpServer({ userId: extra.userId, actor: 'claude', source: 'mcp', agent: extra.agent }, { readOnly: extra.readOnly });
});

const viaOAuth = requireMcpAuth(
  auth,
  async (request, claims) => {
    // a token must act for a real user (never a client acting for itself)
    if (!claims.sub || !(await resolveUser(claims.sub))) return new Response('token does not belong to a user', { status: 403 });
    const clientId = String(claims.azp ?? claims.client_id ?? '');
    // disconnected in the web app -> its still-valid access tokens stop working too
    if (!(await hasConsent(claims.sub, clientId))) return new Response('agent was disconnected', { status: 401 });
    if (mcpRateLimited(claims.sub)) return tooMany();
    return handler.fetch(request, {
      authInfo: {
        token: '',
        clientId,
        scopes: typeof claims.scope === 'string' ? claims.scope.split(' ') : [],
        expiresAt: claims.exp,
        resource: new URL(mcpResource),
        extra: { userId: claims.sub, agent: (await oauthClientName(clientId)) ?? clientId, readOnly: false },
      },
    });
  },
  { resource: mcpResource },
);

const tooMany = () =>
  Response.json({ jsonrpc: '2.0', error: { code: -32029, message: 'rate limit exceeded, retry in a minute' }, id: null }, {
    status: 429,
    headers: { 'retry-after': '60' },
  });

async function serve(request: Request): Promise<Response> {
  if (!mcpOriginAllowed(request.headers.get('origin'), new URL(mcpResource).origin))
    return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'origin not allowed' }, id: null }, { status: 403 });
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer && isApiToken(bearer)) {
    const t = await verifyApiToken(bearer);
    if (!t || !(await resolveUser(t.user_id)))
      return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'invalid, revoked or expired token' }, id: null }, { status: 401 });
    if (mcpRateLimited(t.user_id)) return tooMany();
    return handler.fetch(request, {
      authInfo: {
        token: '',
        clientId: `token:${t.token_id}`,
        scopes: t.read_only ? ['read'] : ['read', 'write'],
        resource: new URL(mcpResource),
        extra: { userId: t.user_id, agent: `token: ${t.name}`, readOnly: t.read_only },
      },
    });
  }
  return viaOAuth(request);
}

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
