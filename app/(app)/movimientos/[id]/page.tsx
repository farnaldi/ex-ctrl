import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireWebCtx } from '@/lib/session';
import { transactionEditor } from '@/src/core/finance';
import { TransactionHeader, TransactionView } from '../_components/transaction-view';

export const dynamic = 'force-dynamic';

/** Full page for a direct URL / reload. Opened from the list, the same view shows in the drawer instead. */
export default async function Movimiento({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requireWebCtx();
  if (!/^\d+$/.test(id)) notFound();
  const data = await transactionEditor(ctx, Number(id)).catch(() => null);
  if (!data) notFound();

  return (
    <>
      <Link href="/movimientos" className="text-sm text-muted hover:underline">← Movimientos</Link>
      <div className="mb-6 mt-2"><TransactionHeader data={data} /></div>
      <TransactionView data={data} layout="page" />
    </>
  );
}
