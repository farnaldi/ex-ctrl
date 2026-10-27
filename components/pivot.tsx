import Link from 'next/link';
import { compact, money, monthLabel, monthsBetween } from '@/lib/format';
import { ShareBar, qs, type Params } from './ui';

export interface PivotRow {
  key: string;
  label: React.ReactNode;
  indent?: boolean;
  /** month -> amount */
  months: Record<string, number>;
  total: number;
  /** extra query params for the drill-down link to /movimientos */
  link?: Record<string, string>;
  note?: React.ReactNode;
}

/** Group × month table for one currency, with totals and a share bar. Wide: scrolls sideways on small screens. */
export function Pivot({
  rows, from, to, currency, params, shareOf, footer,
}: {
  rows: PivotRow[];
  from: string;
  to: string;
  currency: string;
  params: Params;
  /** total used for the % column (e.g. all spending in the period) */
  shareOf: number;
  footer?: { label: string; months: Record<string, number>; total: number };
}) {
  const months = monthsBetween(from, to);
  const max = Math.max(1, ...rows.map((r) => r.total));
  const cell = (v: number | undefined) => (v ? compact(v, currency) : <span className="text-line">·</span>);
  const drill = (r: PivotRow, m?: string) =>
    r.link ? `/movimientos${qs({ moneda: params.moneda }, { ...r.link, desde: m ?? from, hasta: m ?? to, gasto: '1' })}` : undefined;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-line text-xs text-muted">
          <tr>
            <th className="sticky left-0 bg-surface px-4 py-2 text-left font-normal">&nbsp;</th>
            <th className="min-w-28 px-3 py-2 text-right font-normal">Total</th>
            <th className="w-12 px-2 py-2 text-right font-normal">%</th>
            {months.map((m) => <th key={m} className="px-2 py-2 text-right font-normal">{monthLabel(m, { year: false })}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => {
            const href = drill(r);
            return (
              <tr key={r.key} className="hover:bg-bg">
                <td className={`sticky left-0 min-w-44 max-w-64 bg-surface px-4 py-2 ${r.indent ? 'pl-8' : ''}`}>
                  {href ? <Link href={href} className="hover:underline">{r.label}</Link> : r.label}
                  {r.note && <div className="text-xs text-muted">{r.note}</div>}
                  <div className="mt-1 hidden sm:block"><ShareBar value={r.total} max={max} /></div>
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">{money(r.total, currency)}</td>
                <td className="px-2 py-2 text-right text-xs text-muted tabular-nums">{shareOf ? Math.round((r.total / shareOf) * 100) : 0}%</td>
                {months.map((m) => {
                  const h = r.months[m] ? drill(r, m) : undefined;
                  return (
                    <td key={m} className="whitespace-nowrap px-2 py-2 text-right text-muted tabular-nums">
                      {h ? <Link href={h} className="hover:text-ink hover:underline">{cell(r.months[m])}</Link> : cell(r.months[m])}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
        {footer && (
          <tfoot className="border-t border-line font-medium">
            <tr>
              <td className="sticky left-0 bg-surface px-4 py-2">{footer.label}</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(footer.total, currency)}</td>
              <td />
              {months.map((m) => <td key={m} className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{cell(footer.months[m])}</td>)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Month range picker (GET form). Keeps the currency. */
export function PeriodForm({ from, to, params, path }: { from: string; to: string; params: Params; path: string }) {
  return (
    <form method="get" action={path} className="flex flex-wrap items-end gap-2 text-sm">
      {typeof params.moneda === 'string' && <input type="hidden" name="moneda" value={params.moneda} />}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">Desde</span>
        <input type="month" name="desde" defaultValue={from} className="field" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">Hasta</span>
        <input type="month" name="hasta" defaultValue={to} className="field" />
      </label>
      <button className="rounded-lg border border-line bg-surface px-3 py-1.5">Ver</button>
    </form>
  );
}
