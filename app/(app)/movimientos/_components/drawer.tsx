'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/** Side panel over the list. Esc, the backdrop or × go back to the list (history back keeps its filters and scroll). */
export function Drawer({ header, fullPageHref, children }: { header: React.ReactNode; fullPageHref?: string; children: React.ReactNode }) {
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // first Esc leaves the field (closing its suggestions), the next one closes the drawer
      const el = e.target;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        el.blur();
        panel.current?.focus();
        return;
      }
      router.back();
    };
    // keep Tab inside the panel (it's modal) and the page behind from scrolling
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')];
      if (!items.length) return;
      const [first, last] = [items[0], items[items.length - 1]];
      const inside = panel.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onTab);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onTab);
      document.body.style.overflow = overflow;
    };
  }, [router]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" aria-label="Cerrar" onClick={() => router.back()} className="absolute inset-0 cursor-default bg-ink/20" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="relative flex h-full w-full max-w-xl flex-col border-l border-line bg-bg shadow-2xl outline-none"
      >
        <div className="flex items-center gap-3 border-b border-line px-4 py-2 text-sm">
          <button type="button" onClick={() => router.back()} className="text-muted hover:text-ink">← Volver</button>
          {/* a plain link: a full load renders the page instead of the intercepted drawer */}
          {fullPageHref && <a href={fullPageHref} className="ml-auto text-muted hover:text-ink">Abrir página</a>}
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="mb-4">{header}</div>
          {children}
        </div>
      </div>
    </div>
  );
}
