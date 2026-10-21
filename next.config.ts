import type { NextConfig } from 'next';

// Applied to every response. Clickjacking matters most on /consent (an invisible frame could trick a click
// on "Permitir"), so nothing here can be framed.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(process.env.BETTER_AUTH_URL?.startsWith('https://')
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]
    : []),
];

const config: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  serverExternalPackages: ['pg', 'xlsx'],
  agentRules: false,
  async rewrites() {
    return [{ source: '/.well-known/:path*', destination: '/api/well-known/:path*' }];
  },
};

export default config;
