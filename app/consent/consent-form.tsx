'use client';
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

export function ConsentForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(accept: boolean) {
    setBusy(true);
    const res = await authClient.oauth2.consent({ accept });
    setBusy(false);
    if (res.error) return setError(res.error.message ?? 'Error');
    const url = (res.data as { url?: string } | null)?.url;
    if (url) window.location.href = url;
  }

  return (
    <>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <div className="flex gap-3">
        <button disabled={busy} onClick={() => answer(true)} className="flex-1 rounded-lg bg-accent px-3 py-2.5 font-medium text-accent-ink disabled:opacity-60">
          Permitir
        </button>
        <button disabled={busy} onClick={() => answer(false)} className="flex-1 rounded-lg border border-line px-3 py-2.5 disabled:opacity-60">
          Rechazar
        </button>
      </div>
    </>
  );
}
