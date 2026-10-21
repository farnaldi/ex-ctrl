# finance

Expense tracking and forecasting: import bank exports, learn categories/tags/commitments, forecast per currency (UYU, USD).
A web app to see and edit everything, and an MCP server so an agent (Claude) can load, edit and query the same data.
Multi-user from the start; isolation is enforced by Postgres row-level security.

## Architecture

```
Next.js app (one service)
├── /login, /consent, /           web UI (sign-in with Better Auth)
├── /api/auth/*                   Better Auth: sessions + OAuth 2.1 server for MCP clients
├── /.well-known/*                OAuth discovery (rewritten to /api/well-known/*)
└── /api/mcp                      MCP server (Streamable HTTP), bearer token from our own OAuth server
        │
        ▼
src/core/finance.ts               domain layer: every read/write, shared by web and MCP
src/core/db.ts                    one transaction per call with app.user_id (RLS), actor and op id (audit)
        │
        ▼
Postgres
├── public   finance data, RLS on every table          role from DATABASE_URL (no superuser, no bypassrls)
└── auth     Better Auth tables                        role from AUTH_DATABASE_URL (no access to public data)
```

- **Who decided**: writes from the MCP agent are recorded as `claude`, from the web as `user` (categorized_by, source, tagged_by...).
- **Audit + undo**: every web/MCP write is one operation in `audit_log` (before/after per row). `undo_operation(op_id)`
  reverts it, and refuses if a later operation changed the same rows. History can't be deleted by the app role.
- **Auth tables** use uuid ids equal to `public.users.id`; a new sign-up creates its `users` row. Sign-up is limited
  to `ALLOWED_EMAILS`.

## Environment

| Variable | What |
|---|---|
| `ADMIN_DATABASE_URL` | Database owner (Railway: `${{Postgres.DATABASE_URL}}`). Migrations only. |
| `DATABASE_URL` | App role, e.g. `postgres://finance_app:<pw>@host/db`. `migrate` creates the role with that password. |
| `AUTH_DATABASE_URL` | Auth role, e.g. `postgres://finance_auth:<pw>@host/db`. Must differ from the app role. |
| `BETTER_AUTH_URL` | Public URL of the app, e.g. `https://finanzas.up.railway.app` |
| `BETTER_AUTH_SECRET` | Long random string (`openssl rand -base64 32`) |
| `ALLOWED_EMAILS` | Comma-separated emails allowed to sign up |

## Local

```bash
npm install                 # Node >= 20, Postgres >= 15
cp .env.example .env        # fill in
npm run migrate             # schema + migrations, roles, auth tables (idempotent)
npm run dev                 # http://localhost:3000
npm test                    # parser tests; set TEST_ADMIN_DATABASE_URL to also run the app tests
```

CLI (bulk work, the knowledge file):

```bash
npx tsx src/cli.ts import --dry-run exports/*.xls
npx tsx src/cli.ts import --user <id> exports/*.xls
npx tsx src/cli.ts apply --user <id> private/fran-knowledge.sql
npx tsx src/cli.ts forecast --user <id> --month 2026-11
```

## Railway

1. New project → add PostgreSQL → add this repo as a service (builds the `Dockerfile`).
2. Service variables: the table above. `preDeployCommand` runs `npm run migrate` on every deploy.
3. Generate a domain; set `BETTER_AUTH_URL` to it. Health check: `/api/health`.
4. Open the app, create your account (email must be in `ALLOWED_EMAILS`).
5. In Claude: Settings → Connectors → Add custom connector → `https://<domain>/api/mcp`. Sign in and allow.

## Supported exports

| Source | Format | Reconciliation |
|---|---|---|
| Santander UY credit card (`CreditCardStatementMovementsMod`) | .xls | opening + movements = closing, per currency |
| Santander UY account (`AccountMovementsExtended`), UYU or USD | .xls | running balance on every row |
| Itaú UY account ("Estado de Cuenta"), UYU or USD | .xls | running balance on every row |

A file that fails reconciliation is rejected (override with `--force` / `force`). Re-importing a file, or an
overlapping export, never duplicates rows. Adding a bank = adding a `Parser` in `src/parsers/`.

## Notes

- `xlsx` is installed from the SheetJS CDN (0.20.3): the npm registry only has 0.18.5, which has known
  vulnerabilities, and this app parses files uploaded by users.
- No raw SQL tool over MCP on purpose: a query could call `set_config('app.user_id', …)` and read another
  user's rows. The agent gets structured tools (search, summaries by any dimension, forecast, history) instead.
