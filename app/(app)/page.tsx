import Link from 'next/link';
import { Card, CurrencyTabs, Empty, MonthBars, PageTitle, ShareBar, Stat, qs, type Params } from '@/components/ui';
import { mcpResource } from '@/lib/auth';
import { addMonths, compact, currencyParam, money, monthLabel } from '@/lib/format';
import { requireWebCtx } from '@/lib/session';
import { dataRange, forecastVsActual, reviewQueue, spendSummary } from '@/src/core/finance';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const { ctx } = await requireWebCtx();
  const currency = currencyParam(params.moneda);
  const range = await dataRange(ctx);

  if (!range.last) {
    return (
      <>
        <PageTitle title="Resumen" />
        <Card><Empty>Todavía no hay movimientos importados.</Empty></Card>
        <ConnectAgent />
      </>
    );
  }

  const year = range.last.slice(0, 4);
  const from = range.first && range.first > `${year}-01` ? range.first : `${year}-01`;
  const ahead = addMonths(range.last, 3);
  const [series, cats, queue] = await Promise.all([
    forecastVsActual(ctx, { from, to: ahead }),
    spendSummary(ctx, { group_by: 'category', from, to: range.last, currency }),
    reviewQueue(ctx),
  ]);

  const rows = series.filter((r) => r.currency === currency);
  const past = rows.filter((r) => r.month <= range.last!);
  const next = rows.find((r) => r.month === addMonths(range.last!, 1));
  const ytd = past.reduce((s, r) => s + Number(r.actual ?? 0), 0);
  const avg = past.length ? ytd / past.length : 0;
  const last = past.at(-1);
  const oneOffYtd = past.reduce((s, r) => s + Number(r.one_off ?? 0), 0);
  const topCats = cats.rows.slice(0, 8);
  const catMax = Math.max(1, ...topCats.map((c) => Number(c.amount)));
  const pending = queue.transactions.length;

  return (
    <>
      <PageTitle title="Resumen" subtitle={`Datos importados de ${monthLabel(range.first)} a ${monthLabel(range.last)}`}>
        <CurrencyTabs current={currency} path="/" params={params} />
      </PageTitle>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={`Gasto ${monthLabel(from, { year: false })}–${monthLabel(range.last)}`} value={money(ytd, currency)}
              hint={oneOffYtd ? `${compact(oneOffYtd, currency)} fueron gastos puntuales` : undefined} />
        <Stat label="Promedio mensual" value={money(avg, currency)} hint={`${past.length} meses`} />
        <Stat label={`Gasto de ${monthLabel(range.last, { long: true, year: false })}`} value={money(last?.actual, currency)}
              hint={last?.expected != null ? `pronóstico ${compact(last.expected, currency)} (${compact(last.low, currency)}–${compact(last.high, currency)})` : undefined} />
        <Stat label={`Pronóstico ${monthLabel(next?.month, { long: true, year: false })}`} value={money(next?.expected, currency)}
              hint={next ? `entre ${compact(next.low, currency)} y ${compact(next.high, currency)}` : undefined} />
      </div>

      <Card className="mt-6" title="Gasto por mes" action={<Link href={`/pronostico${qs(params)}`} className="text-accent hover:underline">Pronóstico vs real</Link>}>
        <MonthBars
          currency={currency}
          rows={rows.map((r) => ({
            month: r.month,
            value: r.month <= range.last! ? Number(r.actual ?? 0) : 0,
            oneOff: r.month <= range.last! ? Number(r.one_off ?? 0) : 0,
            low: Number(r.low), expected: Number(r.expected), high: Number(r.high),
          }))}
          hrefFor={(m) => (m <= range.last! ? `/movimientos${qs(params, { desde: m, hasta: m, gasto: '1' })}` : `/pronostico${qs(params, { mes: m })}`)}
        />
        <p className="px-4 pb-3 text-xs text-muted">
          Barra: gasto real (la parte clara son gastos puntuales, que el pronóstico no intenta predecir). Franja: rango pronosticado con los 3 meses anteriores; línea punteada: valor esperado. Los últimos meses son solo pronóstico. Montos en {currency === 'USD' ? 'dólares' : 'pesos'}.
        </p>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Dónde se va la plata" action={<Link href={`/categorias${qs(params)}`} className="text-accent hover:underline">Todas</Link>}>
          {topCats.length === 0 ? <Empty>Sin gastos en {currency === 'USD' ? 'dólares' : 'pesos'}.</Empty> : (
            <ul className="divide-y divide-line">
              {topCats.map((c) => (
                <li key={c.group}>
                  <Link href={`/movimientos${qs(params, { categoria: c.group, desde: from, hasta: range.last, gasto: '1' })}`} className="block px-4 py-2.5 hover:bg-bg">
                    <div className="flex items-baseline gap-3 text-sm">
                      <span className="min-w-0 flex-1 truncate">{c.group}</span>
                      <span className="tabular-nums">{money(c.amount, currency)}</span>
                      <span className="w-10 text-right text-xs text-muted tabular-nums">{Math.round((Number(c.amount) / ytd) * 100)}%</span>
                    </div>
                    <div className="mt-1.5"><ShareBar value={Number(c.amount)} max={catMax} /></div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-6">
          <Card title="Pendiente de revisar">
            <div className="space-y-2 px-4 py-3 text-sm">
              {pending === 0 && queue.missed_commitments.length === 0 && <p className="text-muted">Nada pendiente.</p>}
              {pending > 0 && (
                <p>
                  <Link href={`/movimientos${qs({}, { revisar: '1', moneda: 'todas' })}`} className="text-accent hover:underline">
                    {pending} movimiento{pending === 1 ? '' : 's'} sin categoría o marcado{pending === 1 ? '' : 's'} para revisar
                  </Link>{' '}
                  <span className="text-muted">(en las dos monedas)</span>
                </p>
              )}
              {queue.missed_commitments.length > 0 && (
                <div>
                  <p>Compromisos sin pago en los últimos meses:</p>
                  <ul className="mt-1 text-muted">
                    {queue.missed_commitments.slice(0, 6).map((g) => (
                      <li key={`${g.commitment_id}-${g.month}`}>{g.description} · {monthLabel(g.month)}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="pt-1 text-xs text-muted">Para responder, preguntale al agente; la edición en la web llega en la fase 4.</p>
            </div>
          </Card>
          <ConnectAgent />
        </div>
      </div>
    </>
  );
}

function ConnectAgent() {
  return (
    <Card title="Conectar un agente" action={<Link href="/tokens" className="text-accent hover:underline">Agentes y tokens</Link>}>
      <div className="px-4 py-3">
        <p className="text-sm text-muted">Cualquier cliente MCP con OAuth (Claude, ChatGPT…): agregá un conector remoto con esta URL.</p>
        <code className="mt-2 block overflow-x-auto rounded-lg bg-bg px-3 py-2 text-sm">{mcpResource}</code>
      </div>
    </Card>
  );
}
