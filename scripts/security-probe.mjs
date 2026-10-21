#!/usr/bin/env node
/**
 * Black-box security checks against a running deployment (local or Railway). Read-only on your data:
 * it signs in, registers two throwaway OAuth clients, runs the OAuth flow and calls read tools.
 *
 *   PROBE_URL=https://<domain> PROBE_EMAIL=you@example.com PROBE_PASSWORD=... node scripts/security-probe.mjs
 *
 * Brute-force checks use a made-up email, so they never lock your account. Run it from a machine whose IP
 * you don't mind being rate-limited for a minute. Each line prints PASS/FAIL and what was observed.
 */
import { createHash, randomBytes } from 'node:crypto';

const B = (process.env.PROBE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const RES = `${B}/api/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const EMAIL = process.env.PROBE_EMAIL;
const PASSWORD = process.env.PROBE_PASSWORD;
const LOCAL = /localhost|127\.0\.0\.1/.test(B);
if (!EMAIL || !PASSWORD) {
  console.error('Set PROBE_EMAIL and PROBE_PASSWORD (an account on this deployment).');
  process.exit(2);
}

let failures = 0;
const check = (name, ok, seen) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${seen}`);
};
// Locally there is no edge: simulate the one header Railway sets.
const edge = (n = 1) => (LOCAL ? { 'x-real-ip': `198.51.100.${n}` } : {});
const json = { 'content-type': 'application/json', origin: B };

