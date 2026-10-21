/**
 * OAuth discovery documents at the site root (next.config rewrites /.well-known/* here), since Better Auth
 * lives under /api/auth. MCP clients read these to find how to sign in:
 *   /.well-known/oauth-protected-resource[/api/mcp]   -> served by the mcp plugin
 *   /.well-known/oauth-authorization-server[/api/auth] and /.well-known/openid-configuration[/api/auth]
 */
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider';
import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const authServer = oauthProviderAuthServerMetadata(auth);
const openId = oauthProviderOpenIdConfigMetadata(auth);

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const [doc, ...rest] = (await params).path;
  const url = new URL(request.url);
  switch (doc) {
    case 'oauth-protected-resource': {
      // the plugin matches on the public path, so hand it the original URL
      const original = new URL(`/.well-known/oauth-protected-resource${rest.length ? `/${rest.join('/')}` : ''}`, url.origin);
      return auth.handler(new Request(original, { headers: request.headers }));
    }
    case 'oauth-authorization-server':
      return authServer(request);
    case 'openid-configuration':
      return openId(request);
    default:
      return new Response('not found', { status: 404 });
  }
}
