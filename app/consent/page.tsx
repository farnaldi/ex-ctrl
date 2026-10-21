'use client';
import { useEffect, useState } from 'react';
import { authClient } from '@/lib/auth-client';

/** OAuth consent for an MCP client (e.g. Claude) asking to read and edit your finances. */
export default function ConsentPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState<URLSearchParams | null>(null);
  useEffect(() => setParams(new URLSearchParams(window.location.search)), []);
  const scopes = (params?.get('scope') ?? '').split(' ').filter(Boolean);

  async function answer(accept: boolean) {
    setBusy(true);
    const res = await authClient.oauth2.consent({ accept });
    setBusy(false);
    if (res.error) return setError(res.error.message ?? 'Error');
    const url = (res.data as { url?: string } | null)?.url;
    if (url) window.location.href = url;
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4">
      <h1 className="mb-2 text-xl font-semibold tracking-tight">Conectar un agente</h1>
      <p className="mb-4 text-sm text-muted">
        Una aplicación (<span className="font-mono">{params?.get('client_id')?.slice(0, 40)}</span>) quiere acceder a tus finanzas:
        ver movimientos, categorías, compromisos y pronóstico, y cargar o editar datos. Cada cambio que haga queda en el
        historial y se puede deshacer.
      </p>
      {scopes.length > 0 && <p className="mb-6 text-xs text-muted">Permisos: {scopes.join(', ')}</p>}
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <div className="flex gap-3">
        <button disabled={busy} onClick={() => answer(true)} className="flex-1 rounded-lg bg-accent px-3 py-2.5 font-medium text-accent-ink">
          Permitir
        </button>
        <button disabled={busy} onClick={() => answer(false)} className="flex-1 rounded-lg border border-line px-3 py-2.5">
          Rechazar
        </button>
      </div>
    </main>
  );
}
