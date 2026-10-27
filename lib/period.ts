import { isMonth } from './format';

/** Period from ?desde/?hasta, defaulting to the year of the latest imported month (January → latest month). */
export function resolvePeriod(params: Record<string, string | string[] | undefined>, range: { first: string | null; last: string | null }) {
  const last = range.last ?? new Date().toISOString().slice(0, 7);
  const yearStart = `${last.slice(0, 4)}-01`;
  const defFrom = range.first && range.first > yearStart ? range.first : yearStart;
  let from = isMonth(params.desde) ? params.desde : defFrom;
  let to = isMonth(params.hasta) ? params.hasta : last;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}
