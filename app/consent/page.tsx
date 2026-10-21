import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { auth } from '@/lib/auth';
import { ConsentForm } from './consent-form';

export const dynamic = 'force-dynamic';

/**
 * OAuth consent for an MCP client (e.g. Claude). Client registration is open (MCP clients register
 * themselves), so this page is the real gate: it shows who is asking and, above all, where the
 * authorization will be sent. Anything registered by a third party shows up here with its own domain.
 */
export default async function ConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) qs.append(k, x);
  const q = Object.fromEntries(qs) as Record<string, string | undefined>;
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session) redirect('/login');

  let client: { client_name?: string; redirect_uris?: string[] } | null = null;
  try {
    client = q.client_id ? await auth.api.getOAuthClientPublic({ query: { client_id: q.client_id }, headers: h }) : null;
  } catch {
    client = null;
  }
  // The query was signed by our authorization server after it checked client_id and redirect_uri against the
  // registered client; a valid signature means what is shown below is what will happen.
  const signed = await verifyOAuthQueryParams(qs.toString(), (await auth.$context).secret).catch(() => false);

  let redirectHost: string | null = null;
  try {
    redirectHost = q.redirect_uri ? new URL(q.redirect_uri).host : null;
  } catch {
    redirectHost = null;
  }
  const knownClaude = redirectHost === 'claude.ai' || redirectHost?.endsWith('.claude.ai') || redirectHost === 'claude.com';
  const scopes = (q.scope ?? '').split(' ').filter(Boolean);

  if (!client || !signed || !redirectHost) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4">
        <h1 className="mb-2 text-xl font-semibold tracking-tight">Solicitud no válida</h1>
        <p className="text-sm text-muted">El enlace de autorización no es válido o venció. Volvé a conectar desde la aplicación.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4">
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Conectar un agente</h1>
      <div className="mb-4 rounded-xl border border-line bg-surface p-4">
        <p className="font-medium">{client.client_name ?? 'Aplicación sin nombre'}</p>
        <p className="mt-1 text-sm">
          Te va a devolver a <span className="font-mono font-semibold">{redirectHost}</span>
        </p>
        {!knownClaude && (
          <p className="mt-2 text-sm text-danger">
            Este dominio no es de Claude. Permití solo si reconocés esta aplicación.
          </p>
        )}
      </div>
      <p className="mb-4 text-sm text-muted">
        Va a poder ver tus movimientos, categorías, compromisos y pronóstico, y cargar o editar datos como{' '}
        {session.user.email}. Cada cambio que haga queda en el historial y se puede deshacer.
      </p>
      {scopes.length > 0 && <p className="mb-6 text-xs text-muted">Permisos: {scopes.join(', ')}</p>}
      <ConsentForm />
    </main>
  );
}
