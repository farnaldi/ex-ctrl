/**
 * Domain layer + MCP server against a real Postgres (needs TEST_ADMIN_DATABASE_URL, e.g.
 * postgres://postgres@localhost:5432/postgres). Creates a throwaway database, migrates it, and checks:
 * import, queries, rules, "who decided", audit + undo, RLS isolation, manual rows, forecast, MCP tools.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import * as XLSX from 'xlsx';

const ADMIN = process.env.TEST_ADMIN_DATABASE_URL;
const skip = ADMIN ? false : 'TEST_ADMIN_DATABASE_URL not set';

const dbName = `finance_test_${randomUUID().slice(0, 8)}`;
const userA = randomUUID();
const userB = randomUUID();
const A = { userId: userA, actor: 'user' as const, source: 'web' as const };
const agentA = { userId: userA, actor: 'claude' as const, source: 'mcp' as const };
const B = { userId: userB, actor: 'user' as const, source: 'web' as const };

function itauStatement(account = '1234567'): Buffer {
  const grid: (string | number)[][] = [
    [], [], [],
    ['', 'Nombre', '', '', 'Tipo de cuenta', 'Moneda', 'Nro de cuenta'],
    ['', 'PEREZ JUAN', '', '', 'Caja de Ahorro', 'Pesos', account],
    [],
    ['', 'Fecha', 'Concepto', '', 'Débito', 'Crédito', 'Saldo', 'Referencia', 'Destino'],
    ['', '30/01/2026', 'SALDO ANTERIOR', '', '', '', 10000],
    ['', '02/02/2026', 'COMPRA ANCAP 123', '', 500, '', 9500],
    ['', '03/02/2026', 'COMPRA PANADERIA LA ESPIGA', '', 300, '', 9200],
    ['', '05/02/2026', 'COMPRA PANADERIA LA ESPIGA', '', 200, '', 9000],
    ['', '12/02/2026', 'DEB. VARIOS PAGO D.G.I.', '', 4000, '', 5000],
    ['', '15/02/2026', 'RETIRO BRED 999', '', 1000, '', 4000],
    ['', '', 'SALDO FINAL', '', '', '', 4000],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), 'Estado de Cuenta');
  return XLSX.write(wb, { type: 'buffer', bookType: 'biff8' });
}

describe('app: domain layer and MCP', { skip }, () => {
  let F: typeof import('../src/core/finance.ts');
  let admin: pg.Client;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`create database ${dbName}`);
    await root.end();
    const url = (user: string, pass: string) => {
      const u = new URL(ADMIN!);
      u.username = user;
      u.password = pass;
      u.pathname = `/${dbName}`;
      return u.toString();
    };
    const adminUrl = new URL(ADMIN!);
    adminUrl.pathname = `/${dbName}`;
    process.env.ADMIN_DATABASE_URL = adminUrl.toString();
    process.env.DATABASE_URL = url('finance_app', 'test-app-password');
    delete process.env.AUTH_DATABASE_URL;
    const { migrate } = await import('../src/core/migrate.ts');
    await migrate(() => {});
    admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`insert into users (id, email) values ($1, 'a@example.com'), ($2, 'b@example.com')`, [userA, userB]);
    F = await import('../src/core/finance.ts');
  });

  after(async () => {
    if (!ADMIN) return;
    const { pool } = await import('../src/core/db.ts');
    await pool().end();
    await admin.end();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`drop database if exists ${dbName} with (force)`);
    await root.end();
  });

  test('app role is not a superuser and cannot erase history', async () => {
    const r = await admin.query(`select rolsuper, rolbypassrls from pg_roles where rolname = 'finance_app'`);
    assert.deepEqual(r.rows[0], { rolsuper: false, rolbypassrls: false });
    const priv = await admin.query(`select has_table_privilege('finance_app', 'audit_log', 'delete') as d`);
    assert.equal(priv.rows[0].d, false);
  });

  test('import through the web is one audited operation; re-import is a no-op', async () => {
    const r = await F.importExport(A, 'itau-feb.xls', itauStatement());
    assert.equal(r.status, 'imported');
    assert.equal(r.inserted, 5);
    const again = await F.importExport(A, 'itau-feb.xls', itauStatement());
    assert.equal(again.status, 'already_imported');
    const ops = await F.listOperations(A);
    assert.equal(ops[0].operation, 'import itau-feb.xls');
    assert.equal(ops[0].actor, 'user');
  });

  test('queries: filters, totals per currency, summary by category', async () => {
    const all = await F.listTransactions(A, { from: '2026-02', to: '2026-02' });
    assert.equal(all.count, 5);
    const bakery = await F.listTransactions(A, { text: 'espiga' });
    assert.equal(bakery.count, 2);
    assert.equal(bakery.totals[0].net, 500);
    const s = await F.spendSummary(A, { group_by: 'category' });
    assert.ok(s.totals.find((t: { currency: string }) => t.currency === 'UYU'));
  });

  test('agent rule: applies to past rows, recorded as claude, undoable as a unit', async () => {
    const r = await F.learnRule(agentA, { pattern: 'PANADERIA', merchant: 'Panaderías', category: 'Panadería', tags: ['casa'] });
    assert.equal(r.transactions_updated, 2);
    const rows = await F.listTransactions(A, { category: 'Panadería' });
    assert.equal(rows.count, 2);
    assert.ok(rows.transactions.every((t: { categorized_by: string; tags: string[] }) => t.categorized_by === 'claude' && t.tags.includes('casa')));
    const rule = (await F.listRules(A, 'PANADERIA'))[0];
    assert.equal(rule.source, 'claude');
    const byTag = await F.listTransactions(A, { tag: 'casa' });
    assert.equal(byTag.count, 2);

    const undone = await F.undo(A, r.op_id);
    assert.ok(undone.rows_reverted > 0);
    assert.equal((await F.listTransactions(A, { category: 'Panadería' })).count, 0);
    assert.equal((await F.listRules(A, 'PANADERIA')).length, 0);
    assert.equal((await F.listTransactions(A, { tag: 'casa' })).count, 0);
    await assert.rejects(F.undo(A, r.op_id), /already undone/);
    // undo the undo = redo
    await F.undo(A, undone.op_id);
    assert.equal((await F.listTransactions(A, { category: 'Panadería' })).count, 2);
  });

  test('undo refuses to overwrite a later change', async () => {
    const t = (await F.listTransactions(A, { text: 'ANCAP' })).transactions[0];
    const first = await F.categorize(A, { transaction_id: t.id, category: 'Combustible' });
    await F.updateTransaction(A, { transaction_id: t.id, note: 'nafta' });
    await assert.rejects(F.undo(A, first.op_id), /changed after this operation/);
  });

  test('row-level security: another user sees and undoes nothing', async () => {
    assert.equal((await F.listTransactions(B, {})).count, 0);
    assert.equal((await F.listOperations(B)).length, 0);
    const opOfA = (await F.listOperations(A))[0].op_id;
    await assert.rejects(F.undo(B, opOfA), /not found/);
    const t = (await F.listTransactions(A, {})).transactions[0];
    await assert.rejects(F.categorize(B, { transaction_id: t.id, category: 'X' }), /not found/);
  });

  test('manual rows: add, one-off, delete; imported rows cannot be deleted', async () => {
    const m = await F.addManualTransaction(A, { date: '2026-02-20', description: 'Feria', amount: 800, currency: 'UYU', category: 'Supermercado', one_off: true });
    assert.equal(m.transaction.category, 'Supermercado');
    assert.equal((await F.listTransactions(A, { one_off: true })).count, 1);
    await F.deleteManualTransaction(A, m.transaction.id);
    const imported = (await F.listTransactions(A, { text: 'ANCAP' })).transactions[0];
    await assert.rejects(F.deleteManualTransaction(A, imported.id), /not a manual transaction/);
  });

  test('commitments and forecast', async () => {
    const c = await F.addFixedExpense(A, { description: 'DGI', amount: 4000, currency: 'UYU', category: 'Impuestos', merchant: 'DGI', start: '2026-01-01' });
    assert.ok(c.commitment_id);
    const list = await F.listCommitments(A);
    assert.equal(list.commitments.length, 1);
    const f = await F.forecast(A, '2026-03');
    assert.ok(f.lines.some((l: { component: string }) => l.component === 'commitment'));
    const q = await F.reviewQueue(A);
    assert.ok(Array.isArray(q.transactions));
  });

  test('undo of an import is blocked while later work references its rows', async () => {
    const imp = await F.importExport(A, 'itau-other.xls', itauStatement('7654321'));
    assert.equal(imp.status, 'imported');
    const t = (await F.listTransactions(A, { text: 'RETIRO', sort: 'date_desc' })).transactions.find((x: { account: string }) => x.account.includes('4321'));
    const tagged = await F.tagTransactions(A, { transaction_ids: [t.id], add: ['efectivo'] });
    await assert.rejects(F.undo(A, imp.op_id), /still has 1 row\(s\) in transaction_tags/);
    await F.undo(A, tagged.op_id);
    const u = await F.undo(A, imp.op_id);
    assert.ok(u.rows_reverted > 0);
    assert.equal((await F.listTransactions(A, { text: 'RETIRO' })).count, 1);
  });

  test('limit and offset are clamped', async () => {
    const r = await F.listTransactions(A, { limit: '5; drop table users' as unknown as number, offset: -3 });
    assert.equal(r.limit, 100);
    assert.equal(r.offset, 0);
  });

  test('MCP server: tools listed and callable as the agent', async () => {
    const { createMcpHandler } = await import('@modelcontextprotocol/server');
    const { buildMcpServer } = await import('../src/mcp/server.ts');
    const handler = createMcpHandler(() => buildMcpServer(agentA));
    const call = async (method: string, params: unknown) => {
      const r = await handler.fetch(
        new Request('http://localhost/api/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }),
      );
      const text = await r.text();
      const line = text.split('\n').find((l) => l.startsWith('data:'));
      return JSON.parse(line ? line.slice(5) : text);
    };
    const tools = await call('tools/list', {});
    assert.ok(tools.result.tools.length > 30);
    const res = await call('tools/call', { name: 'spend_summary', arguments: { group_by: 'merchant' } });
    assert.ok(!res.result.isError, res.result.content?.[0]?.text);
    const bad = await call('tools/call', { name: 'delete_manual_transaction', arguments: { transaction_id: 999999 } });
    assert.ok(bad.result.isError);
  });
});
