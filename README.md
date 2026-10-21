# finance

Expense tracking and forecasting: import bank exports, learn categories/tags/commitments, forecast per currency (UYU, USD).
Multi-user from the start; isolation is enforced by Postgres row-level security.

## Setup

```bash
npm install                      # Node >= 20, Postgres >= 15
export ADMIN_DATABASE_URL=postgres://postgres@localhost/finance     # schema + user creation only
export DATABASE_URL=postgres://finance_app:...@localhost/finance    # app role, NOT a superuser

npx tsx src/cli.ts migrate
# then create the app role (grants at the end of db/schema.sql)
npx tsx src/cli.ts user:create you@example.com "Your Name"          # prints the user id
```

## Use

```bash
npx tsx src/cli.ts import --dry-run exports/*.xls                    # parse + reconcile only
npx tsx src/cli.ts import --user <id> exports/*.xls
npx tsx src/cli.ts review --user <id>                                # rows waiting for an answer
npx tsx src/cli.ts forecast --user <id> --month 2026-11
```

## Supported exports

| Source | Format | Reconciliation |
|---|---|---|
| Santander UY credit card (`CreditCardStatementMovementsMod`) | .xls | opening + movements = closing, per currency |
| Santander UY account (`AccountMovementsExtended`), UYU or USD | .xls | running balance on every row |

A file that fails reconciliation is rejected (override with `--force`). Re-importing a file, or an
overlapping export, never duplicates rows. Adding a bank = adding a `Parser` in `src/parsers/`.

## Layout

```
db/schema.sql          tables, views, forecast functions, RLS
src/parsers/           one parser per export format + shared helpers
src/importer.ts        loads a parsed statement for one user (rules, cuotas, dedupe)
src/cli.ts             command line
test/                  end-to-end tests on embedded Postgres (fixtures are gitignored: real data)
```

## Notes

- `xlsx` is installed from the SheetJS CDN (0.20.3): the npm registry only has 0.18.5, which has known
  vulnerabilities, and this app parses files uploaded by users.
- Card cuotas are booked in the statement month and become installment plans, so the remaining cuotas
  appear in the forecast.
