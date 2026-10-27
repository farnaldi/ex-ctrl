import Link from 'next/link';
import { Card, CurrencyTabs, Empty, MonthBars, PageTitle, Pill, Stat, qs, type Params } from '@/components/ui';
import { addMonths, compact, currencyParam, isMonth, money, monthLabel } from '@/lib/format';
import { requireWebCtx } from '@/lib/session';
import { dataRange, forecast, forecastVsActual } from '@/src/core/finance';

export const dynamic = 'force-dynamic';

const COMPONENT: Record<string, { title: string; hint: string }> = {
  commitment: { title: 'Compromisos', hint: 'Gastos fijos, cuotas y préstamos que vencen ese mes, con su tolerancia.' },
  baseline: { title: 'Gasto variable', hint: 'Promedio de los 3 meses anteriores por categoría y tags, sin compromisos ni gastos puntuales.' },
  event: { title: 'Eventos planificados', hint: 'Gastos futuros que anotaste (viajes, compras grandes).' },
};

export default async function Pronostico({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const { ctx } = await requireWebCtx();
  const currency = currencyParam(params.moneda);
  const range = await dataRange(ctx);
  if (!range.last || !range.first) return (<><PageTitle title="Pronóstico" /><Card><Empty>Todavía no hay datos.</Empty></Card></>);

  const today = new Date().toISOString().slice(0, 7);
  const firstFuture = addMonths(range.last, 1) > today ? addMonths(range.last, 1) : today;
  const month = isMonth(params.mes) ? params.mes : firstFuture;
  const upcoming = Array.from({ length: 6 }, (_, i) => addMonths(firstFuture, i));

  const [fc, history] = await Promise.all([
    forecast(ctx, month),
    forecastVsActual(ctx, { from: range.first, to: addMonths(firstFuture, 5) }),
  ]);
  const tot = fc.totals.find((t) => t.currency === currency);
  const lines = fc.lines.filter((l) => l.currency === currency);
  const byTag = fc.by_tag.filter((t) => t.currency === currency);
  const series = history.filter((r) => r.currency === currency);
  const backtest = series.filter((r) => r.month > range.first! && r.month <= range.last!);
  const hits = backtest.filter((r) => inRange(r)).length;
  const isPast = month <= range.last;
  const actual = series.find((r) => r.month === month);

  return (
    <>
      <PageTitle title="Pronóstico" subtitle="Compromisos + gasto variable promedio + eventos planificados. Cada moneda por separado.">
        <CurrencyTabs current={currency} path="/pronostico" params={params} />
      </PageTitle>

      <div className="mb-4 flex flex-wrap gap-1 text-sm">
        {upcoming.map((m) => (
          <Link key={m} href={`/pronostico${qs(params, { mes: m === firstFuture ? undefined : m })}`}
                className={`rounded-lg px-3 py-1.5 ${m === month ? 'bg-accent text-accent-ink' : 'border border-line bg-surface text-muted hover:text-ink'}`}>
            {monthLabel(m)}
          </Link>
        ))}
        {isPast && <span className="rounded-lg bg-accent px-3 py-1.5 text-accent-ink">{monthLabel(month)}</span>}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={`Esperado ${monthLabel(month, { long: true })}`} value={money(tot?.expected, currency)}
              hint={tot ? `entre ${money(tot.low, currency)} y ${money(tot.high, currency)}` : undefined} />
        <Stat label="Compromisos" value={money(tot?.committed, currency)} />
        <Stat label="Gasto variable" value={money(tot?.variable, currency)} />
        {isPast && actual ? (
          <Stat label="Real" value={money(actual.actual, currency)} hint={inRange(actual) ? 'dentro del rango' : 'fuera del rango'} />
        ) : (
          <Stat label="Eventos planificados" value={money(tot?.events, currency)} />
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-6">
          {(['commitment', 'baseline', 'event'] as const).map((comp) => {
            const items = lines.filter((l) => l.component === comp);
            if (!items.length) return null;
            const sum = items.reduce((s, l) => s + Number(l.expected), 0);
            return (
              <Card key={comp} title={COMPONENT[comp].title} action={<span className="tabular-nums text-muted">{money(sum, currency)}</span>}>
                <p className="px-4 pt-2 text-xs text-muted">{COMPONENT[comp].hint}</p>
                <ul className="divide-y divide-line text-sm">
                  {items.map((l, i) => (
                    <li key={`${l.ref_id}-${i}`} className="flex items-start gap-3 px-4 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate">{l.label === '(uncategorized)' ? 'Sin categoría' : l.label}</p>
                        <p className="text-xs text-muted">{basis(l.basis)}</p>
                      </div>
                      <div className="text-right">
                        <p className="tabular-nums">{money(l.expected, currency)}</p>
                        {Number(l.low) !== Number(l.high) && (
                          <p className="text-xs text-muted tabular-nums">{compact(l.low, currency)}–{compact(l.high, currency)}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
          {lines.length === 0 && <Card><Empty>Sin pronóstico para este mes en {currency === 'USD' ? 'dólares' : 'pesos'}.</Empty></Card>}
        </div>

        <div className="space-y-6">
          <Card title="Por tag">
            {byTag.length === 0 ? <Empty>—</Empty> : (
              <ul className="divide-y divide-line text-sm">
                {byTag.map((t) => (
                  <li key={t.tag} className="flex gap-3 px-4 py-2">
                    <span className="flex-1">{t.tag === '(untagged)' || !t.tag ? 'Sin tag' : `#${t.tag}`}</span>
                    <span className="tabular-nums">{money(t.expected, currency)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="px-4 pb-3 text-xs text-muted">Los tags incluyen a sus hijos y se superponen.</p>
          </Card>
        </div>
      </div>

      <Card className="mt-6" title="Pronóstico vs real"
            action={backtest.length ? <span className="text-muted">{hits} de {backtest.length} meses dentro del rango</span> : undefined}>
        <MonthBars
          currency={currency}
          rows={series.map((r) => ({
            month: r.month,
            value: r.month <= range.last! ? Number(r.actual ?? 0) : 0,
            oneOff: r.month <= range.last! ? Number(r.one_off ?? 0) : 0,
            low: Number(r.low), expected: Number(r.expected), high: Number(r.high),
          }))}
          hrefFor={(m) => `/pronostico${qs(params, { mes: m })}`}
        />
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-normal">Mes</th>
                <th className="px-2 py-2 text-right font-normal">Pronóstico</th>
                <th className="hidden px-2 py-2 text-right font-normal sm:table-cell">Rango</th>
                <th className="px-2 py-2 text-right font-normal">Real</th>
                <th className="hidden px-2 py-2 text-right font-normal md:table-cell">Puntuales</th>
                <th className="px-2 py-2 text-right font-normal">Diferencia</th>
                <th className="px-4 py-2 font-normal" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {series.filter((r) => r.month > range.first!).map((r) => {
                const past = r.month <= range.last!;
                const regular = Number(r.actual ?? 0) - Number(r.one_off ?? 0);
                const diff = regular - Number(r.expected);
                return (
                  <tr key={r.month} className={past ? '' : 'text-muted'}>
                    <td className="px-4 py-2"><Link href={`/pronostico${qs(params, { mes: r.month })}`} className="hover:underline">{monthLabel(r.month)}</Link></td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(r.expected, currency)}</td>
                    <td className="hidden whitespace-nowrap px-2 py-2 text-right text-muted tabular-nums sm:table-cell">{compact(r.low, currency)}–{compact(r.high, currency)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{past ? money(r.actual, currency) : '—'}</td>
                    <td className="hidden px-2 py-2 text-right text-muted tabular-nums md:table-cell">{past && Number(r.one_off) ? money(r.one_off, currency) : ''}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {past ? <>{money(diff, currency, { sign: true })} <span className="text-xs text-muted">{Number(r.expected) ? `${Math.round((diff / Number(r.expected)) * 100)}%` : ''}</span></> : ''}
                    </td>
                    <td className="px-4 py-2">{past && (inRange(r) ? <Pill tone="accent">en rango</Pill> : <Pill tone="danger">fuera</Pill>)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-3 text-xs text-muted">
          El pronóstico de cada mes pasado se calcula solo con los meses anteriores a él, como si se hubiera hecho en ese momento.
          La diferencia compara el pronóstico con el gasto real sin los gastos puntuales; “en rango” mira el gasto sin puntuales.
          {` Los primeros meses tienen poca historia (${monthLabel(range.first)} no tiene meses anteriores).`}
        </p>
      </Card>
    </>
  );
}

function inRange(r: { actual: number | null; one_off: number | null; low: number; high: number }) {
  const regular = Number(r.actual ?? 0) - Number(r.one_off ?? 0);
  return regular >= Number(r.low) && regular <= Number(r.high);
}

function basis(b: string | null) {
  if (!b) return '';
  const m = /^(\d+)-month average, spent in (\d+) of (\d+) months$/.exec(b);
  if (m) return `promedio de ${m[1]} meses · hubo gasto en ${m[2]} de ${m[3]}`;
  const ip = /^(installment_plan|car loan|loan) (\d+)\/(\d+)$/.exec(b);
  if (ip) return `${ip[1] === 'installment_plan' ? 'cuota' : 'cuota del préstamo'} ${ip[2]} de ${ip[3]}`;
  if (b === 'fixed') return 'fijo';
  if (b === 'fixed · off-statement') return 'fijo · se paga fuera de las cuentas importadas';
  return b;
}
