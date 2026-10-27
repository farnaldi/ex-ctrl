/** Display helpers for the web app (es-UY). Amounts never mix currencies: every helper takes one. */

export type Currency = 'UYU' | 'USD';

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];
const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];

/** 1234.5 -> "$ 1.235" (UYU) / "US$ 1.234,50" (USD). decimals defaults to 0 for UYU and 2 for USD. */
export function money(n: number | string | null | undefined, currency: string, opts: { decimals?: number; sign?: boolean } = {}) {
  const v = Number(n ?? 0);
  const decimals = opts.decimals ?? (currency === 'USD' ? 2 : 0);
  const s = Math.abs(v).toLocaleString('es-UY', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const sym = currency === 'USD' ? 'US$' : '$';
  const neg = v < 0 ? '−' : opts.sign && v > 0 ? '+' : '';
  return `${neg}${sym} ${s}`;
}

/** Compact amount for charts and tiles: 184.769 -> "185k". */
export function compact(n: number | string | null | undefined, currency: string) {
  const v = Number(n ?? 0);
  const sym = currency === 'USD' ? 'US$' : '$';
  const a = Math.abs(v);
  const s = a >= 1_000_000 ? `${(a / 1_000_000).toLocaleString('es-UY', { maximumFractionDigits: 2 })}M` : a >= 10_000 ? `${Math.round(a / 1000)}k` : a.toLocaleString('es-UY', { maximumFractionDigits: 0 });
  return `${v < 0 ? '−' : ''}${sym} ${s}`;
}

/** "2026-09" -> "set 2026" (or "setiembre 2026" with long). */
export function monthLabel(m: string | null | undefined, opts: { long?: boolean; year?: boolean } = {}) {
  if (!m) return '—';
  const [y, mm] = m.slice(0, 7).split('-').map(Number);
  const name = (opts.long ? MONTHS_LONG : MONTHS)[mm - 1];
  return opts.year === false ? name : `${name} ${y}`;
}

/** "2026-09-08" -> "8 set". */
export function dayLabel(d: string | Date | null | undefined, opts: { year?: boolean } = {}) {
  if (!d) return '—';
  const s = typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
  const [y, m, day] = s.split('-').map(Number);
  return `${day} ${MONTHS[m - 1]}${opts.year ? ` ${y}` : ''}`;
}

export function dateTime(d: string | Date) {
  return new Date(d).toLocaleString('es-UY', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Montevideo',
  });
}

/** "2026-09" + n months. */
export function addMonths(m: string, n: number) {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mm - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function monthsBetween(from: string, to: string) {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

export const isMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const currencyParam = (s: unknown): Currency => (s === 'USD' ? 'USD' : 'UYU');

export const NATURE_LABEL: Record<string, string> = {
  fixed: 'Fijo', variable: 'Variable', income: 'Ingreso', savings: 'Ahorro', excluded: 'Excluido',
};

export const KIND_LABEL: Record<string, string> = {
  purchase: 'Compra', refund: 'Devolución', fee: 'Comisión', interest: 'Interés', tax: 'Impuesto', loan_payment: 'Cuota de préstamo',
  cash_withdrawal: 'Retiro', card_payment: 'Pago de tarjeta', transfer: 'Transferencia', income: 'Ingreso', fx: 'Cambio de moneda',
};

export const COMMITMENT_KIND_LABEL: Record<string, string> = {
  fixed: 'Gastos fijos', annual: 'Anuales y por temporada', installment_plan: 'Compras en cuotas', loan: 'Préstamos', subscription: 'Suscripciones',
};

export const ACTOR_LABEL: Record<string, string> = { user: 'Vos', claude: 'Agente', rule: 'Regla' };
