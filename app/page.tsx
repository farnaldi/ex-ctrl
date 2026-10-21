import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth, mcpResource } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Finanzas</h1>
      <p className="mt-1 text-sm text-muted">{session.user.email}</p>
      <section className="mt-8 rounded-xl border border-line bg-surface p-5">
        <h2 className="font-medium">Conectar Claude</h2>
        <p className="mt-1 text-sm text-muted">
          En Claude: Configuración → Conectores → Agregar conector personalizado, con esta URL:
        </p>
        <code className="mt-3 block overflow-x-auto rounded-lg bg-bg px-3 py-2 text-sm">{mcpResource}</code>
      </section>
    </main>
  );
}
