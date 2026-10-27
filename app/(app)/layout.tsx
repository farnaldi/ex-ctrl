import { Suspense } from 'react';
import { Nav } from '@/components/nav';
import { requireWebCtx } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Signed-in shell: every page under it requires a session (each page also checks, since layouts don't re-run on navigation). */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { email } = await requireWebCtx();
  return (
    <>
      <Suspense fallback={<div className="h-[89px] border-b border-line" />}>
        <Nav email={email} />
      </Suspense>
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-6">{children}</div>
    </>
  );
}
