import Link from 'next/link';
import { Amount, Card, CurrencyTabs, Empty, PageTitle, Pill, Stat, qs, type Params } from '@/components/ui';
import { COMMITMENT_KIND_LABEL, addMonths, currencyParam, money, monthLabel } from '@/lib/format';
import { requireWebCtx } from '@/lib/session';
import { commitmentGaps, listCommitments } from '@/src/core/finance';

export const dynamic = 'force-dynamic';

const ORDER = ['fixed', 'subscription', 'annual', 'loan', 'installment_plan'];

function every(n: number) {
  return n === 1 ? 'mensual' : n === 2 ? 'cada 2 meses' : n === 12 ? 'anual' : `cada ${n} meses`;
}

export default async function Compromisos({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const { ctx } = await requireWebCtx();
  const currency = currencyParam(params.moneda);
  const all = params.todos === '1';
  const [{ commitments, loans }, gaps] = await Promise.all([listCommitments(ctx, { status: all ? 'all' : 'active' }), commitmentGaps(ctx)]);

  const today = new Date().toISOString().slice(0, 7);
  const mine = commitments.filter((c) => c.currency === currency);
  // a finished plan (all cuotas paid / end date passed) is still "active" in the table until someone ends it: hide it unless asked
  const current = mine.filter((c) => all || (c.next_due_month != null || (c.start_date && c.start_date.slice(0, 7) > today)));
  const groups = ORDER.map((k) => ({ kind: k, items: current.filter((c) => c.kind === k) })).filter((g) => g.items.length);
  const monthly = current
    .filter((c) => c.status === 'active' && c.kind !== 'installment_plan' && c.every_n_months === 1 && (!c.end_date || c.end_date.slice(0, 7) >= today) && c.start_date.slice(0, 7) <= today)
    .reduce((s, c) => s + Number(c.expected_amount), 0);
  const recentGaps = gaps.filter((g) => g.month >= addMonths(today, -6) && mine.some((c) => c.id === g.commitment_id && !c.off_statement));
  const myLoans = loans.filter((l) => l.currency === currency);

  return (
    <>
      <PageTitle title="Compromisos" subtitle="Gastos fijos, compras en cuotas y préstamos. El pronóstico parte de acá.">
        <Link href={`/compromisos${qs(params, { todos: all ? undefined : '1' })}`} className="text-sm text-muted hover:text-ink">
          {all ? 'Ocultar terminados' : 'Ver también terminados'}
        </Link>
        <CurrencyTabs current={currency} path="/compromisos" params={params} />
      </PageTitle>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Fijos mensuales vigentes" value={money(monthly, currency)} hint="sin cuotas ni pagos bimestrales/anuales" />
        <Stat label="Compromisos activos" value={String(current.filter((c) => c.status === 'active').length)} />
        {myLoans.map((l) => (
          <Stat key={l.commitment_id} label={`Saldo ${l.description}`} value={money(l.balance_estimate, currency)}
                hint={`${l.payments_left} cuotas de ${money(l.monthly_payment, currency)}`} />
        ))}
      </div>

      {recentGaps.length > 0 && (
        <Card className="mb-6" title="Sin pago encontrado (últimos 6 meses)">
          <ul className="divide-y divide-line text-sm">
            {recentGaps.map((g) => (
              <li key={`${g.commitment_id}-${g.month}`} className="flex gap-3 px-4 py-2">
                <a href={`#c${g.commitment_id}`} className="flex-1 hover:underline">{g.description}</a>
                <span className="text-muted">{monthLabel(g.month)}</span>
              </li>
            ))}
          </ul>
          <p className="px-4 pb-3 text-xs text-muted">Puede estar pagado desde una cuenta que no se importa, o el monto quedó fuera de la tolerancia.</p>
        </Card>
      )}

      {myLoans.length > 0 && (
        <Card className="mb-6" title="Préstamos">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-normal">Préstamo</th>
                  <th className="px-2 py-2 text-right font-normal">Capital</th>
                  <th className="px-2 py-2 text-right font-normal">Tasa anual</th>
                  <th className="px-2 py-2 text-right font-normal">Cuota</th>
                  <th className="px-2 py-2 text-right font-normal">Pagadas</th>
                  <th className="px-2 py-2 text-right font-normal">Última cuota</th>
                  <th className="px-2 py-2 text-right font-normal">Saldo estimado</th>
                  <th className="px-4 py-2 text-right font-normal">Intereses por pagar</th>
                </tr>
              </thead>
              <tbody>
                {myLoans.map((l) => (
                  <tr key={l.commitment_id}>
                    <td className="px-4 py-2.5">{l.description}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">{money(l.principal, currency)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">{Number(l.annual_rate).toLocaleString('es-UY')}%</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">{money(l.monthly_payment, currency)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">{l.payments_made} de {l.payments_made + l.payments_left}</td>
                    <td className="px-2 py-2.5 text-right">{monthLabel(String(l.last_payment_month))}</td>
                    <td className="px-2 py-2.5 text-right font-medium tabular-nums">{money(l.balance_estimate, currency)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{money(l.interest_left_estimate, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {groups.length === 0 ? <Card><Empty>No hay compromisos en {currency === 'USD' ? 'dólares' : 'pesos'}.</Empty></Card> : (
        <div className="space-y-6">
          {groups.map((g) => (
            <Card key={g.kind} title={COMMITMENT_KIND_LABEL[g.kind] ?? g.kind}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-line text-left text-xs text-muted">
                    <tr>
                      <th className="px-4 py-2 font-normal">Compromiso</th>
                      <th className="px-2 py-2 text-right font-normal">Monto</th>
                      <th className="hidden px-2 py-2 font-normal md:table-cell">Frecuencia</th>
                      <th className="hidden px-2 py-2 font-normal md:table-cell">Vigencia</th>
                      <th className="px-2 py-2 font-normal">Último pago</th>
                      <th className="px-4 py-2 font-normal">Próximo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {g.items.map((c) => (
                      <tr key={c.id} id={`c${c.id}`} className={`align-top target:bg-accent/10 ${c.status !== 'active' ? 'opacity-50' : ''}`}>
                        <td className="px-4 py-2.5">
                          <Link href={`/movimientos${qs({ moneda: params.moneda }, c.merchant ? { comercio: c.merchant } : { q: c.description })}`} className="font-medium hover:underline">
                            {c.description}
                          </Link>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {c.category && <Pill>{c.category}</Pill>}
                            {c.tags.map((t: string) => <Pill key={t}>#{t}</Pill>)}
                            {c.off_statement && <Pill>fuera de los extractos</Pill>}
                            {c.status !== 'active' && <Pill>{c.status === 'cancelled' ? 'cancelado' : 'terminado'}</Pill>}
                          </div>
                          {c.notes && <p className="mt-1 max-w-xl text-xs text-muted">{c.notes}</p>}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2.5 text-right">
                          <Amount value={c.expected_amount} currency={currency} decimals={currency === 'USD' ? 2 : 0} />
                          {Number(c.tolerance) > 0 && <div className="text-xs text-muted">±{Math.round(Number(c.tolerance) * 100)}%</div>}
                        </td>
                        <td className="hidden px-2 py-2.5 text-muted md:table-cell">
                          {c.kind === 'installment_plan' || c.kind === 'loan' ? `${c.installments_total} cuotas` : every(c.every_n_months)}
                          {c.expected_day ? <div className="text-xs">día {c.expected_day}</div> : null}
                        </td>
                        <td className="hidden whitespace-nowrap px-2 py-2.5 text-muted md:table-cell">
                          {monthLabel(c.start_date)} – {c.end_date ? monthLabel(c.end_date) : 'sin fin'}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2.5">
                          {c.last_paid_month ? monthLabel(c.last_paid_month) : <span className="text-muted">—</span>}
                          {c.payments > 0 && <div className="text-xs text-muted">{c.payments} pago{c.payments === 1 ? '' : 's'}</div>}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5">{c.next_due_month ? monthLabel(c.next_due_month) : <span className="text-muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

