'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

const ITEMS = [
  { href: '/', label: 'Resumen' },
  { href: '/movimientos', label: 'Movimientos' },
  { href: '/categorias', label: 'Categorías' },
  { href: '/tags', label: 'Tags' },
  { href: '/compromisos', label: 'Compromisos' },
  { href: '/pronostico', label: 'Pronóstico' },
  { href: '/historial', label: 'Historial' },
];

/** Top navigation. Keeps the selected currency when moving between sections. */
export function Nav({ email }: { email: string }) {
  const path = usePathname();
  const params = useSearchParams();
  const moneda = params.get('moneda');
  const keep = moneda === 'USD' ? '?moneda=USD' : '';
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));

  return (
    <header className="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 pt-3">
        <Link href={`/${keep}`} className="font-semibold tracking-tight">Finanzas</Link>
        <span className="ml-auto truncate text-xs text-muted">{email}</span>
        <Link href="/tokens" className={`text-xs ${active('/tokens') ? 'text-ink' : 'text-muted'} hover:text-ink`}>Agentes</Link>
      </div>
      <nav className="mx-auto max-w-6xl overflow-x-auto px-2">
        <ul className="flex gap-1 py-2 text-sm">
          {ITEMS.map((i) => (
            <li key={i.href}>
              <Link
                href={`${i.href}${keep}`}
                aria-current={active(i.href) ? 'page' : undefined}
                className={`block whitespace-nowrap rounded-lg px-3 py-1.5 ${
                  active(i.href) ? 'bg-surface font-medium text-ink shadow-[0_0_0_1px_var(--line)]' : 'text-muted hover:text-ink'
                }`}
              >
                {i.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
