import Link from 'next/link';
import { mcpResource } from '@/lib/auth';
import { requireWebCtx } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const { email } = await requireWebCtx();
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Finanzas</h1>
      <p className="mt-1 text-sm text-muted">{email}</p>
      <section className="mt-8 rounded-xl border border-line bg-surface p-5">
        <h2 className="font-medium">Conectar un agente</h2>
        <p className="mt-1 text-sm text-muted">
          Cualquier cliente MCP con OAuth (Claude, ChatGPT, otros): agregá un conector MCP remoto con esta URL, iniciá sesión y
          aceptá.
        </p>
        <code className="mt-3 block overflow-x-auto rounded-lg bg-bg px-3 py-2 text-sm">{mcpResource}</code>
        <p className="mt-4 text-sm text-muted">
          <Link href="/tokens" className="text-accent underline-offset-4 hover:underline">Agentes conectados y tokens de acceso</Link>.
        </p>
      </section>
    </main>
  );
}
