#!/usr/bin/env -S npx tsx
/**
 * finance CLI
 *
 *   finance migrate                                   schema + migrations, roles, auth tables
 *                                                     (ADMIN_DATABASE_URL; roles from DATABASE_URL and AUTH_DATABASE_URL)
 *   finance user:create <email> [display name]        create a user, print its id    (ADMIN_DATABASE_URL)
 *   finance import --user <id> [--dry-run] [--force] <files...>                       (DATABASE_URL)
 *   finance forecast --user <id> [--month YYYY-MM]    totals per currency and per tag (DATABASE_URL)
 *   finance review --user <id>                        rows waiting for an answer      (DATABASE_URL)
 *   finance apply --user <id> <file.sql>              run a SQL file as that user     (DATABASE_URL)
 *                                                     (answers, rules, fixed expenses: learn_merchant, ...)
 *
 * DATABASE_URL must connect as the app role (not a superuser), so row-level security applies.
 * ADMIN_DATABASE_URL is only for schema changes and user creation.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { migrate } from './core/migrate.ts';
import { importFile, type Db } from './importer.ts';
import { parseFile } from './parsers/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    user: { type: 'string' },
    month: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});
const [command, ...args] = positionals;

async function connect(envVar: 'DATABASE_URL' | 'ADMIN_DATABASE_URL'): Promise<pg.Client> {
  const url = process.env[envVar];
  if (!url) throw new Error(`${envVar} is not set`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Run fn with app.user_id set for the session's transaction. */
async function asUser<T>(db: Db, userId: string, fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query(`select set_config('app.user_id', $1, true)`, [userId]);
    const r = await fn();
    await db.query('commit');
    return r;
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}

const requireUser = (): string => {
  if (!opts.user || !/^[0-9a-f-]{36}$/i.test(opts.user)) throw new Error('--user <uuid> is required');
  return opts.user;
};

const fmt = (n: number | string) => Number(n).toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  switch (command) {
    case 'migrate': {
      await migrate();
      if (process.env.AUTH_DATABASE_URL) {
        const { auth } = await import('../lib/auth.ts');
        const { getMigrations } = await import('better-auth/db/migration');
        const m = await getMigrations(auth.options);
        const n = m.toBeCreated.length + m.toBeAdded.length + m.toBeAddedIndexes.length;
        if (n) await m.runMigrations();
        console.log(`  auth tables: ${n ? `${n} change(s) applied` : 'up to date'}`);
        await (auth.options.database as { end(): Promise<void> }).end();
      }
      console.log('Migrated.');
      process.exit(0);
    }

    case 'user:create': {
      const [email, ...name] = args;
      if (!email) throw new Error('usage: finance user:create <email> [display name]');
      const db = await connect('ADMIN_DATABASE_URL');
      const r = await db.query(`insert into users (email, display_name) values ($1, $2) returning id`, [email, name.join(' ') || null]);
      console.log(r.rows[0].id);
      await db.end();
      break;
    }

    case 'import': {
      if (!args.length) throw new Error('usage: finance import --user <id> [--dry-run] [--force] <files...>');
      const parsed = args.map(parseFile);
      for (const f of parsed) {
        const s = f.statement;
        console.log(`\n${f.fileName} → ${s.account.name} (${s.transactions.length} rows)`);
        for (const c of s.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
      }
      if (opts['dry-run']) break;

      const userId = requireUser();
      const db = await connect('DATABASE_URL');
      try {
        for (const f of parsed) {
          const r = await importFile(db, userId, f, { force: opts.force });
          console.log(`\n${r.file}: ${r.status}`);
          if (r.status === 'rejected') {
            r.failedChecks.forEach((c) => console.log(`  ✗ ${c}`));
            console.log('  Not imported. Re-download the export, or use --force if you are sure.');
            continue;
          }
          if (r.status !== 'imported') continue;
          console.log(`  ${r.inserted} new, ${r.duplicates} already present, ${r.installmentPlansCreated} new cuota plans, ${r.uncategorized} uncategorized`);
          for (const n of r.needsReview) console.log(`  ? #${n.id} ${n.postedOn} ${fmt(n.amount)} ${n.currency}  ${n.description}  — ${n.reason}`);
        }
      } finally {
        await db.end();
      }
      break;
    }

    case 'forecast': {
      const userId = requireUser();
      const month = `${opts.month ?? new Date(Date.now() + 31 * 864e5).toISOString().slice(0, 7)}-01`;
      const db = await connect('DATABASE_URL');
      await asUser(db, userId, async () => {
        const totals = await db.query(`select * from f_forecast_totals($1)`, [month]);
        console.log(`\nForecast ${month.slice(0, 7)}`);
        for (const t of totals.rows)
          console.log(`  ${t.currency}: ${fmt(t.expected)}  (range ${fmt(t.low)} – ${fmt(t.high)}; committed ${fmt(t.committed)}, variable ${fmt(t.variable)}, events ${fmt(t.events)})`);
        const byTag = await db.query(`select * from f_forecast_by_tag($1)`, [month]);
        if (byTag.rows.length) console.log('\n  By tag');
        for (const t of byTag.rows) console.log(`  ${t.tag.padEnd(12)} ${t.currency} ${fmt(t.expected)}`);
        const lines = await db.query(`select * from f_forecast($1) order by currency desc, component, expected desc`, [month]);
        console.log('\n  Lines');
        for (const l of lines.rows) console.log(`  ${l.component.padEnd(10)} ${l.currency} ${fmt(l.expected).padStart(12)}  ${l.label}  (${l.basis})`);
      });
      await db.end();
      break;
    }

    case 'apply': {
      const userId = requireUser();
      const [file] = args;
      if (!file) throw new Error('usage: finance apply --user <id> <file.sql>');
      const sql = readFileSync(file, 'utf8');
      const db = await connect('DATABASE_URL');
      // one transaction: either every statement in the file applies, or none does
      await asUser(db, userId, () => db.query(sql));
      console.log(`Applied ${file}`);
      await db.end();
      break;
    }

    case 'review': {
      const userId = requireUser();
      const db = await connect('DATABASE_URL');
      await asUser(db, userId, async () => {
        const r = await db.query(
          `select t.id, t.posted_on::text, t.amount, t.currency, t.description_raw, coalesce(t.review_reason, 'no category') as reason
           from transactions t
           where t.review_reason is not null
              or (t.category_id is null and t.kind not in ('card_payment','transfer','income','fx'))
           order by t.posted_on`,
        );
        for (const x of r.rows) console.log(`#${x.id} ${x.posted_on} ${fmt(x.amount).padStart(12)} ${x.currency}  ${x.description_raw}  — ${x.reason}`);
        console.log(`\n${r.rows.length} row(s) to review`);
      });
      await db.end();
      break;
    }

    default:
      console.log(
        readFileSync(fileURLToPath(import.meta.url), 'utf8')
          .split('*/')[0]
          .split('\n')
          .slice(2)
          .map((l) => l.replace(/^ \* ?/, ''))
          .join('\n'),
      );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
