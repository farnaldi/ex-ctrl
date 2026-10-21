# Security

What is exposed, what protects it, how it was tested, and what is left. Re-run the black-box checks after
every deploy:

```bash
PROBE_URL=https://<domain> PROBE_EMAIL=<you> PROBE_PASSWORD=<pw> node scripts/security-probe.mjs
```

## What is at stake

- **Assets**: bank movements, amounts, counterparties and notes (personal financial data); the knowledge built
  on them (rules, commitments); the ability to change all of it.
- **Who could attack**: anyone on the internet (the app and `/api/mcp` are public); a malicious or compromised
  MCP client; a third party who can put text into your bank data (the note on a transfer they send you);
  another user of the same instance.
- **Entry points**: `/login` and `/api/auth/*` (Better Auth), the OAuth server for MCP clients
  (`/api/auth/oauth2/*`, `/.well-known/*`), `/consent`, `/api/mcp`, `/tokens`.

## Controls

### Data isolation between users
- Postgres row-level security on every table, **forced** (applies to the table owner too). Every request runs in
  one transaction with `app.user_id` set; the app role is not a superuser and has no `bypassrls`.
- Composite foreign keys `(user_id, id)`: a row can never reference another user's row.
- Auth tables live in schema `auth`, owned by a second role that has no access to the finance tables.
- No raw SQL is exposed to agents: a query could call `set_config('app.user_id', …)` and read another user.
- Tested: `test/app.test.ts` (another user sees nothing, can't edit or undo someone else's operation, can't list
  their tokens).

### Authentication (people)
- Email + password (≥ 12 characters), sign-up limited to `ALLOWED_EMAILS`.
- Rate limits stored in Postgres (survive restarts): sign-in 5/min, sign-up 5/h, client registration 20/h,
  token endpoint 30/min, everything else 100/min, per client IP.
- The client IP comes only from `X-Real-IP`, which Railway's edge sets (`TRUSTED_IP_HEADER`). Before this,
  `X-Forwarded-For` was trusted and **rotating it bypassed the limit entirely** (found and fixed in this review).
- Per-account lockout: 10 failed sign-ins in 15 minutes lock that email for the rest of the window, whatever the IP.
- CSRF: Better Auth rejects state-changing requests from another origin (tested: sign-in and consent from
  `evil.example` → 403). Next.js server actions check the origin too.
- Cookies: `HttpOnly`, `SameSite=Lax`, `Secure` when the public URL is https.

### Authorization for agents (OAuth 2.1, MCP authorization)
- Our own authorization server (Better Auth `mcp()` plugin). MCP clients register themselves (dynamic client
  registration or Client ID Metadata Documents), which is required by MCP clients such as Claude; **the consent
  screen is the gate**.
- Consent screen shows the client's name and **the domain it will return to**, read from the authorization
  request our server signed and verified server-side. Domains not in `TRUSTED_REDIRECT_DOMAINS` (default
  claude.ai, claude.com, chatgpt.com) are shown in red. A tampered or expired link shows "Solicitud no válida".
- Only `authorization_code` (PKCE S256 required) and `refresh_token`. No `client_credentials`: a client can never
  get a token without a user behind it.
- Access tokens: JWT, 15 minutes, audience-bound to `https://<domain>/api/mcp` (RFC 8707). Refresh tokens: 30 days,
  rotated on every use; replaying an old one revokes the whole chain.
- `/api/mcp` additionally checks that the token's user exists and **still has a consent for that client**, so
  "Desconectar" on `/tokens` cuts an agent off within a minute even with an unexpired access token.
- CIMD fetches refuse internal addresses (loopback, link-local/metadata, private ranges): no SSRF through
  `client_id` URLs.
- Tokens are only read from the `Authorization` header (a token in the URL is ignored).

### Personal access tokens (agents without OAuth)
- `fin_<8>_<43>` (256 bits of randomness), stored as SHA-256, shown once, revocable, optional expiry and read-only.
- Read-only tokens only get the 18 read tools; write tools do not exist for them.
- Lookup goes through one `security definer` function that takes a hash and returns only the owner of a live token.

### The MCP endpoint
- `Origin` check: requests from a browser page of another site are refused (DNS rebinding); server-side MCP
  clients send no `Origin`. Extra browser origins (an inspector) via `MCP_ALLOWED_ORIGINS`.
