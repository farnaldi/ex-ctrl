import { Card, CurrencyTabs, Empty, PageTitle, Stat, type Params } from '@/components/ui';
import { Pivot, PeriodForm, type PivotRow } from '@/components/pivot';
import { NATURE_LABEL, currencyParam, money, monthLabel } from '@/lib/format';
import { resolvePeriod } from '@/lib/period';
import { requireWebCtx } from '@/lib/session';
import { dataRange, spendSummary } from '@/src/core/finance';

export const dynamic = 'force-dynamic';

export default async function Categorias({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const { ctx } = await requireWebCtx();
  const currency = currencyParam(params.moneda);
  const { from, to } = resolvePeriod(params, await dataRange(ctx));

  const [byCat, byNature] = await Promise.all([
    spendSummary(ctx, { group_by: 'category', by_month: true, from, to, currency }),
    spendSummary(ctx, { group_by: 'nature', by_month: true, from, to, currency }),
  ]);

  const pivot = (rows: { group: string; month: string; amount: number }[]) => {
    const map = new Map<string, PivotRow>();
    for (const r of rows) {
      const row = map.get(r.group) ?? { key: r.group, label: r.group, months: {}, total: 0 };
      row.months[r.month] = (row.months[r.month] ?? 0) + Number(r.amount);
      row.total += Number(r.amount);
      map.set(r.group, row);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  };

  const cats: PivotRow[] = pivot(byCat.rows).map((r) => ({ ...r, link: r.key === '(sin categoría)' ? { revisar: '1' } as Record<string, string> : { categoria: r.key } }));
  const natures = pivot(byNature.rows).map((r) => ({ ...r, label: NATURE_LABEL[r.key] ?? r.key }));
  const total = Number(byCat.totals[0]?.amount ?? 0);
  const footerMonths: Record<string, number> = {};
  for (const r of cats) for (const [m, v] of Object.entries(r.months)) footerMonths[m] = (footerMonths[m] ?? 0) + v;
  const nMonths = Object.keys(footerMonths).length || 1;

  return (
    <>
      <PageTitle title="Categorías" subtitle={`Gasto de ${monthLabel(from)} a ${monthLabel(to)}. Qué fue la plata; los tags dicen para qué.`}>
        <PeriodForm from={from} to={to} params={params} path="/categorias" />
        <CurrencyTabs current={currency} path="/categorias" params={params} />
      </PageTitle>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Gasto del período" value={money(total, currency)} />
        <Stat label="Promedio mensual" value={money(total / nMonths, currency)} hint={`${nMonths} meses con gasto`} />
        {natures.slice(0, 2).map((n) => (
          <Stat key={n.key} label={`Gasto ${String(n.label).toLowerCase()}`} value={money(n.total, currency)}
                hint={`${total ? Math.round((n.total / total) * 100) : 0}% del total`} />
        ))}
      </div>

      <Card title="Por categoría">
        {cats.length === 0 ? <Empty>Sin gastos en el período.</Empty> : (
          <Pivot rows={cats} from={from} to={to} currency={currency} params={params} shareOf={total}
                 footer={{ label: 'Total', months: footerMonths, total }} />
        )}
      </Card>

      <Card className="mt-6" title="Fijo y variable">
        <Pivot rows={natures} from={from} to={to} currency={currency} params={params} shareOf={total} />
        <p className="px-4 py-3 text-xs text-muted">
          Fijo: la naturaleza de la categoría (alquiler, servicios, cuotas). Transferencias, cambio de moneda, ingresos, inversiones y
          fondos de terceros no cuentan como gasto.
        </p>
      </Card>
    </>
  );
}
