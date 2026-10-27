import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, PageTitle, Pill } from '@/components/ui';
import { dateTime } from '@/lib/format';
import { requireWebCtx } from '@/lib/session';
import { getOperation, listOperations } from '@/src/core/finance';

export const dynamic = 'force-dynamic';

const OP: Record<string, string> = { insert: 'agregado', update: 'cambiado', delete: 'borrado' };
// bookkeeping columns that change on every write and say nothing to a person
const SKIP = new Set(['user_id', 'updated_at', 'created_at']);

type Row = Record<string, unknown>;

export default async function Operacion({ params }: { params: Promise<{ op: string }> }) {
  const { op } = await params;
  const { ctx } = await requireWebCtx();
  if (!/^[0-9a-f-]{36}$/i.test(op)) notFound();
  const [entries, ops] = await Promise.all([getOperation(ctx, op), listOperations(ctx, { limit: 200 })]);
  if (!entries.length) notFound();
  const meta = ops.find((o) => o.op_id === op);
  const first = entries[0];

  return (
    <>
      <Link href="/historial" className="text-sm text-muted hover:underline">← Historial</Link>
      <PageTitle title={first.operation ?? 'Cambio'} subtitle={<>{dateTime(first.at)} · {first.actor === 'claude' ? `agente${meta?.agent ? ` (${meta.agent})` : ''}` : 'vos'} · {first.source}</>}>
        {meta?.undone && <Pill>deshecho</Pill>}
      </PageTitle>
      <p className="mb-4 font-mono text-xs text-muted">operación {op}</p>

      <div className="space-y-4">
        {entries.map((e) => {
          const kind = String(e.op).toLowerCase();
          const before = (e.before ?? {}) as Row;
          const after = (e.after ?? {}) as Row;
          const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !SKIP.has(k));
          const changed = kind === 'update' ? keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])) : keys;
          return (
            <Card key={e.id} title={<>{e.table_name} <span className="text-sm font-normal text-muted">· {OP[kind] ?? kind} · {rowKey(e.row_key)}</span></>}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-line text-left text-xs text-muted">
                    <tr>
                      <th className="w-48 px-4 py-2 font-normal">Campo</th>
                      {kind !== 'insert' && <th className="px-2 py-2 font-normal">Antes</th>}
                      {kind !== 'delete' && <th className="px-4 py-2 font-normal">Después</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {changed.map((k) => (
                      <tr key={k} className="align-top">
                        <td className="px-4 py-2 font-mono text-xs text-muted">{k}</td>
                        {kind !== 'insert' && <td className="px-2 py-2 break-all text-muted">{show(before[k])}</td>}
                        {kind !== 'delete' && <td className="px-4 py-2 break-all">{show(after[k])}</td>}
                      </tr>
                    ))}
                    {changed.length === 0 && (
                      <tr><td colSpan={3} className="px-4 py-2 text-muted">Sin cambios visibles.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}

function show(v: unknown) {
  if (v === null || v === undefined) return <span className="text-muted">—</span>;
  if (typeof v === 'object') return <code className="text-xs">{JSON.stringify(v)}</code>;
  return String(v);
}

function rowKey(k: unknown) {
  if (k && typeof k === 'object') return Object.entries(k as Row).map(([a, b]) => `${a} ${b}`).join(', ');
  return String(k ?? '');
}
