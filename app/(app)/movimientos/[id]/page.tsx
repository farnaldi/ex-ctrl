import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Amount, Card, PageTitle, Pill, qs } from '@/components/ui';
import { ACTOR_LABEL, KIND_LABEL, NATURE_LABEL, dateTime, dayLabel, monthLabel } from '@/lib/format';
import { requireWebCtx } from '@/lib/session';
import { getTransaction } from '@/src/core/finance';

export const dynamic = 'force-dynamic';

const BY: Record<string, string> = { rule: 'una regla', claude: 'el agente', user: 'vos', commitment: 'un compromiso', merchant: 'el comercio' };

export default async function Movimiento({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requireWebCtx();
  if (!/^\d+$/.test(id)) notFound();
  const t = await getTransaction(ctx, Number(id)).catch(() => null);
  if (!t) notFound();

  const rows: [string, React.ReactNode][] = [
    ['Fecha', `${dayLabel(t.posted_on, { year: true })}${t.month !== String(t.posted_on).slice(0, 7) ? ` · cuenta en ${monthLabel(t.month)}` : ''}`],
    ['Cuenta', t.account],
    ['Tipo', KIND_LABEL[t.kind] ?? t.kind ?? '—'],
    ['Comercio', t.merchant ? <Link href={`/movimientos${qs({}, { comercio: t.merchant, moneda: t.currency === 'USD' ? 'USD' : undefined })}`} className="text-accent hover:underline">{t.merchant}</Link> : '—'],
    ['Categoría', t.category ? <>{t.category} <span className="text-muted">· {NATURE_LABEL[t.nature] ?? t.nature}{t.categorized_by ? ` · la puso ${BY[t.categorized_by] ?? t.categorized_by}` : ''}</span></> : '—'],
    ['Tags', t.tags.length ? <span className="flex flex-wrap gap-1">{t.tags.map((g: { tag: string; tagged_by: string }) => <Pill key={g.tag}>#{g.tag}</Pill>)}</span> : '—'],
    ['Compromiso', t.commitment ? <Link href={`/compromisos${qs({}, { moneda: t.currency === 'USD' ? 'USD' : undefined })}#c${t.commitment_id}`} className="text-accent hover:underline">{t.commitment}</Link> : '—'],
    ['Cuenta como gasto', t.is_spending ? (t.one_off ? 'Sí, puntual (no entra en el promedio del pronóstico)' : 'Sí') : 'No'],
  ];
  if (t.installment_total) rows.push(['Cuota', `${t.installment_number} de ${t.installment_total}`]);
  if (t.note) rows.push(['Nota', t.note]);
  if (t.review_reason) rows.push(['Para revisar', <span className="text-danger">{t.review_reason}</span>]);

  return (
    <>
      <Link href="/movimientos" className="text-sm text-muted hover:underline">← Movimientos</Link>
      <PageTitle title={t.merchant ?? t.description_raw} subtitle={t.description_raw}>
        <Amount value={t.amount} currency={t.currency} decimals={2} className="text-2xl font-semibold" />
      </PageTitle>

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Card>
          <dl className="divide-y divide-line text-sm">
            {rows.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[9rem_1fr] gap-3 px-4 py-2.5">
                <dt className="text-muted">{k}</dt>
                <dd className="min-w-0 break-words">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card title="Cambios">
          {t.history.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">Sin cambios desde que se importó (o se cambió con el archivo de conocimiento, que no queda en el historial).</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {t.history.map((h: { op_id: string; at: string; actor: string; operation: string; undone_by: string | null }, i: number) => (
                <li key={`${h.op_id}-${i}`} className="px-4 py-2.5">
                  <Link href={`/historial/${h.op_id}`} className="hover:underline">{h.operation ?? 'cambio'}</Link>
                  {h.undone_by && <span className="ml-2"><Pill>deshecho</Pill></span>}
                  <p className="text-xs text-muted">{ACTOR_LABEL[h.actor] ?? h.actor} · {dateTime(h.at)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
