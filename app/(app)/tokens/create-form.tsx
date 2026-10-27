'use client';
import { useActionState, useState } from 'react';
import { createTokenAction } from './actions';

export function CreateTokenForm() {
  const [state, action, pending] = useActionState(createTokenAction, null);
  const [copied, setCopied] = useState(false);

  return (
    <div>
      <form action={action} className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        <label className="grid gap-1 text-sm">
          <span className="text-muted">Nombre del agente</span>
          <input name="name" required maxLength={60} placeholder="n8n, script de reportes…"
                 className="rounded-lg border border-line bg-surface px-3 py-2" />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted">Vence</span>
          <select name="expires_days" className="rounded-lg border border-line bg-surface px-3 py-2" defaultValue="90">
            <option value="30">30 días</option>
            <option value="90">90 días</option>
            <option value="365">1 año</option>
            <option value="0">Nunca</option>
          </select>
        </label>
        <label className="flex items-center gap-2 py-2 text-sm">
          <input type="checkbox" name="read_only" /> Solo lectura
        </label>
        <button disabled={pending} className="rounded-lg bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-60">
          Crear token
        </button>
      </form>
      {state && !state.ok && <p className="mt-3 text-sm text-danger">{state.error}</p>}
      {state?.ok && (
        <div className="mt-4 rounded-xl border border-accent/40 bg-surface p-4">
          <p className="text-sm font-medium">Token “{state.name}” creado. Copialo ahora: no se vuelve a mostrar.</p>
          <div className="mt-2 flex gap-2">
            <code className="flex-1 overflow-x-auto rounded-lg bg-bg px-3 py-2 text-sm">{state.token}</code>
            <button type="button" onClick={() => { navigator.clipboard.writeText(state.token); setCopied(true); }}
                    className="rounded-lg border border-line px-3 text-sm">{copied ? 'Copiado' : 'Copiar'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
