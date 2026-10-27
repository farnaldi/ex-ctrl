import { listConnectedAgents, mcpResource } from '@/lib/auth';
import { requireWebCtx } from '@/lib/session';
import { listApiTokens } from '@/src/core/tokens';
import { disconnectAgentAction, revokeTokenAction } from './actions';
import { CreateTokenForm } from './create-form';

export const dynamic = 'force-dynamic';

const fmt = (d: Date | null) => (d ? new Date(d).toLocaleDateString('es-UY', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export default async function TokensPage() {
  const { ctx } = await requireWebCtx();
  const [tokens, agents] = await Promise.all([listApiTokens(ctx), listConnectedAgents(ctx.userId)]);
  const now = Date.now();

  return (
    <main className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Acceso de agentes</h1>

      <h2 className="mt-8 font-medium">Agentes conectados</h2>
      <p className="mt-1 text-sm text-muted">Los que autorizaste con OAuth (Claude, ChatGPT…). Desconectar corta su acceso en menos de un minuto.</p>
      {agents.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Ninguno.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
          {agents.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{a.name ?? 'Aplicación sin nombre'}</p>
                <p className="text-xs text-muted">conectado {fmt(a.created_at)} · última renovación {fmt(a.last_used)}</p>
              </div>
              <form action={disconnectAgentAction}>
                <input type="hidden" name="id" value={a.id} />
                <button className="rounded-lg border border-line px-3 py-1.5 text-sm text-danger">Desconectar</button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-10 font-medium">Tokens de acceso</h2>
      <p className="mt-1 text-sm text-muted">
        Para agentes que no se conectan con OAuth (scripts, n8n, agentes propios). Se usan contra{' '}
        <code className="rounded bg-surface px-1">{mcpResource}</code> con el header{' '}
        <code className="rounded bg-surface px-1">Authorization: Bearer fin_…</code>. Lo que hagan queda en el historial con el
        nombre del token.
      </p>

      <section className="mt-4 rounded-xl border border-line bg-surface p-5">
        <CreateTokenForm />
      </section>

      <section className="mt-4">
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
