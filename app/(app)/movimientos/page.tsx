import Link from 'next/link';
import { Amount, Card, CurrencyTabs, Empty, PageTitle, Pill, one, qs, type Params } from '@/components/ui';
import { KIND_LABEL, dayLabel, isMonth, money, monthLabel } from '@/lib/format';
import { requireWebCtx } from '@/lib/session';
import { listAccounts, listCategories, listTags, listTransactions } from '@/src/core/finance';

export const dynamic = 'force-dynamic';

const PAGE = 100;

export default async function Movimientos({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const { ctx } = await requireWebCtx();
  const p = (k: string) => one(params[k]) ?? '';
  const moneda = p('moneda') === 'USD' ? 'USD' : p('moneda') === 'todas' ? 'todas' : 'UYU';
  const page = Math.max(1, Math.trunc(Number(p('page')) || 1));
  const cuenta = Number(p('cuenta')) || undefined;

  const [result, accounts, categories, tags] = await Promise.all([
    listTransactions(ctx, {
      from: isMonth(p('desde')) ? p('desde') : undefined,
      to: isMonth(p('hasta')) ? p('hasta') : undefined,
      currency: moneda === 'todas' ? undefined : moneda,
      account_id: cuenta,
      category: p('categoria') || undefined,
      tag: p('tag') || undefined,
      merchant: p('comercio') || undefined,
      text: p('q').trim() || undefined,
      spending_only: p('gasto') === '1' || undefined,
      pending: p('revisar') === '1' || undefined,
      one_off: p('puntual') === '1' ? true : undefined,
      sort: (['date_desc', 'date_asc', 'amount_desc', 'amount_asc'] as const).find((s) => s === p('orden')) ?? 'date_desc',
      limit: PAGE,
      offset: (page - 1) * PAGE,
    }),
    listAccounts(ctx),
    listCategories(ctx),
    listTags(ctx),
  ]);

  const pages = Math.max(1, Math.ceil(result.count / PAGE));
  const filtered = ['desde', 'hasta', 'cuenta', 'categoria', 'tag', 'comercio', 'q', 'gasto', 'revisar', 'puntual'].some((k) => p(k));

  return (
    <>
      <PageTitle title="Movimientos" subtitle={`${result.count.toLocaleString('es-UY')} movimiento${result.count === 1 ? '' : 's'}`}>
        <CurrencyTabs current={moneda} path="/movimientos" params={params} allowAll />
      </PageTitle>

      <form method="get" className="mb-4 grid grid-cols-2 gap-2 rounded-xl border border-line bg-surface p-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
        {moneda !== 'UYU' && <input type="hidden" name="moneda" value={moneda} />}
        <label className="col-span-2 flex flex-col gap-1 sm:col-span-3 lg:col-span-2">
          <span className="text-xs text-muted">Buscar</span>
          <input name="q" defaultValue={p('q')} placeholder="Descripción, comercio o nota" className="field" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Desde</span>
          <input type="month" name="desde" defaultValue={p('desde')} className="field" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Hasta</span>
          <input type="month" name="hasta" defaultValue={p('hasta')} className="field" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Cuenta</span>
          <select name="cuenta" defaultValue={p('cuenta')} className="field">
            <option value="">Todas</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Categoría</span>
          <select name="categoria" defaultValue={p('categoria')} className="field">
            <option value="">Todas</option>
            {categories.filter((c) => c.transactions > 0).map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Tag</span>
          <select name="tag" defaultValue={p('tag')} className="field">
            <option value="">Todos</option>
            {tags.filter((t) => !t.archived).map((t) => <option key={t.id} value={t.name}>{t.parent ? `${t.parent} › ${t.name}` : t.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Orden</span>
          <select name="orden" defaultValue={p('orden')} className="field">
            <option value="">Más recientes</option>
            <option value="date_asc">Más antiguos</option>
            <option value="amount_desc">Monto mayor</option>
            <option value="amount_asc">Monto menor</option>
          </select>
        </label>
        <div className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-2 sm:col-span-3 lg:col-span-4">
          <Check name="gasto" label="Solo gasto" on={p('gasto') === '1'} />
          <Check name="revisar" label="Pendientes de revisar" on={p('revisar') === '1'} />
          <Check name="puntual" label="Solo puntuales" on={p('puntual') === '1'} />
          {p('comercio') && <input type="hidden" name="comercio" value={p('comercio')} />}
        </div>
        <div className="col-span-2 flex items-center gap-2 sm:col-span-3 lg:col-span-1 lg:col-start-6 lg:justify-end">
          {filtered && <Link href={`/movimientos${qs({}, { moneda: moneda === 'UYU' ? undefined : moneda })}`} className="text-muted hover:text-ink">Limpiar</Link>}
          <button className="rounded-lg bg-accent px-4 py-1.5 font-medium text-accent-ink">Filtrar</button>
        </div>
      </form>

      {p('comercio') && <p className="mb-3 text-sm text-muted">Comercio: <span className="text-ink">{p('comercio')}</span></p>}

      {result.totals.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {result.totals.map((t) => (
            <p key={t.currency}>
              <span className="text-muted">{t.currency === 'USD' ? 'Dólares' : 'Pesos'}:</span>{' '}
              gasto <span className="font-medium tabular-nums">{money(t.spending, t.currency)}</span>
              <span className="text-muted"> · neto {money(t.net, t.currency)} · {t.count} mov.</span>
            </p>
          ))}
        </div>
      )}

      <Card>
        {result.transactions.length === 0 ? (
          <Empty>No hay movimientos con estos filtros.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-normal">Fecha</th>
                  <th className="px-2 py-2 font-normal">Movimiento</th>
                  <th className="hidden px-2 py-2 font-normal md:table-cell">Categoría</th>
                  <th className="hidden px-2 py-2 font-normal lg:table-cell">Cuenta</th>
                  <th className="px-4 py-2 text-right font-normal">Monto</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.transactions.map((t) => (
                  <tr key={t.id} className={`align-top hover:bg-bg ${t.is_spending ? '' : 'text-muted'}`}>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                      {dayLabel(t.posted_on)}
                      {t.month !== String(t.posted_on).slice(0, 7) && <div className="text-[11px]">mes {monthLabel(t.month, { year: false })}</div>}
                    </td>
                    <td className="min-w-0 px-2 py-2.5">
                      <Link href={`/movimientos/${t.id}`} className="block hover:underline">
                        <span className={t.is_spending ? 'font-medium text-ink' : ''}>{t.merchant ?? t.description}</span>
                      </Link>
                      {t.merchant && <div className="max-w-md truncate text-xs text-muted">{t.description}</div>}
                      <div className="mt-1 flex flex-wrap gap-1">
                        <span className="md:hidden">{t.category ? <Pill>{t.category}</Pill> : null}</span>
                        {t.tags.map((g: string) => <Pill key={g}>#{g}</Pill>)}
                        {!t.is_spending && t.kind && <Pill>{KIND_LABEL[t.kind] ?? t.kind}</Pill>}
                        {t.one_off && <Pill tone="accent">puntual</Pill>}
                        {t.installment_total && <Pill>cuota {t.installment_number}/{t.installment_total}</Pill>}
                        {(t.review_reason || (!t.category && t.is_spending)) && <Pill tone="danger">revisar</Pill>}
                      </div>
                    </td>
                    <td className="hidden px-2 py-2.5 md:table-cell">{t.category ?? <span className="text-muted">—</span>}</td>
                    <td className="hidden max-w-48 truncate px-2 py-2.5 text-muted lg:table-cell">{t.account}</td>
                    <td className="px-4 py-2.5 text-right"><Amount value={t.amount} currency={t.currency} decimals={2} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {pages > 1 && (
        <nav className="mt-4 flex items-center justify-center gap-4 text-sm">
          {page > 1 ? <Link href={`/movimientos${qs(params, { page: page - 1 })}`} className="text-accent hover:underline">← Anteriores</Link> : <span />}
          <span className="text-muted">Página {page} de {pages}</span>
          {page < pages ? <Link href={`/movimientos${qs(params, { page: page + 1 })}`} className="text-accent hover:underline">Siguientes →</Link> : <span />}
        </nav>
      )}
    </>
  );
}

function Check({ name, label, on }: { name: string; label: string; on: boolean }) {
  return (
    <label className="inline-flex items-center gap-2">
      <input type="checkbox" name={name} value="1" defaultChecked={on} className="accent-[var(--accent)]" />
      {label}
    </label>
  );
}
