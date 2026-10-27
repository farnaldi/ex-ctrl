import Link from 'next/link';
import { Card, Empty, PageTitle, Pill, qs, type Params } from '@/components/ui';
import { dateTime } from '@/lib/format';
import { requireWebCtx } from '@/lib/session';
import { listOperations } from '@/src/core/finance';

export const dynamic = 'force-dynamic';

const TABLE: Record<string, string> = {
  transactions: 'movimientos', transaction_tags: 'tags de movimientos', commitments: 'compromisos', commitment_tags: 'tags de compromisos',
  merchant_rules: 'reglas', merchants: 'comercios', merchant_tags: 'tags de comercios', categories: 'categorías', tags: 'tags',
  context_notes: 'notas', accounts: 'cuentas', import_batches: 'importaciones', monthly_reviews: 'revisiones', forecast_snapshots: 'pronósticos guardados',
};

export default async function Historial({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const { ctx } = await requireWebCtx();
  const actor = params.quien === 'user' || params.quien === 'claude' ? params.quien : undefined;
  const ops = await listOperations(ctx, { limit: 200, actor });

  return (
    <>
      <PageTitle title="Historial" subtitle="Cada cambio hecho desde la web o por un agente, con lo que había antes y después.">
        <div role="tablist" className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-sm">
          {([[undefined, 'Todos'], ['user', 'Vos'], ['claude', 'Agentes']] as const).map(([k, label]) => (
            <Link key={label} role="tab" aria-selected={actor === k} href={`/historial${qs(params, { quien: k })}`}
                  className={`rounded-md px-3 py-1 ${actor === k ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'}`}>
              {label}
            </Link>
          ))}
        </div>
      </PageTitle>

      <Card>
        {ops.length === 0 ? <Empty>Todavía no hay cambios registrados.</Empty> : (
          <ul className="divide-y divide-line text-sm">
            {ops.map((o) => (
              <li key={o.op_id}>
                <Link href={`/historial/${o.op_id}`} className={`flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 hover:bg-bg ${o.undone ? 'opacity-60' : ''}`}>
                  <span className="w-40 shrink-0 text-xs text-muted">{dateTime(o.at)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{o.operation ?? 'cambio'}</span>
                    <span className="ml-2 text-xs text-muted">
                      {o.rows_changed} fila{o.rows_changed === 1 ? '' : 's'} · {(o.tables ?? []).map((t: string) => TABLE[t] ?? t).join(', ')}
                    </span>
                  </span>
                  <span className="flex gap-1">
                    <Pill tone={o.actor === 'claude' ? 'accent' : 'muted'}>{o.actor === 'claude' ? (o.agent || 'agente') : 'vos'}</Pill>
                    {o.undone && <Pill>deshecho</Pill>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="mt-3 text-xs text-muted">
        Las importaciones de extractos y el archivo de conocimiento aplicado por consola no pasan por acá. Para deshacer un cambio, pedíselo al
        agente con el id de la operación (deshacer desde la web llega en la fase 4).
      </p>
    </>
  );
}
