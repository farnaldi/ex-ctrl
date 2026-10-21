/**
 * End-to-end: parse the real September exports and import them into an embedded Postgres,
 * running as a non-superuser role so row-level security is enforced like in production.
 *
 * Fixtures are real bank exports (gitignored). Tests that need them are skipped when absent.
 */
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import { importFile } from '../src/importer.ts';
import { fingerprintAll, parseFile } from '../src/parsers/index.ts';
import { cents } from '../src/parsers/util.ts';

const fx = (n: string) => join(import.meta.dirname, 'fixtures', n);
const FILES = ['2026-09-santander-visa.xls', '2026-09-santander-master.xls', '2026-09-cc-uyu.xls', '2026-09-cc-usd.xls'].map(fx);
const haveFixtures = FILES.every(existsSync);
const NOT_SPEND = ['card_payment', 'transfer', 'income', 'fx'];

describe('parsers', { skip: !haveFixtures && 'fixtures missing' }, () => {
  test('every export reconciles to the cent', () => {
    for (const f of FILES) {
      const { statement } = parseFile(f);
      for (const c of statement.checks) assert.ok(c.ok, `${f}: ${c.name} — ${c.detail}`);
    }
  });

  test('fingerprints are unique within each file', () => {
    for (const f of FILES) {
      const { fingerprints } = parseFile(f);
      assert.equal(new Set(fingerprints).size, fingerprints.length);
    }
  });

  test('the same card row in two different statements gets two fingerprints (billed twice)', () => {
    const sep = parseFile(fx('2026-09-santander-visa.xls'));
    assert.deepEqual(parseFile(fx('2026-09-santander-visa.xls')).fingerprints, sep.fingerprints, 're-download must dedupe');
    const oct = { ...sep.statement, transactions: sep.statement.transactions.map((t) => ({ ...t, periodMonth: '2026-10-01' })) };
    const octFp = new Set(fingerprintAll(oct));
    assert.ok(sep.fingerprints.every((f) => !octFp.has(f)));
  });

  test('bank account rows dedupe across overlapping exports regardless of file', () => {
    const acc = parseFile(fx('2026-09-cc-uyu.xls'));
    const shifted = { ...acc.statement, periodStart: '2026-09-15' }; // a different download window, same rows
    assert.deepEqual(fingerprintAll(shifted), acc.fingerprints);
  });

  test('card cuotas are detected and booked in the statement month', () => {
    const { statement } = parseFile(fx('2026-09-santander-visa.xls'));
    const samsung = statement.transactions.find((t) => t.description.startsWith('Samsung Store'));
    assert.deepEqual(samsung?.installment, { number: 5, total: 6 });
    assert.equal(samsung?.postedOn, '2026-05-18');
    assert.equal(samsung?.periodMonth, '2026-09-01');
    assert.equal(samsung?.currency, 'USD');
  });

  test('card payments are recognized on both sides', () => {
    const card = parseFile(fx('2026-09-santander-visa.xls')).statement.transactions.filter((t) => t.kind === 'card_payment');
    const bank = parseFile(fx('2026-09-cc-uyu.xls')).statement.transactions.filter((t) => t.kind === 'card_payment');
    assert.ok(card.some((t) => t.amount === -45574.57));
    assert.ok(bank.some((t) => t.amount === 45574.57 && (t.raw as any).cardRef === '7740'));
  });
});

