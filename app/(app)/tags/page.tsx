import { Card, CurrencyTabs, Empty, PageTitle, type Params } from '@/components/ui';
import { Pivot, PeriodForm, type PivotRow } from '@/components/pivot';
import { currencyParam, monthLabel } from '@/lib/format';
import { resolvePeriod } from '@/lib/period';
import { requireWebCtx } from '@/lib/session';
import { dataRange, listTags, spendSummary } from '@/src/core/finance';

export const dynamic = 'force-dynamic';

export default async function Tags({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const { ctx } = await requireWebCtx();
  const currency = currencyParam(params.moneda);
  const { from, to } = resolvePeriod(params, await dataRange(ctx));

  const [summary, tags] = await Promise.all([
    spendSummary(ctx, { group_by: 'tag', by_month: true, from, to, currency }),
    listTags(ctx),
  ]);

  const byTag = new Map<string, PivotRow>();
  for (const r of summary.rows as { group: string; month: string; amount: number }[]) {
    const row: PivotRow = byTag.get(r.group) ?? { key: r.group, label: r.group, months: {}, total: 0 };
    row.months[r.month] = (row.months[r.month] ?? 0) + Number(r.amount);
    row.total += Number(r.amount);
    byTag.set(r.group, row);
  }
  const total = Number(summary.totals[0]?.amount ?? 0);

  // parents first (by amount), each followed by its children
  const parentOf = new Map(tags.map((t) => [t.name, t.parent as string | null]));
  const roots = [...byTag.values()].filter((r) => !parentOf.get(r.key)).sort((a, b) => {
    if (a.key === '(sin tag)') return 1;
    if (b.key === '(sin tag)') return -1;
    return b.total - a.total;
  });
  const rows: PivotRow[] = [];
  for (const r of roots) {
    const isNone = r.key === '(sin tag)';
    rows.push({ ...r, label: isNone ? 'Sin tag' : `#${r.key}`, link: isNone ? undefined : { tag: r.key } });
    const kids = [...byTag.values()].filter((k) => parentOf.get(k.key) === r.key).sort((a, b) => b.total - a.total);
    for (const k of kids) rows.push({ ...k, label: `#${k.key}`, indent: true, link: { tag: k.key } });
  }
  const notes = new Map(tags.map((t) => [t.name, t.notes as string | null]));
  for (const r of rows) if (notes.get(r.key)) r.note = notes.get(r.key);

  return (
    <>
      <PageTitle title="Tags" subtitle={`Para qué fue el gasto, de ${monthLabel(from)} a ${monthLabel(to)}.`}>
        <PeriodForm from={from} to={to} params={params} path="/tags" />
        <CurrencyTabs current={currency} path="/tags" params={params} />
      </PageTitle>

      <Card>
        {rows.length === 0 ? <Empty>Sin gastos en el período.</Empty> : <Pivot rows={rows} from={from} to={to} currency={currency} params={params} shareOf={total} />}
        <p className="px-4 py-3 text-xs text-muted">
          Un tag incluye a sus hijos (#autos suma #nivus y #byd), y un movimiento puede tener varios tags: las filas se superponen y no
          suman el total. El porcentaje es sobre todo el gasto del período.
        </p>
      </Card>
    </>
  );
}
