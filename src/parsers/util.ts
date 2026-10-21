import type { Grid } from './types.ts';

/** Cell as trimmed string. */
export const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim();

/**
 * Parse an amount that may be a number or a Spanish-formatted string:
 * "1.234,56", "-45.574,57", "$ 843,55", "U$S 20,95", "62,5%".
 * Returns 0 for empty cells. Throws on anything else, so format changes fail loudly.
 */
export function parseAmount(v: unknown): number {
  if (typeof v === 'number') return v;
  let s = str(v).replace(/U\$S|US\$|\$|%/g, '').replace(/\s/g, '');
  if (s === '') return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Unparseable amount: ${JSON.stringify(v)}`);
  return n;
}

/** "28/9/2026" or "28/09/2026" -> "2026-09-28". Throws on anything else. */
export function parseDate(v: unknown): string {
  const m = str(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new Error(`Unparseable date: ${JSON.stringify(v)}`);
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

export const isDate = (v: unknown): boolean => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(str(v));

export const monthOf = (isoDate: string): string => `${isoDate.slice(0, 7)}-01`;

/** Integer cents, to compare money without float drift. */
export const cents = (n: number): number => Math.round(n * 100);

export const round2 = (n: number): number => cents(n) / 100;

/** First row index whose cells include all the given labels (case/space-insensitive). */
export function findRow(grid: Grid, labels: string[], from = 0): number {
  const want = labels.map((l) => l.toLowerCase());
  for (let r = from; r < grid.length; r++) {
    const cells = grid[r].map((c) => str(c).toLowerCase());
    if (want.every((w) => cells.includes(w))) return r;
  }
  return -1;
}

/** Column index of a label within a row (case/space-insensitive), or -1. */
export const colOf = (row: (string | number)[], label: string): number =>
  row.findIndex((c) => str(c).toLowerCase() === label.toLowerCase());

/** "BUENAS MIGAS .LOCAL" -> "Buenas Migas Local". Keeps known acronyms (UTE, OSE, DGI...) upper-case. */
const ACRONYMS = new Set(['UTE', 'OSE', 'BPS', 'DGI', 'BSE', 'CJPPU', 'ANCAP', 'ANTEL', 'BROU', 'BHU', 'IM', 'USD', 'UYU']);
export function titleCase(s: string): string {
  return s
    .replace(/[.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

/** Drop trailing store numbers and ids: "Tata 327" -> "Tata", "Spotify P476082792" -> "Spotify". */
export const stripCodes = (s: string): string =>
  s.replace(/(\s+(\d+|\S*\d{5,}\S*|(?=\S*\d\S*\d\S*\d)[a-z0-9]{6,}))+$/i, '').trim();

export const last4 =(s: string): string => s.replace(/\D/g, '').slice(-4);
