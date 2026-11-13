import { notFound } from 'next/navigation';
import { requireWebCtx } from '@/lib/session';
import { transactionEditor } from '@/src/core/finance';
import { TransactionHeader, TransactionView } from '../../../movimientos/_components/transaction-view';
import { Drawer } from '../../../movimientos/_components/drawer';

export const dynamic = 'force-dynamic';

/**
 * Intercepted /movimientos/[id]: opened from the list (client navigation) it shows as a side panel and the list
 * stays mounted behind it, with its filters and scroll. A direct URL or reload renders the full page instead.
 */
export default async function MovimientoDrawer({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requireWebCtx();
  if (!/^\d+$/.test(id)) notFound();
  const data = await transactionEditor(ctx, Number(id)).catch(() => null);
  if (!data) notFound();

  return (
    <Drawer header={<TransactionHeader data={data} />} fullPageHref={`/movimientos/${id}`}>
      <TransactionView data={data} layout="drawer" />
    </Drawer>
  );
}
