'use client';
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

/** Sign in (and first-time sign up). Also the OAuth login page for the MCP connector: Better Auth
 *  carries the pending authorization in the URL and returns where to continue. */
export default function LoginPage() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res =
      mode === 'in'
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: name || email.split('@')[0] });
    setBusy(false);
    if (res.error) return setError(res.error.message ?? 'No se pudo ingresar');
    const next = (res.data as { url?: string } | null)?.url;
    window.location.href = next ?? '/';
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Finanzas</h1>
      <p className="mb-8 text-sm text-muted">{mode === 'in' ? 'Ingresá a tu cuenta' : 'Creá tu cuenta'}</p>
      <form onSubmit={submit} className="space-y-3">
        {mode === 'up' && (
          <input className="w-full rounded-lg border border-line bg-surface px-3 py-2.5" placeholder="Nombre" value={name}
                 onChange={(e) => setName(e.target.value)} autoComplete="name" />
        )}
        <input className="w-full rounded-lg border border-line bg-surface px-3 py-2.5" placeholder="Email" type="email" required
               value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        <input className="w-full rounded-lg border border-line bg-surface px-3 py-2.5" placeholder="Contraseña" type="password" required
               minLength={12} value={password} onChange={(e) => setPassword(e.target.value)}
               autoComplete={mode === 'in' ? 'current-password' : 'new-password'} />
        {error && <p className="text-sm text-danger">{error}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-accent px-3 py-2.5 font-medium text-accent-ink disabled:opacity-60">
          {busy ? '…' : mode === 'in' ? 'Ingresar' : 'Crear cuenta'}
        </button>
      </form>
      <button onClick={() => setMode(mode === 'in' ? 'up' : 'in')} className="mt-6 text-sm text-muted underline-offset-4 hover:underline">
        {mode === 'in' ? '¿Primera vez? Crear cuenta' : 'Ya tengo cuenta'}
      </button>
    </main>
  );
}