describe('import', { skip: !haveFixtures && 'fixtures missing' }, () => {
  let db: PGlite;
  let fran: string;
  let other: string;

  before(async () => {
    db = new PGlite({ extensions: { pg_trgm } });
    await db.exec(readFileSync(join(import.meta.dirname, '../db/schema.sql'), 'utf8'));
    fran = (await db.query<{ id: string }>(`insert into users (email) values ('fran@example.com') returning id`)).rows[0].id;
    other = (await db.query<{ id: string }>(`insert into users (email) values ('other@example.com') returning id`)).rows[0].id;
    await db.exec(`
      create role finance_app;
      grant usage on schema public to finance_app;
      grant select, insert, update, delete on all tables in schema public to finance_app;
      grant usage on all sequences in schema public to finance_app;
      grant execute on all functions in schema public to finance_app;
      set role finance_app;`);
  });

  const asUser = async <T>(userId: string, sql: string, params: unknown[] = []) => {
    await db.query('begin');
    await db.query(`select set_config('app.user_id', $1, true)`, [userId]);
    const r = await db.query<T>(sql, params);
    await db.query('commit');
    return r.rows;
  };

  test('imports all four files', async () => {
    let total = 0;
    for (const f of FILES) {
      const r = await importFile(db, fran, parseFile(f));
      assert.equal(r.status, 'imported', r.file);
      assert.equal(r.duplicates, 0);
      total += r.inserted;
    }
    assert.equal(total, 113);
  });

  test('re-importing the same file is a no-op', async () => {
    const r = await importFile(db, fran, parseFile(FILES[0]));
    assert.equal(r.status, 'already_imported');
  });

  test('an overlapping export (different file, same rows) adds nothing', async () => {
    const f = parseFile(FILES[0]);
    const r = await importFile(db, fran, { ...f, fileHash: 'different-download-of-same-period' });
    assert.equal(r.status, 'imported');
    assert.equal(r.inserted, 0);
    assert.equal(r.duplicates, 50);
  });

  test('September spending excludes card payments and income', async () => {
    const expected = { UYU: 0, USD: 0 } as Record<string, number>;
    for (const f of FILES)
      for (const t of parseFile(f).statement.transactions) if (!NOT_SPEND.includes(t.kind)) expected[t.currency] += cents(t.amount);

    const rows = await asUser<{ currency: string; total: string }>(
      fran,
      `select currency, sum(amount)::text as total from v_monthly_spend where month = '2026-09-01' group by currency`,
    );
    for (const r of rows) assert.equal(cents(Number(r.total)), expected[r.currency], r.currency);
  });

  test('cuotas become installment plans that feed the October forecast', async () => {
    const plans = await asUser<{ description: string; installments_total: number; start_date: string }>(
      fran,
      `select description, installments_total, start_date::text from commitments where kind = 'installment_plan' order by description`,
    );
    assert.equal(plans.length, 8);
    assert.deepEqual(
      plans.find((p) => p.description === 'Samsung Store'),
      { description: 'Samsung Store', installments_total: 6, start_date: '2026-05-01' },
    );

    const oct = await asUser<{ label: string; basis: string }>(fran, `select label, basis from f_forecast('2026-10-01') where component = 'commitment'`);
    const labels = oct.map((l) => `${l.label} ${l.basis.split(' ').pop()}`).sort();
    // plans that ended in September (Famaele 3/3, Toptecn 2/2) must not appear
    assert.deepEqual(labels, ['Bamboo Tiendam 3/3', 'Bookshop 2/2', 'Mercado 2/2', 'Samsung Store 6/6', 'Ticketm 3/3', 'Underar 4/4']);
  });

  test('learned rules apply on the next import', async () => {
    // teach: Buenas Migas is a bakery → Comida
    await asUser(
      fran,
      `with c as (insert into categories (name) values ('Comida') returning id),
            m as (insert into merchants (name, default_category_id, created_by) select 'Buenas Migas', id, 'user' from c returning id)
       insert into merchant_rules (pattern, match_type, merchant_id, source) select 'buenas migas', 'contains', id, 'user' from m`,
    );
    // a later export with a new Buenas Migas purchase (simulated by importing the UYU account as a new download)
    const f = parseFile(FILES[2]);
    f.statement.transactions = f.statement.transactions.map((t) => ({ ...t, postedOn: '2026-10-02', periodMonth: '2026-10-01' }));
    const r = await importFile(db, fran, { ...f, fileHash: 'october-sim', fingerprints: f.fingerprints.map((x) => `oct-${x}`) });
    assert.equal(r.status, 'imported');
    const rows = await asUser<{ n: number }>(
      fran,
      `select count(*)::int as n from transactions t join categories c on c.id = t.category_id
       where t.period_month = '2026-10-01' and c.name = 'Comida' and t.categorized_by = 'rule'`,
    );
    assert.equal(rows[0].n, 4); // four Buenas Migas debit purchases in the UYU account (Sep 2, 14, 15, 28)
  });

  test('learning an answer updates the past, links the commitment and changes the forecast', async () => {
    // before: the September "gastos comunes" payment is flagged for review and sits in the variable baseline
    const before = await asUser<{ review_reason: string | null }>(
      fran,
      `select review_reason from transactions where description_raw ilike '%GASTOS COMUNES%' and period_month = '2026-09-01'`,
    );
    assert.ok(before[0].review_reason);

    const [{ n }] = await asUser<{ n: number }>(
      fran,
      `select learn_merchant('GASTOS COMUNES', 'Gastos comunes', 'Gastos comunes', 'fixed', p_tags => array['apartment']) as n`,
    );
    assert.equal(n, 2); // September + the simulated October import

    await asUser(
      fran,
      `select add_fixed_expense('Gastos comunes', 576, 'UYU', 'Gastos comunes', p_day => 2, p_start => '2026-09-01',
                                p_off_statement => false, p_tags => array['apartment'], p_merchant => 'Gastos comunes', p_tolerance => 0.2)`,
    );
    const [{ linked }] = await asUser<{ linked: number }>(fran, `select link_commitments() as linked`);
    assert.equal(linked, 2);

    const rows = await asUser<{ review_reason: string | null; category: string; tags: string[]; commitment_id: number | null }>(
      fran,
      `select t.review_reason, c.name as category, ts.tags, t.commitment_id
       from transactions t join categories c on c.id = t.category_id left join v_tx_tag_set ts on ts.transaction_id = t.id
       where t.description_raw ilike '%GASTOS COMUNES%'`,
    );
    for (const r of rows) {
      assert.equal(r.review_reason, null);
      assert.equal(r.category, 'Gastos comunes');
      assert.deepEqual(r.tags, ['apartment']);
      assert.ok(r.commitment_id);
    }

    // forecast: it is now a commitment line tagged apartment, and gone from the baseline
    const nov = await asUser<{ component: string; label: string; tags: string[] }>(
      fran,
      `select component, label, tags from f_forecast('2026-11-01') where label ilike '%gastos comunes%'`,
    );
    assert.deepEqual(nov, [{ component: 'commitment', label: 'Gastos comunes', tags: ['apartment'] }]);
  });

  test('a rule can depend on the amount (same merchant, different meaning)', async () => {
    // September Visa has three Ancap Nielomar charges: 81, 104, 330
    await asUser(fran, `select learn_merchant('^Ancap', 'Ancap tienda', 'Snacks', 'variable', p_match_type => 'regex', p_amount_max => 150)`);
    const rows = await asUser<{ amount: string; category: string | null }>(
      fran,
      `select t.amount::text, c.name as category from transactions t left join categories c on c.id = t.category_id
       where t.description_raw = 'Ancap Nielomar Visa' and t.period_month = '2026-09-01' order by t.amount`,
    );
    assert.deepEqual(rows.map((r) => r.category), ['Snacks', 'Snacks', null]);
  });

  test('a commitment takes at most one payment per month; an extra charge stays variable', async () => {
    // September UYU account has 3 Buenas Migas-like debits? Use Santander fees: several per month on the UYU account.
    await asUser(fran, `select learn_merchant('^COMISION POR COSTO PRODUCTO', 'Costo cuenta', 'Comisiones bancarias', 'fixed', p_match_type => 'regex')`);
    await asUser(fran, `select add_fixed_expense('Costo cuenta', 1629.52, 'UYU', 'Comisiones bancarias', p_start => '2026-09-01',
                        p_off_statement => false, p_merchant => 'Costo cuenta', p_tolerance => 0.5)`);
    await asUser(fran, `select link_commitments()`);
    const rows = await asUser<{ amount: string; linked: boolean }>(
      fran,
      `select t.amount::text, t.commitment_id is not null as linked from transactions t
       where t.description_raw like 'COMISION POR COSTO PRODUCTO%' and t.period_month = '2026-09-01' order by t.amount`,
    );
    // two fees in September (647.74 and 1629.52): only the closest to the expected amount links
    assert.deepEqual(rows, [{ amount: '647.74', linked: false }, { amount: '1629.52', linked: true }]);
  });

  test('resolving a single transaction clears its flag without creating a rule', async () => {
    const [{ id }] = await asUser<{ id: number }>(
      fran,
      `select id from transactions where review_reason is not null and kind = 'income' order by id limit 1`,
    );
    const rulesBefore = (await asUser<{ n: number }>(fran, `select count(*)::int as n from merchant_rules`))[0].n;
    await asUser(fran, `select resolve_transaction($1, 'Ingresos varios', 'income', p_note => 'casual')`, [id]);
    const [t] = await asUser<{ review_reason: string | null; note: string }>(fran, `select review_reason, note from transactions where id = $1`, [id]);
    assert.equal(t.review_reason, null);
    assert.equal(t.note, 'casual');
    assert.equal((await asUser<{ n: number }>(fran, `select count(*)::int as n from merchant_rules`))[0].n, rulesBefore);
  });

  test("another user sees none of it", async () => {
    const n = await asUser<{ n: number }>(other, `select (select count(*) from transactions) + (select count(*) from accounts) + (select count(*) from commitments) as n`);
    assert.equal(Number(n[0].n), 0);
  });
});
