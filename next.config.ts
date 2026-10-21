import type { NextConfig } from 'next';

const config: NextConfig = {
  serverExternalPackages: ['pg', 'xlsx'],
  async rewrites() {
    return [{ source: '/.well-known/:path*', destination: '/api/well-known/:path*' }];
  },
};

export default config;
