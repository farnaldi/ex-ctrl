/**
 * Recurring detection on a simulated history: the September Mastercard statement replayed as
 * July, August and September (fixtures are real exports, gitignored; skipped when absent).
 */
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import { importFile } from '../src/importer.ts';
import { parseFile } from '../src/parsers/index.ts';

const master = join(import.meta.dirname, 'fixtures', '2026-09-santander-master.xls');

describe('recurring detection', { skip: !existsSync(master) && 'fixtures missing' }, () => {
  let db: PGlite;
  let user: string;

  before(async () => {
    db = new PGlite({ extensions: { pg_trgm } });
    await db.exec(readFileSync(join(import.meta.dirname, '../db/schema.sql'), 'utf8'));
    user = (await db.query<{ id: string }>(`insert into users (email) values ('u@example.com') returning id`)).rows[0].id;
    await db.exec(`create role finance_app; grant usage on schema public to finance_app;
      grant select, insert, update, delete on all tables in schema public to finance_app;
      grant usage on all sequences in schema public to finance_app;
      grant execute on all functions in schema public to finance_app; set role finance_app;`);

    // the same statement as three consecutive months (cuotas stripped: those are plans, not recurring merchants)
    for (const month of ['07', '08', '09']) {
      const f = parseFile(master);
      f.statement.transactions = f.statement.transactions
        .filter((t) => !t.installment)
        .map((t) => ({ ...t, periodMonth: `2026-${month}-01` }));
      const fingerprints = f.statement.transactions.map((_, i) => `${month}-${i}`);
      await importFile(db, user, { ...f, fileHash: `master-${month}`, fingerprints });
    }
  });

  const candidates = async () => {
    await db.query('begin');
    await db.query(`select set_config('app.user_id', $1, true)`, [user]);
    const r = await db.query<{ merchant: string; cadence: string; months_seen: number; amount_pattern: string; typical_amount: string }>(
      `select merchant, cadence, months_seen, amount_pattern, typical_amount::text from v_recurring_candidates`,
    );
    await db.query('commit');
    return r.rows;
  };

  test('finds monthly bills seen in every month', async () => {
    const rows = await candidates();
    const ute = rows.find((r) => r.merchant === 'UTE');
    assert.deepEqual(ute, { merchant: 'UTE', cadence: 'monthly', months_seen: 3, amount_pattern: 'fixed amount', typical_amount: '8944.00' });
    for (const m of ['OSE', 'ANTEL Fijo', 'Anthropic Claude Sub']) assert.ok(rows.some((r) => r.merchant === m), m);
  });

  test('once a commitment covers a merchant, it leaves the candidates', async () => {
    await db.query('begin');
    await db.query(`select set_config('app.user_id', $1, true)`, [user]);
    await db.query(`select learn_merchant('^Ute$', 'UTE', 'Luz', 'fixed', p_match_type => 'regex')`);
    await db.query(`select add_fixed_expense('UTE', 8944, 'UYU', 'Luz', p_start => '2026-07-01', p_off_statement => false, p_merchant => 'UTE', p_tolerance => 0.3)`);
    await db.query(`select link_commitments()`);
    await db.query('commit');
    assert.ok(!(await candidates()).some((r) => r.merchant === 'UTE'));
  });
});
