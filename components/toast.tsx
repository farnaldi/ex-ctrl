'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/** Small toast stack (bottom right): a message plus optional actions such as "Deshacer". No library needed. */

export type ToastAction = { label: string; onClick: () => void };
export type Toast = { message: string; tone?: 'ok' | 'error'; actions?: ToastAction[] };
type Item = Toast & { id: number };

const ToastContext = createContext<(t: Toast) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback((t: Toast) => {
    const id = next.current++;
    setItems((xs) => [...xs.slice(-2), { ...t, id }]); // at most 3 on screen
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
        {items.map((t) => <ToastView key={t.id} toast={t} dismiss={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, dismiss }: { toast: Item; dismiss: (id: number) => void }) {
  const [hover, setHover] = useState(false);
  const onClose = useCallback(() => dismiss(toast.id), [dismiss, toast.id]);
  useEffect(() => {
    if (hover) return;
    const timer = setTimeout(onClose, toast.tone === 'error' ? 10_000 : 8_000);
    return () => clearTimeout(timer);
  }, [hover, onClose, toast.tone]);

  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`pointer-events-auto rounded-xl border bg-surface px-4 py-3 text-sm shadow-lg ${toast.tone === 'error' ? 'border-danger/50' : 'border-line'}`}
    >
      <div className="flex items-start gap-3">
        <p className={`min-w-0 flex-1 ${toast.tone === 'error' ? 'text-danger' : ''}`}>{toast.message}</p>
        <button type="button" onClick={onClose} aria-label="Cerrar" className="shrink-0 text-muted hover:text-ink">×</button>
      </div>
      {toast.actions?.length ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {toast.actions.map((a) => (
            <button key={a.label} type="button" onClick={() => { onClose(); a.onClick(); }} className="font-medium text-accent hover:underline">
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
