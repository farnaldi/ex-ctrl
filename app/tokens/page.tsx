import Link from 'next/link';
import { mcpResource } from '@/lib/auth';
import { requireWebCtx } from '@/lib/session';
import { listApiTokens } from '@/src/core/tokens';
import { revokeTokenAction } from './actions';
import { CreateTokenForm } from './create-form';

export const dynamic = 'force-dynamic';

const fmt = (d: Date | null) => (d ? new Date(d).toLocaleDateString('es-UY', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export default async function TokensPage() {
  const { ctx } = await requireWebCtx();
  const tokens = await listApiTokens(ctx);
  const now = Date.now();

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Link href="/" className="text-sm text-muted hover:underline">← Finanzas</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Tokens de acceso</h1>
      <p className="mt-2 text-sm text-muted">
        Para agentes que no se conectan con OAuth (scripts, n8n, agentes propios). Se usan contra{' '}
        <code className="rounded bg-surface px-1">{mcpResource}</code> con el header{' '}
        <code className="rounded bg-surface px-1">Authorization: Bearer fin_…</code>. Lo que hagan queda en el historial con el
        nombre del token.
      </p>

      <section className="mt-8 rounded-xl border border-line bg-surface p-5">
        <CreateTokenForm />
      </section>

      <section className="mt-8">
        {tokens.length === 0 ? (
          <p className="text-sm text-muted">Todavía no creaste tokens.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {tokens.map((t) => {
              const expired = t.expires_at && new Date(t.expires_at).getTime() < now;
              const inactive = !!t.revoked_at || !!expired;
              return (
                <li key={t.id} className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 ${inactive ? 'opacity-50' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {t.name} {t.read_only && <span className="ml-1 rounded bg-bg px-1.5 py-0.5 text-xs text-muted">solo lectura</span>}
                    </p>
                    <p className="text-xs text-muted">
                      <code>{t.prefix}…</code> · creado {fmt(t.created_at)} · último uso {fmt(t.last_used_at)} ·{' '}
                      {t.revoked_at ? `revocado ${fmt(t.revoked_at)}` : expired ? 'vencido' : t.expires_at ? `vence ${fmt(t.expires_at)}` : 'no vence'}
                    </p>
                  </div>
                  {!inactive && (
                    <form action={revokeTokenAction}>
                      <input type="hidden" name="id" value={t.id} />
                      <button className="rounded-lg border border-line px-3 py-1.5 text-sm text-danger">Revocar</button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