function session() {
  let cookie = '';
  const f = async (path, opts = {}) => {
    const r = await fetch(B + path, { ...opts, redirect: 'manual', headers: { ...(opts.headers ?? {}), ...(cookie ? { cookie } : {}) } });
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const kv = c.split(';')[0];
      cookie = cookie.split('; ').filter((x) => x && !x.startsWith(kv.split('=')[0] + '=')).concat(kv).join('; ');
    }
    return r;
  };
  return f;
}
const pkce = () => {
  const v = randomBytes(32).toString('base64url');
  return { v, c: createHash('sha256').update(v).digest('base64url') };
};
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
async function register(extra = {}) {
  const r = await fetch(`${B}/api/auth/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...edge(50) },
    body: JSON.stringify({ client_name: 'security-probe', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...extra }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function authorizeUrl(f, clientId, extra = {}) {
  const { v, c } = pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid offline_access',
    state: 's', code_challenge: c, code_challenge_method: 'S256', resource: RES, ...extra });
  const r = await f(`/api/auth/oauth2/authorize?${q}`);
  return { v, url: r.headers.get('location') ?? (await r.json().catch(() => ({}))).url ?? '' };
}
async function tokens(f, clientId) {
  let { v, url } = await authorizeUrl(f, clientId);
  if (url.includes('/consent')) {
    const r = await f('/api/auth/oauth2/consent', { method: 'POST', headers: json, body: JSON.stringify({ accept: true, oauth_query: new URL(url, B).search.slice(1) }) });
    url = (await r.json()).url;
  }
  const code = new URL(url).searchParams.get('code');
  const r = await fetch(`${B}/api/auth/oauth2/token`, form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: v, resource: RES }));
  return r.json();
}
async function mcp(token, headers = {}) {
  const r = await fetch(RES, {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  return r.status;
}

console.log(`Probing ${B}\n`);

// ---- transport and headers
{
  const r = await fetch(`${B}/consent`, { redirect: 'manual' });
  const h = r.headers;
  check('consent page cannot be framed (clickjacking)', h.get('x-frame-options') === 'DENY' && /frame-ancestors 'none'/.test(h.get('content-security-policy') ?? ''), `xfo=${h.get('x-frame-options')}`);
  check('nosniff + no-referrer + no x-powered-by', h.get('x-content-type-options') === 'nosniff' && h.get('referrer-policy') === 'no-referrer' && !h.get('x-powered-by'), '');
  if (!LOCAL) {
    check('HSTS on https', /max-age=\d{7,}/.test(h.get('strict-transport-security') ?? ''), h.get('strict-transport-security') ?? 'missing');
    const plain = await fetch(B.replace('https://', 'http://') + '/api/health', { redirect: 'manual' }).catch(() => null);
    check('plain http is redirected or refused', !plain || [301, 302, 307, 308].includes(plain.status), String(plain?.status ?? 'refused'));
  }
}
// ---- discovery
{
  const pr = await (await fetch(`${B}/.well-known/oauth-protected-resource/api/mcp`)).json();
  check('protected resource metadata names this server', pr.resource === RES, pr.resource);
  const as = await (await fetch(`${B}/.well-known/oauth-authorization-server/api/auth`)).json();
  check('no client_credentials grant advertised', !(as.grant_types_supported ?? []).includes('client_credentials'), (as.grant_types_supported ?? []).join(','));
  check('PKCE S256 advertised', (as.code_challenge_methods_supported ?? []).includes('S256'), (as.code_challenge_methods_supported ?? []).join(','));
}
// ---- MCP without valid credentials
{
  const r = await fetch(RES, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('no token -> 401 with resource_metadata challenge', r.status === 401 && /resource_metadata=/.test(r.headers.get('www-authenticate') ?? ''), String(r.status));
  check('random bearer -> 401', (await mcp('not-a-token')) === 401, '');
  check('fake fin_ token -> 401', (await mcp(`fin_AAAAAAAA_${'x'.repeat(43)}`)) === 401, '');
  const big = await fetch(RES, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(5 * 1024 * 1024) }).catch(() => ({ status: 'closed' }));
  check('5 MB unauthenticated body is rejected', big.status !== 200, String(big.status));
}
// ---- OAuth flow
const f = session();
const login = await f('/api/auth/sign-in/email', { method: 'POST', headers: { ...json, ...edge(2) }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
check('sign in with probe account', login.status === 200, String(login.status));
const setCookie = login.headers.getSetCookie?.().join(';') ?? '';
check('session cookie HttpOnly + SameSite', /HttpOnly/i.test(setCookie) && /SameSite/i.test(setCookie), '');
if (!LOCAL) check('session cookie Secure', /Secure/i.test(setCookie), '');

const client = await register();
check('dynamic client registration (needed by MCP clients)', client.status === 201, String(client.status));
const m2m = await register({ grant_types: ['client_credentials'], token_endpoint_auth_method: 'client_secret_basic', response_types: [] });
check('client_credentials client is refused', m2m.status >= 400, `${m2m.status} ${m2m.body.error ?? ''}`);

const tok = await tokens(f, client.body.client_id);
check('authorization code flow issues tokens', !!tok.access_token && !!tok.refresh_token, Object.keys(tok).join(','));
if (tok.access_token) {
  const claims = JSON.parse(Buffer.from(tok.access_token.split('.')[1], 'base64url'));
  check('access token audience = this MCP server', [].concat(claims.aud).includes(RES), JSON.stringify(claims.aud));
  check('access token lifetime <= 15 min', claims.exp - claims.iat <= 900, `${Math.round((claims.exp - claims.iat) / 60)} min`);
  check('valid token -> tools/list 200', (await mcp(tok.access_token)) === 200, '');
  check('id_token is not accepted as access token', (await mcp(tok.id_token)) === 401, '');
  const [h, p, s] = tok.access_token.split('.');
  const forged = JSON.parse(Buffer.from(p, 'base64url'));
  forged.sub = '00000000-0000-4000-8000-000000000000';
  check('tampered token (other user) -> 401', (await mcp([h, Buffer.from(JSON.stringify(forged)).toString('base64url'), s].join('.'))) === 401, '');
  check('alg=none token -> 401', (await mcp([Buffer.from('{"alg":"none"}').toString('base64url'), p, ''].join('.'))) === 401, '');
  check('browser Origin of another site -> 403 (DNS rebinding)', (await mcp(tok.access_token, { origin: 'https://evil.example' })) === 403, '');
  const q = await fetch(`${RES}?access_token=${tok.access_token}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  check('token in the URL is ignored', q.status === 401, String(q.status));

  const big = await fetch(RES, { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: 'x'.repeat(5 * 1024 * 1024) }).catch(() => ({ status: 'closed' }));
  check('5 MB authenticated body is rejected', big.status === 413 || big.status === 'closed', String(big.status));

  // refresh token rotation and replay (a replayed old token revokes the whole chain)
  const refresh = (rt) => fetch(`${B}/api/auth/oauth2/token`, form({ grant_type: 'refresh_token', refresh_token: rt, client_id: client.body.client_id, resource: RES }));
  const a = await refresh(tok.refresh_token);
  const aj = await a.json();
  check('refresh token rotates', a.status === 200 && aj.refresh_token && aj.refresh_token !== tok.refresh_token, String(a.status));
  console.log('      (waiting 31 s: retries of a rotated refresh token are tolerated for 30 s)');
  await new Promise((r) => setTimeout(r, 31_000));
  const replay = await refresh(tok.refresh_token);
  const after = await refresh(aj.refresh_token);
  check('replayed refresh token refused and its chain revoked', replay.status === 400 && after.status === 400, `${replay.status}, ${after.status}`);
}
// ---- authorization code: PKCE verifier checked, single use
{
  const exchange = async (overrides = {}) => {
    const { v, url } = await authorizeUrl(f, client.body.client_id);
    const body = { grant_type: 'authorization_code', code: new URL(url).searchParams.get('code'), redirect_uri: REDIRECT,
      client_id: client.body.client_id, code_verifier: v, resource: RES };
    return { body, wrong: overrides.wrongVerifier ? await fetch(`${B}/api/auth/oauth2/token`, form({ ...body, code_verifier: 'x'.repeat(43) })) : null };
  };
  const w = await exchange({ wrongVerifier: true });
  const afterWrong = await fetch(`${B}/api/auth/oauth2/token`, form(w.body));
  check('wrong PKCE verifier refused (and the code is burned)', w.wrong.status === 400 && afterWrong.status === 400, `${w.wrong.status}, ${afterWrong.status}`);
  const { body } = await exchange();
  const first = await fetch(`${B}/api/auth/oauth2/token`, form(body));
  const second = await fetch(`${B}/api/auth/oauth2/token`, form(body));
  check('authorization code works once', first.status === 200 && second.status === 400, `${first.status}, ${second.status}`);
}
// ---- authorization request tampering
{
  const { url } = await authorizeUrl(f, client.body.client_id, { redirect_uri: 'https://evil.example/cb' });
  check('unregistered redirect_uri is refused', !url.startsWith('https://evil.example'), url.slice(0, 70));
  const noPkce = new URLSearchParams({ response_type: 'code', client_id: client.body.client_id, redirect_uri: REDIRECT, scope: 'openid', state: 's', resource: RES });
  const r = await f(`/api/auth/oauth2/authorize?${noPkce}`);
  const u = r.headers.get('location') ?? (await r.json().catch(() => ({}))).url ?? '';
  check('authorization without PKCE is refused', /error=/.test(u) && !/code=/.test(u), u.replace(/.*error_description=/, '').slice(0, 50));
  for (const cid of ['https://127.0.0.1/c.json', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.1/c.json']) {
    const t0 = Date.now();
    const { url: u2 } = await authorizeUrl(f, cid);
    check(`CIMD client_id to internal address refused (${cid.slice(8, 23)})`, !/code=/.test(u2) && Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
  }
  const fresh = await register({ client_name: 'security-probe-consent' }); // never consented, so the consent page shows
  const cons = await authorizeUrl(f, fresh.body.client_id);
  if (cons.url.includes('/consent')) {
    const evil = await f('/api/auth/oauth2/consent', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ accept: true, oauth_query: new URL(cons.url, B).search.slice(1) }) });
    check('consent from another site is refused (CSRF)', evil.status >= 400, String(evil.status));
    const tampered = await f(cons.url.replace(encodeURIComponent(REDIRECT), encodeURIComponent('https://evil.example/cb')));
    check('consent page rejects a tampered link', (await tampered.text()).includes('Solicitud no válida'), '');
  }
}
// ---- login CSRF, sign-up allowlist, brute force (made-up account, never yours)
{
  const fake = `probe-${randomBytes(4).toString('hex')}@example.invalid`;
  const evil = await fetch(`${B}/api/auth/sign-in/email`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', ...edge(8) }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  check('sign-in from another site is refused (login CSRF)', evil.status === 403, String(evil.status));
  const signup = await fetch(`${B}/api/auth/sign-up/email`, { method: 'POST', headers: { ...json, ...edge(9) }, body: JSON.stringify({ email: fake, password: 'long-enough-password', name: 'x' }) });
  check('sign-up closed for emails not in ALLOWED_EMAILS', signup.status === 403, String(signup.status));

  const burst = async (headersFor, email) => {
    const codes = [];
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${B}/api/auth/sign-in/email`, { method: 'POST', headers: { ...json, ...headersFor(i) }, body: JSON.stringify({ email, password: 'wrong-password-' + i }) });
      codes.push(r.status);
    }
    return codes;
  };
  if (!LOCAL) {
    // each burst needs a fresh 1-minute window for this IP, or it would pass for the wrong reason
    console.log('      (waiting 61 s for a fresh rate-limit window)');
    await new Promise((r) => setTimeout(r, 61_000));
    const spoof = await burst((i) => ({ 'x-real-ip': `10.1.0.${i}` }), `${fake}.a`);
    check('X-Real-IP sent by the client is not trusted (edge overwrites it)', spoof.includes(429), spoof.join(','));
    console.log('      (waiting 61 s for a fresh rate-limit window)');
    await new Promise((r) => setTimeout(r, 61_000));
  }
  const xff = await burst((i) => ({ ...edge(7), 'x-forwarded-for': `10.0.0.${i}` }), `${fake}.b`);
  check('sign-in rate limit, not bypassed by X-Forwarded-For', xff.includes(429), xff.join(','));
}

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'All checks passed'}`);
process.exit(failures ? 1 : 0);
