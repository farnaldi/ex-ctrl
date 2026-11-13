import { Drawer } from '../../../movimientos/_components/drawer';

export default function Loading() {
  return (
    <Drawer header={<div className="h-12 animate-pulse rounded-lg bg-line/60" />}>
      <div className="grid gap-4">
        <div className="h-40 animate-pulse rounded-xl bg-line/60" />
        <div className="h-72 animate-pulse rounded-xl bg-line/60" />
      </div>
    </Drawer>
  );
}
