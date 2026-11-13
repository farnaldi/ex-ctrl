import Link from 'next/link';
import { Amount, Card, Pill, qs } from '@/components/ui';
import { ACTOR_LABEL, KIND_LABEL, NATURE_LABEL, dateTime, dayLabel, monthLabel } from '@/lib/format';
import type { transactionEditor } from '@/src/core/finance';
import { TransactionForm } from './transaction-form';

const BY: Record<string, string> = { rule: 'una regla', claude: 'el agente', user: 'vos', commitment: 'un compromiso', merchant: 'el comercio' };

type Editor = Awaited<ReturnType<typeof transactionEditor>>;
type History = { op_id: string; at: string; actor: string; operation: string; undone_by: string | null };

/**
 * One transaction: the edit form on desktop (md and up), read-only details on phones, plus the change history.
 * Used by the drawer (intercepted route) and by the full page, so both stay identical.
 */
export function TransactionView({ data, layout }: { data: Editor; layout: 'page' | 'drawer' }) {
  const t = data.transaction;
  const tags = t.tags.map((g: { tag: string }) => g.tag) as string[];

  const facts: [string, React.ReactNode][] = [
    ['Fecha', `${dayLabel(t.posted_on, { year: true })}${t.month !== String(t.posted_on).slice(0, 7) ? ` · cuenta en ${monthLabel(t.month)}` : ''}`],
    ['Cuenta', t.account],
    ['Tipo', KIND_LABEL[t.kind] ?? t.kind ?? '—'],
    ['Cuenta como gasto', t.is_spending ? (t.one_off ? 'Sí, puntual (no entra en el promedio del pronóstico)' : 'Sí') : 'No'],
  ];
  if (t.installment_total) facts.push(['Cuota', `${t.installment_number} de ${t.installment_total}`]);
  if (t.category && t.categorized_by) facts.push(['Categoría puesta por', `${BY[t.categorized_by] ?? t.categorized_by} · ${NATURE_LABEL[t.nature] ?? t.nature}`]);
  if (t.review_reason) facts.push(['Para revisar', <span key="r" className="text-danger">{t.review_reason}</span>]);

  // the editable fields, read-only (phones)
  const editable: [string, React.ReactNode][] = [
    ['Comercio', t.merchant ? <Link href={`/movimientos${qs({}, { comercio: t.merchant, moneda: t.currency === 'USD' ? 'USD' : undefined })}`} className="text-accent hover:underline">{t.merchant}</Link> : '—'],
    ['Categoría', t.category ?? '—'],
    ['Tags', tags.length ? <span className="flex flex-wrap gap-1">{tags.map((g) => <Pill key={g}>#{g}</Pill>)}</span> : '—'],
    ['Compromiso', t.commitment ? <Link href={`/compromisos${qs({}, { moneda: t.currency === 'USD' ? 'USD' : undefined })}#c${t.commitment_id}`} className="text-accent hover:underline">{t.commitment}</Link> : '—'],
  ];
  if (t.note) editable.push(['Nota', t.note]);

  const editableTx = {
    id: Number(t.id),
    category: t.category ?? null,
    merchant: t.merchant ?? null,
    note: t.note ?? null,
    one_off: Boolean(t.one_off),
    commitment_id: t.commitment_id ?? null,
    tags,
    is_spending: Boolean(t.is_spending),
  };
  // remount the form whenever the stored values change (after a save, an undo, or an agent edit)
  const formKey = JSON.stringify(editableTx);

  const history = (
    <Card title="Cambios">
      {t.history.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted">Sin cambios desde que se importó (o se cambió con el archivo de conocimiento, que no queda en el historial).</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {t.history.map((h: History, i: number) => (
            <li key={`${h.op_id}-${i}`} className="px-4 py-2.5">
              <Link href={`/historial/${h.op_id}`} className="hover:underline">{h.operation ?? 'cambio'}</Link>
              {h.undone_by && <span className="ml-2"><Pill>deshecho</Pill></span>}
              <p className="text-xs text-muted">{ACTOR_LABEL[h.actor] ?? h.actor} · {dateTime(h.at)}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  return (
    <div className={layout === 'page' ? 'grid gap-6 lg:grid-cols-[3fr_2fr]' : 'grid gap-4'}>
      <div className="grid content-start gap-4">
        <Card>
          <Rows rows={facts} />
          <div className="border-t border-line md:hidden"><Rows rows={editable} /></div>
        </Card>
        <Card className="hidden p-4 md:block">
          <TransactionForm key={formKey} tx={editableTx} options={data.options} />
        </Card>
      </div>
      {history}
    </div>
  );
}

export function TransactionHeader({ data }: { data: Editor }) {
  const t = data.transaction;
  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight">{t.merchant ?? t.description_raw}</h1>
        <p className="mt-0.5 break-words text-sm text-muted">{t.description_raw}</p>
      </div>
      <Amount value={t.amount} currency={t.currency} decimals={2} className="text-xl font-semibold" />
    </div>
  );
}

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="divide-y divide-line text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[9rem_1fr] gap-3 px-4 py-2.5">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
