import Link from 'next/link';
import { compact, money, monthLabel, type Currency } from '@/lib/format';

export type Params = Record<string, string | string[] | undefined>;

/** Query string from the current params with some keys changed (undefined/'' removes a key). */
export function qs(params: Params, changes: Record<string, string | number | undefined | null> = {}) {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && v !== '') out.set(k, v);
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined || v === null || v === '') out.delete(k);
    else out.set(k, String(v));
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

export function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

export function PageTitle({ title, subtitle, children }: { title: string; subtitle?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end gap-x-6 gap-y-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

/** UYU / USD switch: the two currencies are never added together, so every view shows one at a time.
 *  allowAll adds "Ambas" for lists (rows are shown side by side, totals stay per currency). */
export function CurrencyTabs({ current, path, params, allowAll }: { current: Currency | 'todas'; path: string; params: Params; allowAll?: boolean }) {
  const options = (allowAll ? ['UYU', 'USD', 'todas'] : ['UYU', 'USD']) as (Currency | 'todas')[];
  const label = { UYU: 'Pesos', USD: 'Dólares', todas: 'Ambas' };
  return (
    <div role="tablist" aria-label="Moneda" className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-sm">
      {options.map((c) => (
        <Link
          key={c}
          role="tab"
          aria-selected={c === current}
          href={`${path}${qs(params, { moneda: c === 'UYU' ? undefined : c, page: undefined })}`}
          className={`rounded-md px-3 py-1 ${c === current ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'}`}
        >
          {label[c]}
        </Link>
      ))}
    </div>
  );
}

export function Card({ title, action, children, className = '' }: { title?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-surface ${className}`}>
      {(title || action) && (
        <div className="flex items-baseline gap-3 border-b border-line px-4 py-3">
          {title && <h2 className="font-medium">{title}</h2>}
          {action && <div className="ml-auto text-sm">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Amount({ value, currency, className = '', decimals }: { value: number | string | null | undefined; currency: string; className?: string; decimals?: number }) {
  const v = Number(value ?? 0);
  return <span className={`whitespace-nowrap tabular-nums ${v < 0 ? 'text-accent' : ''} ${className}`}>{money(v, currency, { decimals })}</span>;
}

export function Pill({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'accent' | 'danger' }) {
  const c = tone === 'accent' ? 'text-accent' : tone === 'danger' ? 'text-danger' : 'text-muted';
  return <span className={`inline-block rounded-md border border-line px-1.5 py-0.5 text-xs ${c}`}>{children}</span>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted">{children}</p>;
}

/**
 * Monthly bars for one currency. Each bar can show a forecast range (low–high) and expected value behind it.
 * Pure CSS so it renders on the server with no chart library.
 */
export function MonthBars({
  rows,
  currency,
  hrefFor,
}: {
  /** value = total; oneOff = the part of it that was one-off spending (drawn lighter, on top) */
  rows: { month: string; value: number; oneOff?: number; low?: number | null; expected?: number | null; high?: number | null; muted?: boolean }[];
  currency: string;
  hrefFor?: (month: string) => string;
}) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.value, r.high ?? 0, r.expected ?? 0]));
  const pct = (v: number) => `${Math.max(0, (v / max) * 100)}%`;
  return (
    <div className="px-4 pb-3 pt-5">
      <div className="flex h-48 items-end gap-1.5 sm:gap-3">
        {rows.map((r) => {
          const bar = (
            <div className="relative flex h-full w-full items-end justify-center">
              {r.high != null && r.low != null && (
                <div
                  className="absolute inset-x-0 rounded-sm bg-accent/10 ring-1 ring-inset ring-accent/30"
                  style={{ bottom: pct(r.low), height: `calc(${pct(r.high)} - ${pct(r.low)})` }}
                  title={`Pronóstico ${money(r.low, currency)} – ${money(r.high, currency)}`}
                />
              )}
              <div
                className="relative flex w-3/5 max-w-10 flex-col"
                style={{ height: pct(r.value) }}
                title={`${monthLabel(r.month, { long: true })}: ${money(r.value, currency)}${r.oneOff ? ` (${money(r.oneOff, currency)} puntual)` : ''}`}
              >
                {r.oneOff ? <div className="rounded-t-sm bg-accent/35" style={{ height: `${Math.min(100, (r.oneOff / Math.max(r.value, 1)) * 100)}%` }} /> : null}
                <div className={`flex-1 ${r.oneOff ? '' : 'rounded-t-sm'} ${r.muted ? 'bg-line' : 'bg-accent'}`} />
              </div>
              {r.expected != null && (
                <div className="absolute inset-x-0 border-t-2 border-dashed border-ink/50" style={{ bottom: pct(r.expected) }} />
              )}
            </div>
          );
          return (
            <div key={r.month} className="flex h-full min-w-0 flex-1 flex-col items-center gap-1">
              <span className="whitespace-nowrap text-[10px] text-muted sm:text-xs">{r.value ? compact(r.value, currency).replace(/^(−?)(US\$|\$) /, '$1') : ''}</span>
              {hrefFor ? <Link href={hrefFor(r.month)} className="flex h-full w-full">{bar}</Link> : bar}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-1.5 sm:gap-3">
        {rows.map((r) => (
          <span key={r.month} className="min-w-0 flex-1 truncate text-center text-[10px] text-muted sm:text-xs">
            {monthLabel(r.month, { year: false })}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Horizontal share bar used in category/tag tables. */
export function ShareBar({ value, max }: { value: number; max: number }) {
  const w = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full rounded-full bg-line">
      <div className="h-full rounded-full bg-accent" style={{ width: `${w}%` }} />
    </div>
  );
}
