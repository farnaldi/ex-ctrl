import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'Finanzas', description: 'Gastos, compromisos y pronóstico' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