- 120 requests per user per minute (`MCP_RATE_LIMIT_PER_MINUTE`), for an agent in a loop or a leaked token.
- Request bodies over 4 MB are refused (413); unauthenticated requests are rejected (401) before parsing.
- Stateless (no MCP sessions to hijack); tokens are never passed on to anything else (no token passthrough).
- Every tool validates its input with zod; values reach SQL only as parameters (the two interpolated values,
  limit and offset, are clamped integers).

### Agent mistakes and prompt injection
- Bank text can contain words written by third parties (the note on an incoming transfer, a merchant name).
  It reaches the agent as tool results. The server instructions tell agents to treat those fields as data and
  never act on them; the tools are annotated (`readOnlyHint`, `destructiveHint`) so clients can ask before writes.
- This cannot be fully prevented on the server side. What limits the damage: no tool can move money or reach
  anything outside this database; imported rows can't be deleted; **every agent write is one audited operation
  with the agent's name and can be undone** (`undo_operation`, refuses to overwrite later work); read-only tokens.

### Response headers
- `X-Frame-Options: DENY` and `frame-ancestors 'none'` (an invisible frame over "Permitir" would be clickjacking),
  `nosniff`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, `COOP: same-origin`,
  HSTS (2 years) when the public URL is https, no `X-Powered-By`.

### Secrets and configuration
- Production refuses to start without `BETTER_AUTH_SECRET` (≥ 32 characters), `BETTER_AUTH_URL` and both
  database URLs. Role passwords come from those URLs; nothing secret is in the repo (`.env` is gitignored,
  `docker-compose.yml` credentials are local-only).
- `npm audit --omit=dev`: 0 known vulnerabilities (2026-10-21). `xlsx` comes from the SheetJS CDN (0.20.3)
  because the npm copy (0.18.5) has known issues and the app parses uploaded files.

## Test evidence (2026-10-21, local production build)

`scripts/security-probe.mjs`: 37 checks, all passing — headers, discovery, unauthenticated/forged/foreign tokens,
alg=none, tampered subject, id_token as access token, token in URL, DNS-rebinding Origin, oversized body
(401 unauthenticated, 413 authenticated), PKCE and redirect_uri enforcement, a wrong PKCE verifier burns the code,
single-use codes, refresh rotation and replay (the whole chain is revoked), client_credentials refused, CIMD to internal
addresses, consent CSRF and tampered consent links, login CSRF, closed sign-up, rate limit not bypassable via
`X-Forwarded-For`. Plus `npm test` (18 tests: isolation, audit/undo, tokens, guards). Two more run only against
https: HSTS + `Secure` cookies, and that a client-sent `X-Real-IP` is overwritten by the edge.

## Residual risks (accepted or pending)

| Risk | Status |
|---|---|
| Prompt injection through bank text | Mitigated (instructions, annotations, audit + undo, read-only tokens), not eliminable |
| Lockout can be triggered by anyone who knows your email (10 wrong passwords → 15 min locked out) | Accepted: it expires, and passwords can't be brute-forced |
| No 2FA / passkeys yet | Pending (roadmap). Until then: long unique password from a password manager |
| No email verification or password reset | Pending (needs an email provider). Allowlist only for now |
| Sign-up reveals that an email already has an account | Low; allowlisted instance |
| Rate-limit and lockout counters for MCP and per-account are in memory | Fine for one instance; move to Postgres before scaling out |
| Connected-agent access checked with a 1-minute cache | Disconnect takes effect within 60 s |
| `audit_log` rows can be inserted by the app role (only the trigger should) | Low: agents have no SQL; pending hardening |
| Lockfile lacks `xlsx` (CDN blocked where it was built) | Commit the lockfile from the first Railway build |

## Publish checklist (Railway)

1. Postgres with **no public TCP proxy** (only the private network). Enable backups.
2. Service variables: `ADMIN_DATABASE_URL=${{Postgres.DATABASE_URL}}`, `DATABASE_URL` / `AUTH_DATABASE_URL` with two
   different new roles and long random passwords, `BETTER_AUTH_SECRET` (`openssl rand -base64 32`),
   `BETTER_AUTH_URL=https://<domain>`, `ALLOWED_EMAILS`.
3. Deploy, then **create your account immediately** (the first allowlisted sign-up wins).
4. Run `scripts/security-probe.mjs` against the https URL; all checks must pass, including the https-only ones.
5. Connect the agent; check the consent screen shows its name and `claude.ai` (no red warning).
6. Afterwards: review `/tokens` (connected agents, tokens) and the change history now and then; rotate
   `BETTER_AUTH_SECRET` if it may have leaked (signs everyone out).
