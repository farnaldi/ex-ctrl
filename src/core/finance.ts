/**
 * The finance domain: every read and write the web app and the MCP server can do.
 * Writes go through the SQL knowledge functions (learn_merchant, resolve_transaction, add_fixed_expense, ...)
 * so the UI, the agent and the knowledge file all follow the same rules.
 */
import { randomUUID } from 'node:crypto';
import type * as z from 'zod';
import { importStatement, type ImportResult } from '../importer.ts';
import { parseBuffer } from '../parsers/index.ts';
import { read, write, type Ctx, type Tx } from './db.ts';
import type * as S from './schemas.ts';

const SPEND_KINDS = `('purchase','refund','fee','interest','tax','loan_payment','cash_withdrawal')`;
const IS_SPENDING = `(t.kind in ${SPEND_KINDS} and coalesce(c.nature, 'variable') not in ('excluded','income','savings'))`;
const IS_ONE_OFF = `exists (select 1 from context_notes n where n.kind = 'one_off' and n.transaction_id = t.id)`;
const monthStart = (m: string) => `${m}-01`;

/** Collects SQL conditions and their parameters. */
class Where {
  conds: string[] = [];
  params: unknown[] = [];
  add(sql: string, ...values: unknown[]) {
    let s = sql;
    for (const v of values) {
      this.params.push(v);
      s = s.replace('?', `$${this.params.length}`);
    }
    this.conds.push(s);
  }
  get sql() {
    return this.conds.length ? `where ${this.conds.join(' and ')}` : '';
  }
}

function tagCondition(w: Where, tag: string) {
  w.add(
    `exists (select 1 from transaction_tags tt join v_tag_ancestors a on a.tag_id = tt.tag_id
             where tt.transaction_id = t.id and a.ancestor = lower(?))`,
    tag,
  );
}

// ============================================================ reads

export async function listTransactions(ctx: Ctx, f: S.TransactionFilter) {
  const w = new Where();
  if (f.from) w.add(`t.period_month >= ?::date`, monthStart(f.from));
  if (f.to) w.add(`t.period_month <= ?::date`, monthStart(f.to));
  if (f.currency) w.add(`t.currency = ?`, f.currency);
  if (f.account_id) w.add(`t.account_id = ?`, f.account_id);
  if (f.category) w.add(`lower(c.name) = lower(?)`, f.category);
  if (f.merchant) w.add(`lower(m.name) = lower(?)`, f.merchant);
  if (f.tag) tagCondition(w, f.tag);
  if (f.text) w.add(`(t.description_raw ilike ? or m.name ilike $${w.params.length + 1} or t.note ilike $${w.params.length + 1})`, `%${f.text}%`);
  if (f.kind) w.add(`t.kind = ?`, f.kind);
  if (f.spending_only) w.add(IS_SPENDING);
  if (f.uncategorized) w.add(`t.category_id is null and t.kind in ${SPEND_KINDS}`);
  if (f.needs_review) w.add(`t.review_reason is not null`);
  if (f.one_off === true) w.add(IS_ONE_OFF);
  if (f.one_off === false) w.add(`not ${IS_ONE_OFF}`);
  if (f.min_amount !== undefined) w.add(`t.amount >= ?`, f.min_amount);
  if (f.max_amount !== undefined) w.add(`t.amount <= ?`, f.max_amount);
  const order = {
    date_desc: 't.posted_on desc, t.id desc',
    date_asc: 't.posted_on, t.id',
    amount_desc: 't.amount desc, t.id',
    amount_asc: 't.amount, t.id',
  }[f.sort ?? 'date_desc'];
  // interpolated into the SQL below: always integers in range, whatever the caller sent
  const limit = Math.min(Math.max(Math.trunc(Number(f.limit ?? 100)) || 100, 1), 500);
  const offset = Math.max(Math.trunc(Number(f.offset ?? 0)) || 0, 0);

  const from = `from transactions t
    join accounts a on a.id = t.account_id
    left join categories c on c.id = t.category_id
    left join merchants m on m.id = t.merchant_id
    left join commitments cm on cm.id = t.commitment_id`;

  return read(ctx, async (db) => {
    const rows = await db.query(
      `select t.id, t.posted_on, to_char(t.period_month, 'YYYY-MM') as month, t.description_raw as description,
              t.amount, t.currency, t.kind, a.id as account_id, a.name as account, m.name as merchant,
              c.name as category, c.nature, t.categorized_by, t.note, t.review_reason,
              t.installment_number, t.installment_total, t.commitment_id, cm.description as commitment,
              coalesce((select array_agg(g.name order by g.name) from transaction_tags tt join tags g on g.id = tt.tag_id
                        where tt.transaction_id = t.id), '{}') as tags,
              ${IS_SPENDING} as is_spending,
              ${IS_ONE_OFF} as one_off
       ${from} ${w.sql}
       order by ${order}
       limit ${limit} offset ${offset}`,
      w.params,
    );
    const totals = await db.query(
      `select t.currency, count(*)::int as count, sum(t.amount) as net,
              coalesce(sum(t.amount) filter (where ${IS_SPENDING}), 0) as spending
       ${from} ${w.sql} group by t.currency order by t.currency desc`,
      w.params,
    );
    const count = totals.rows.reduce((n, r) => n + r.count, 0);
    return { count, limit, offset, totals: totals.rows, transactions: rows.rows };
  });
}

export async function getTransaction(ctx: Ctx, id: number) {
  return read(ctx, async (db) => {
    const r = await db.query(
      `select t.*, to_char(t.period_month, 'YYYY-MM') as month, a.name as account, c.name as category, c.nature,
              m.name as merchant, cm.description as commitment,
              coalesce((select json_agg(json_build_object('tag', g.name, 'tagged_by', tt.tagged_by) order by g.name)
                        from transaction_tags tt join tags g on g.id = tt.tag_id where tt.transaction_id = t.id), '[]') as tags,
              ${IS_SPENDING} as is_spending, ${IS_ONE_OFF} as one_off
       from transactions t join accounts a on a.id = t.account_id
       left join categories c on c.id = t.category_id left join merchants m on m.id = t.merchant_id
       left join commitments cm on cm.id = t.commitment_id
       where t.id = $1`,
      [id],
    );
    if (!r.rows.length) throw new Error(`transaction ${id} not found`);
    const history = await db.query(
      `select l.op_id, l.at, l.actor, l.source, l.operation, l.op, l.before, l.after, l.undone_by
       from audit_log l where l.table_name = 'transactions' and l.row_key = jsonb_build_object('id', $1::bigint)
       order by l.id desc limit 20`,
      [id],
    );
    return { ...r.rows[0], history: history.rows };
  });
}

/** Spending totals (never mixes currencies). Tag totals roll up to parent tags and can overlap. */
export async function spendSummary(ctx: Ctx, s: S.SpendSummary) {
  const w = new Where();
  w.add(IS_SPENDING);
  if (s.from) w.add(`t.period_month >= ?::date`, monthStart(s.from));
  if (s.to) w.add(`t.period_month <= ?::date`, monthStart(s.to));
  if (s.currency) w.add(`t.currency = ?`, s.currency);
  if (s.category) w.add(`lower(c.name) = lower(?)`, s.category);
  if (s.tag) tagCondition(w, s.tag);
  if (s.exclude_one_off) w.add(`not ${IS_ONE_OFF}`);

  const group = {
    category: `coalesce(c.name, '(sin categoría)')`,
    merchant: `coalesce(m.name, '(sin comercio)')`,
    account: `a.name`,
    nature: `coalesce(c.nature, 'variable')`,
    month: `to_char(t.period_month, 'YYYY-MM')`,
    tag: `coalesce(tg.ancestor, '(sin tag)')`,
  }[s.group_by];
  const tagJoin =
    s.group_by === 'tag'
      ? `left join (select distinct tt.transaction_id, an.ancestor from transaction_tags tt
                    join v_tag_ancestors an on an.tag_id = tt.tag_id) tg on tg.transaction_id = t.id`
      : '';
  const monthCol = s.by_month && s.group_by !== 'month' ? `, to_char(t.period_month, 'YYYY-MM') as month` : '';
  const monthGroup = monthCol ? ', month' : '';

  return read(ctx, async (db) => {
    const r = await db.query(
      `select ${group} as "group"${monthCol}, t.currency, sum(t.amount) as amount, count(distinct t.id)::int as count
       from transactions t
       join accounts a on a.id = t.account_id
       left join categories c on c.id = t.category_id
       left join merchants m on m.id = t.merchant_id
       ${tagJoin}
       ${w.sql}
       group by "group"${monthGroup}, t.currency
       order by t.currency desc, ${s.group_by === 'month' ? '"group"' : 'amount desc'}${monthGroup}`,
      w.params,
    );
    const totals = await db.query(
      `select t.currency, sum(t.amount) as amount, count(*)::int as count
       from transactions t join accounts a on a.id = t.account_id
       left join categories c on c.id = t.category_id left join merchants m on m.id = t.merchant_id
       ${w.sql} group by t.currency order by t.currency desc`,
      w.params,
    );
    return {
      note: s.group_by === 'tag' ? 'Tag totals roll up to parent tags and can overlap; currency totals never double count.' : undefined,
      totals: totals.rows,
      rows: r.rows,
    };
  });
}

export async function listAccounts(ctx: Ctx) {
  return read(ctx, async (db) =>
    (
      await db.query(
        `select a.id, a.name, a.kind, a.issuer, a.last4, a.default_currency, a.active,
                (select count(*)::int from transactions t where t.account_id = a.id) as transactions,
                (select to_char(max(t.period_month), 'YYYY-MM') from transactions t where t.account_id = a.id) as last_month,
                (select max(b.imported_at) from import_batches b where b.account_id = a.id) as last_import
         from accounts a order by a.name`,
      )
    ).rows,
  );
}

export async function listCategories(ctx: Ctx) {
  return read(ctx, async (db) =>
    (
      await db.query(
        `select c.id, c.name, c.nature, p.name as parent,
                (select count(*)::int from transactions t where t.category_id = c.id) as transactions,
                (select count(*)::int from merchant_rules r where r.category_id = c.id) as rules
         from categories c left join categories p on p.id = c.parent_id
         order by c.nature, c.name`,
      )
    ).rows,
  );
}

export async function listTags(ctx: Ctx) {
  return read(ctx, async (db) =>
    (
      await db.query(
        `select g.id, g.name, p.name as parent, g.archived, g.notes,
                (select count(*)::int from transaction_tags tt where tt.tag_id = g.id) as transactions,
                (select count(*)::int from commitment_tags ct where ct.tag_id = g.id) as commitments
         from tags g left join tags p on p.id = g.parent_id
         order by coalesce(p.name, g.name), g.parent_id nulls first, g.name`,
      )
    ).rows,
  );
}

export async function listMerchants(ctx: Ctx, search?: string) {
  return read(ctx, async (db) =>
    (
      await db.query(
        `select m.id, m.name, c.name as default_category, m.notes,
                coalesce((select array_agg(g.name order by g.name) from merchant_tags mt join tags g on g.id = mt.tag_id
                          where mt.merchant_id = m.id), '{}') as tags,
                (select count(*)::int from transactions t where t.merchant_id = m.id) as transactions
         from merchants m left join categories c on c.id = m.default_category_id
         where $1::text is null or m.name ilike '%' || $1 || '%'
         order by transactions desc, m.name limit 200`,
        [search ?? null],
      )
    ).rows,
  );
}

export async function listRules(ctx: Ctx, search?: string) {
  return read(ctx, async (db) =>
    (
      await db.query(
        `select r.id, r.pattern, r.match_type, r.priority, m.name as merchant, c.name as category, r.kind,
                r.amount_min, r.amount_max, a.name as account, r.source, r.hits,
                coalesce((select array_agg(g.name order by g.name) from merchant_tags mt join tags g on g.id = mt.tag_id
                          where mt.merchant_id = r.merchant_id), '{}') as merchant_tags
         from merchant_rules r join merchants m on m.id = r.merchant_id
         left join categories c on c.id = r.category_id left join accounts a on a.id = r.account_id
         where $1::text is null or r.pattern ilike '%' || $1 || '%' or m.name ilike '%' || $1 || '%' or c.name ilike '%' || $1 || '%'
         order by r.priority, m.name, r.id`,
        [search ?? null],
      )
    ).rows,
  );
}

export async function listCommitments(ctx: Ctx, opts: { status?: 'active' | 'ended' | 'cancelled' | 'all' } = {}) {
  return read(ctx, async (db) => {
    const rows = await db.query(
      `select c.id, c.kind, c.loan_kind, c.description, c.currency, c.expected_amount, c.amount_tolerance as tolerance,
              c.every_n_months, c.expected_day, c.start_date, c.end_date, c.installments_total, c.off_statement,
              c.status, c.confirmed, c.detected_by, c.notes, m.name as merchant, cat.name as category, a.name as account,
              coalesce((select array_agg(g.name order by g.name) from commitment_tags ct join tags g on g.id = ct.tag_id
                        where ct.commitment_id = c.id), '{}') as tags,
              (select count(*)::int from transactions t where t.commitment_id = c.id) as payments,
              (select to_char(max(t.period_month), 'YYYY-MM') from transactions t where t.commitment_id = c.id) as last_paid_month,
              (select to_char(min(s.due_month), 'YYYY-MM') from v_commitment_schedule s where s.commitment_id = c.id) as next_due_month
       from commitments c
       left join merchants m on m.id = c.merchant_id
       left join categories cat on cat.id = c.category_id
       left join accounts a on a.id = c.account_id
       where $1 = 'all' or c.status = $1
       order by c.currency desc, c.kind, c.description`,
      [opts.status ?? 'active'],
    );
    const loans = await db.query(`select * from v_loan_status order by description`);
    return { commitments: rows.rows, loans: loans.rows };
  });
}

/** Missed occurrences: past months with no payment linked. */
export async function commitmentGaps(ctx: Ctx) {
  return read(ctx, async (db) =>
    (await db.query(`select commitment_id, description, to_char(due_month, 'YYYY-MM') as month from v_commitment_gaps order by due_month, description`))
      .rows,
  );
}

export async function forecast(ctx: Ctx, month: string, lookback = 3) {
  return read(ctx, async (db) => {
    const m = monthStart(month);
    const totals = await db.query(`select * from f_forecast_totals($1, $2) order by currency desc`, [m, lookback]);
    const byTag = await db.query(`select * from f_forecast_by_tag($1, $2) order by currency desc, expected desc`, [m, lookback]);
    const lines = await db.query(`select * from f_forecast($1, $2) order by currency desc, component, expected desc`, [m, lookback]);
    return { month, lookback, totals: totals.rows, by_tag: byTag.rows, lines: lines.rows };
  });
}

export async function forecastAccuracy(ctx: Ctx) {
  return read(ctx, async (db) =>
    (await db.query(`select to_char(month, 'YYYY-MM') as month, currency, low, expected, high, actual, actual_one_off,
                            diff_excl_one_off, diff_excl_one_off_pct, within_range
                     from v_forecast_accuracy order by month, currency desc`)).rows,
  );
}

/** Spending per month and currency, plus how much of it was committed (fixed) vs variable. */
export async function monthlyTotals(ctx: Ctx, opts: { from?: string; to?: string } = {}) {
  return read(ctx, async (db) =>
    (
      await db.query(
        `select to_char(t.period_month, 'YYYY-MM') as month, t.currency,
                sum(t.amount) as spending,
                coalesce(sum(t.amount) filter (where t.commitment_id is not null), 0) as committed,
                coalesce(sum(t.amount) filter (where exists (select 1 from context_notes n where n.kind = 'one_off' and n.transaction_id = t.id)), 0) as one_off,
                count(*)::int as count
         from v_spend_tx t
         where ($1::date is null or t.period_month >= $1::date) and ($2::date is null or t.period_month <= $2::date)
         group by 1, 2 order by 1, 2 desc`,
        [opts.from ? monthStart(opts.from) : null, opts.to ? monthStart(opts.to) : null],
      )
    ).rows,
  );
}

/** What needs an answer: importer flags, uncategorized spending, missed commitments, open anomalies. */
export async function reviewQueue(ctx: Ctx) {
  return read(ctx, async (db) => {
    const flagged = await db.query(
      `select t.id, t.posted_on, t.amount, t.currency, t.description_raw as description, a.name as account,
              coalesce(t.review_reason, 'sin categoría') as reason
       from transactions t join accounts a on a.id = t.account_id
       left join categories c on c.id = t.category_id
       where t.review_reason is not null or (t.category_id is null and t.kind in ${SPEND_KINDS})
       order by t.posted_on desc`,
    );
    const gaps = await db.query(
      `select g.commitment_id, g.description, to_char(g.due_month, 'YYYY-MM') as month
       from v_commitment_gaps g join commitments c on c.id = g.commitment_id
       where not c.off_statement and g.due_month >= date_trunc('month', current_date) - interval '3 months'
       order by g.due_month desc`,
    );
    const anomalies = await db.query(
      `select id, kind, severity, transaction_id, commitment_id, to_char(period, 'YYYY-MM') as month, explanation
       from anomalies where status = 'open' order by detected_at desc`,
    );
    return { transactions: flagged.rows, missed_commitments: gaps.rows, anomalies: anomalies.rows };
  });
}

export async function recurringCandidates(ctx: Ctx) {
  return read(ctx, async (db) => (await db.query(`select * from v_recurring_candidates where not has_commitment and still_active`)).rows);
}

export async function listNotes(ctx: Ctx) {
  return read(ctx, async (db) =>
    (
      await db.query(
        `select n.id, n.kind, n.title, n.body, n.starts_on, n.ends_on, n.amount_estimate, n.currency, c.name as category,
                n.transaction_id,
                coalesce((select array_agg(g.name order by g.name) from context_note_tags nt join tags g on g.id = nt.tag_id
                          where nt.context_note_id = n.id), '{}') as tags
         from context_notes n left join categories c on c.id = n.category_id
         where n.kind <> 'one_off' order by coalesce(n.starts_on, n.created_at::date) desc`,
      )
    ).rows,
  );
}

/** Change history: one row per operation (web edit, agent tool call, import). */
export async function listOperations(ctx: Ctx, opts: { limit?: number; actor?: 'user' | 'claude' } = {}) {
  return read(ctx, async (db) =>
    (
      await db.query(
        `select * from v_operations where $1::text is null or actor = $1 order by at desc limit $2`,
        [opts.actor ?? null, Math.min(Math.max(Math.trunc(Number(opts.limit ?? 50)) || 50, 1), 200)],
      )
    ).rows,
  );
}

export async function getOperation(ctx: Ctx, opId: string) {
  return read(ctx, async (db) =>
    (
      await db.query(
        `select id, at, actor, source, operation, table_name, op, row_key, before, after, undone_by
         from audit_log where op_id = $1 order by id`,
        [opId],
      )
    ).rows,
  );
}

// ============================================================ writes

const ok = <T>(r: { result: T; opId: string }) => ({ ...r.result, op_id: r.opId });

async function setOneOff(db: Tx, txId: number, oneOff: boolean) {
  if (oneOff)
    await db.query(
      `insert into context_notes (kind, title, transaction_id)
       select 'one_off', coalesce(note, description_raw), id from transactions t
       where id = $1 and not exists (select 1 from context_notes n where n.kind = 'one_off' and n.transaction_id = t.id)`,
      [txId],
    );
  else await db.query(`delete from context_notes where kind = 'one_off' and transaction_id = $1`, [txId]);
}

async function changedTransaction(db: Tx, id: number) {
  return (
    await db.query(
      `select t.id, t.posted_on, t.description_raw as description, t.amount, t.currency, t.kind, c.name as category,
              m.name as merchant, t.note, t.categorized_by,
              coalesce((select array_agg(g.name order by g.name) from transaction_tags tt join tags g on g.id = tt.tag_id
                        where tt.transaction_id = t.id), '{}') as tags
       from transactions t left join categories c on c.id = t.category_id left join merchants m on m.id = t.merchant_id
       where t.id = $1`,
      [id],
    )
  ).rows[0];
}

/** One-time answer for one transaction (no rule). */
export async function categorize(ctx: Ctx, i: z.infer<typeof S.Categorize>) {
  return ok(
    await write(ctx, `categorize transaction ${i.transaction_id} as ${i.category}`, async (db) => {
      await db.query(`select resolve_transaction($1, $2, $3, $4, $5, $6, $7)`, [
        i.transaction_id, i.category, i.nature ?? 'variable', i.kind ?? null, i.tags ?? [], i.note ?? null, i.one_off ?? false,
      ]);
      return { transaction: await changedTransaction(db, i.transaction_id) };
    }),
  );
}

function checkRegex(pattern: string) {
  try {
    new RegExp(pattern, 'i');
  } catch (e) {
    throw new Error(`invalid regex for JavaScript: ${(e as Error).message}`);
  }
}

/** Rule: applies to every matching past transaction and to future imports. */
export async function learnRule(ctx: Ctx, i: z.infer<typeof S.LearnRule>) {
  const matchType = i.match_type ?? 'contains';
  if (matchType === 'regex') checkRegex(i.pattern);
  return ok(
    await write(ctx, `rule "${i.pattern}" → ${i.merchant}${i.category ? ` / ${i.category}` : ''}`, async (db) => {
      const r = await db.query<{ n: number }>(
        `select learn_merchant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as n`,
        [i.pattern, i.merchant, i.category ?? null, i.nature ?? 'variable', i.kind ?? null, i.tags ?? [], matchType,
         i.account_id ?? null, i.priority ?? 100, i.amount_min ?? null, i.amount_max ?? null],
      );
      const sample = await db.query(
        `select t.id, t.posted_on, t.description_raw as description, t.amount, t.currency
         from transactions t join merchants m on m.id = t.merchant_id
         where lower(m.name) = lower($1) order by t.posted_on desc limit 10`,
        [i.merchant],
      );
      return { transactions_updated: r.rows[0].n, sample: sample.rows };
    }),
  );
}

export async function updateTransaction(ctx: Ctx, i: z.infer<typeof S.UpdateTransaction>) {
  return ok(
    await write(ctx, `edit transaction ${i.transaction_id}`, async (db) => {
      const exists = await db.query(`select 1 from transactions where id = $1`, [i.transaction_id]);
      if (!exists.rows.length) throw new Error(`transaction ${i.transaction_id} not found`);
      const sets: string[] = [];
      const params: unknown[] = [i.transaction_id];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      if (i.category !== undefined)
        sets.push(i.category === null ? `category_id = null, categorized_by = null` : `category_id = f_category_id(${p(i.category)}, 'variable'), categorized_by = 'user', review_reason = null`);
      if (i.kind) sets.push(`kind = ${p(i.kind)}`);
      if (i.note !== undefined) sets.push(`note = ${p(i.note)}`);
      if (i.merchant !== undefined) sets.push(`merchant_id = ${i.merchant === null ? 'null' : `f_merchant_id(${p(i.merchant)})`}`);
      if (i.commitment_id !== undefined) sets.push(`commitment_id = ${p(i.commitment_id)}`);
      if (sets.length) await db.query(`update transactions set ${sets.join(', ')} where id = $1`, params);
      if (i.one_off !== undefined) await setOneOff(db, i.transaction_id, i.one_off);
      return { transaction: await changedTransaction(db, i.transaction_id) };
    }),
  );
}

export async function tagTransactions(ctx: Ctx, i: z.infer<typeof S.Tagging>) {
  const label = [i.add?.length ? `+${i.add.join(',')}` : '', i.remove?.length ? `-${i.remove.join(',')}` : ''].filter(Boolean).join(' ');
  return ok(
    await write(ctx, `tag ${i.transaction_ids.length} transaction(s) ${label}`, async (db) => {
      let added = 0;
      let removed = 0;
      if (i.add?.length)
        added = (
          await db.query(
            `insert into transaction_tags (transaction_id, tag_id, tagged_by)
             select t.id, f_tag_id(g), 'user' from transactions t, unnest($2::text[]) g where t.id = any($1::bigint[])
             on conflict do nothing returning 1`,
            [i.transaction_ids, i.add],
          )
        ).rows.length;
      if (i.remove?.length)
        removed = (
          await db.query(
            `delete from transaction_tags tt using tags g
             where g.id = tt.tag_id and tt.transaction_id = any($1::bigint[]) and g.name = any($2::text[]) returning 1`,
            [i.transaction_ids, i.remove],
          )
        ).rows.length;
      return { added, removed };
    }),
  );
}

/** A payment that isn't in any imported export (cash, another account). */
export async function addManualTransaction(ctx: Ctx, i: z.infer<typeof S.ManualTransaction>) {
  return ok(
    await write(ctx, `manual transaction: ${i.description}`, async (db) => {
      await db.query(`insert into accounts (name, kind) values ('Manual', 'manual') on conflict (user_id, name) do nothing`);
      const r = await db.query<{ id: number }>(
        `insert into transactions (account_id, posted_on, description_raw, amount, currency, kind, category_id, categorized_by,
                                   commitment_id, fingerprint, note)
         values ((select id from accounts where name = 'Manual'), $1, $2, $3, $4, $5,
                 f_category_id($6, $7), case when $6::text is null then null else 'user' end, $8, $9, $10)
         returning id`,
        [i.date, i.description, i.amount, i.currency, i.kind ?? (i.amount < 0 ? 'income' : 'purchase'), i.category ?? null,
         i.nature ?? 'variable', i.commitment_id ?? null, `manual:${randomUUID()}`, i.note ?? null],
      );
      const id = r.rows[0].id;
      if (i.tags?.length)
        await db.query(
          `insert into transaction_tags (transaction_id, tag_id, tagged_by) select $1, f_tag_id(g), 'user' from unnest($2::text[]) g on conflict do nothing`,
          [id, i.tags],
        );
      if (i.one_off) await setOneOff(db, id, true);
      return { transaction: await changedTransaction(db, id) };
    }),
  );
}

/** Only rows recorded by hand can be deleted; imported rows are facts (recategorize or exclude them instead). */
export async function deleteManualTransaction(ctx: Ctx, id: number) {
  return ok(
    await write(ctx, `delete manual transaction ${id}`, async (db) => {
      const r = await db.query(
        `select t.id from transactions t join accounts a on a.id = t.account_id where t.id = $1 and a.kind = 'manual'`,
        [id],
      );
      if (!r.rows.length) throw new Error(`transaction ${id} is not a manual transaction (imported rows can't be deleted)`);
      await db.query(`delete from context_notes where transaction_id = $1`, [id]);
      await db.query(`delete from transactions where id = $1`, [id]);
      return { deleted: id };
    }),
  );
}

export async function addFixedExpense(ctx: Ctx, i: z.infer<typeof S.FixedExpense>) {
  return ok(
    await write(ctx, `fixed expense: ${i.description}`, async (db) => {
      const r = await db.query<{ id: number }>(
        `select add_fixed_expense($1, $2, $3, $4, $5, coalesce($6::date, date_trunc('month', current_date)::date), $7, $8, $9, $10, $11, $12) as id`,
        [i.description, i.amount, i.currency, i.category ?? null, i.day ?? null, i.start ?? null, i.end ?? null,
         i.every_n_months ?? 1, i.off_statement ?? false, i.tags ?? [], i.merchant ?? null, i.tolerance ?? 0.05],
      );
      const linked = (await db.query<{ n: number }>(`select link_commitments() as n`)).rows[0].n;
      return { commitment_id: r.rows[0].id, payments_linked: linked };
    }),
  );
}

export async function addLoan(ctx: Ctx, i: z.infer<typeof S.Loan>) {
  return ok(
    await write(ctx, `loan: ${i.description}`, async (db) => {
      const r = await db.query<{ id: number }>(
        `select add_loan($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as id`,
        [i.description, i.loan_kind, i.principal, i.currency, i.annual_rate, i.term_months, i.first_payment, i.payment ?? null,
         i.category ?? 'Deudas', i.day ?? null, i.off_statement ?? true, i.tags ?? []],
      );
      const status = await db.query(`select * from v_loan_status where commitment_id = $1`, [r.rows[0].id]);
      return { commitment_id: r.rows[0].id, status: status.rows[0] };
    }),
  );
}

export async function updateCommitment(ctx: Ctx, i: z.infer<typeof S.UpdateCommitment>) {
  return ok(
    await write(ctx, `edit commitment ${i.commitment_id}`, async (db) => {
      const sets: string[] = [];
      const params: unknown[] = [i.commitment_id];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      if (i.description) sets.push(`description = ${p(i.description)}`);
      if (i.expected_amount !== undefined) sets.push(`expected_amount = ${p(i.expected_amount)}`);
      if (i.tolerance !== undefined) sets.push(`amount_tolerance = ${p(i.tolerance)}`);
      if (i.day !== undefined) sets.push(`expected_day = ${p(i.day)}`);
      if (i.start) sets.push(`start_date = ${p(i.start)}`);
      if (i.end !== undefined) sets.push(`end_date = ${p(i.end)}`);
      if (i.status) sets.push(`status = ${p(i.status)}`);
      if (i.category) sets.push(`category_id = f_category_id(${p(i.category)}, 'fixed')`);
      if (i.merchant !== undefined) sets.push(`merchant_id = ${i.merchant === null ? 'null' : `f_merchant_id(${p(i.merchant)})`}`);
      if (i.notes !== undefined) sets.push(`notes = ${p(i.notes)}`);
      if (sets.length) {
        const r = await db.query(`update commitments set ${sets.join(', ')}, confirmed = true where id = $1`, params);
        if (!r.rowCount) throw new Error(`commitment ${i.commitment_id} not found`);
      }
      if (i.add_tags?.length) await db.query(`select tag_commitment($1, variadic $2::text[])`, [i.commitment_id, i.add_tags]);
      if (i.remove_tags?.length)
        await db.query(
          `delete from commitment_tags ct using tags g where g.id = ct.tag_id and ct.commitment_id = $1 and g.name = any($2::text[])`,
          [i.commitment_id, i.remove_tags],
        );
      const linked = (await db.query<{ n: number }>(`select link_commitments() as n`)).rows[0].n;
      const c = await db.query(`select * from commitments where id = $1`, [i.commitment_id]);
      return { commitment: c.rows[0], payments_linked: linked };
    }),
  );
}

export async function addPlannedEvent(ctx: Ctx, i: z.infer<typeof S.PlannedEvent>) {
  return ok(
    await write(ctx, `planned ${i.kind ?? 'event'}: ${i.title}`, async (db) => {
      const r = await db.query<{ id: number }>(
        `insert into context_notes (kind, title, body, starts_on, ends_on, amount_estimate, currency, category_id)
         values ($1, $2, $3, $4, $5, $6, $7, f_category_id($8, 'variable')) returning id`,
        [i.kind ?? 'event', i.title, i.body ?? null, monthStart(i.start_month), i.end_month ? monthStart(i.end_month) : null,
         i.amount, i.currency, i.category ?? null],
      );
      if (i.tags?.length)
        await db.query(
          `insert into context_note_tags (context_note_id, tag_id) select $1, f_tag_id(g) from unnest($2::text[]) g on conflict do nothing`,
          [r.rows[0].id, i.tags],
        );
      return { note_id: r.rows[0].id };
    }),
  );
}

export async function deleteNote(ctx: Ctx, id: number) {
  return ok(
    await write(ctx, `delete note ${id}`, async (db) => {
      const r = await db.query(`delete from context_notes where id = $1 and kind <> 'one_off'`, [id]);
      if (!r.rowCount) throw new Error(`note ${id} not found`);
      return { deleted: id };
    }),
  );
}

export async function editTag(ctx: Ctx, i: z.infer<typeof S.TagEdit>) {
  return ok(
    await write(ctx, `tag ${i.name}`, async (db) => {
      const id = (await db.query<{ id: number }>(`select f_tag_id($1, $2) as id`, [i.name, i.parent ?? null])).rows[0].id;
      if (i.parent === null) await db.query(`update tags set parent_id = null where id = $1`, [id]);
      if (i.rename_to) await db.query(`update tags set name = $2 where id = $1`, [id, i.rename_to]);
      if (i.archived !== undefined) await db.query(`update tags set archived = $2 where id = $1`, [id, i.archived]);
      if (i.notes !== undefined) await db.query(`update tags set notes = $2 where id = $1`, [id, i.notes]);
      return { tag: (await db.query(`select * from tags where id = $1`, [id])).rows[0] };
    }),
  );
}

export async function editCategory(ctx: Ctx, i: z.infer<typeof S.CategoryEdit>) {
  return ok(
    await write(ctx, `category ${i.name}`, async (db) => {
      const id = (await db.query<{ id: number }>(`select f_category_id($1, $2) as id`, [i.name, i.nature ?? 'variable'])).rows[0].id;
      if (i.nature) await db.query(`update categories set nature = $2 where id = $1`, [id, i.nature]);
      if (i.parent !== undefined)
        await db.query(`update categories set parent_id = ${i.parent === null ? 'null' : `f_category_id($2, nature)`} where id = $1`,
          i.parent === null ? [id] : [id, i.parent]);
      if (i.rename_to) await db.query(`update categories set name = $2 where id = $1`, [id, i.rename_to]);
      return { category: (await db.query(`select * from categories where id = $1`, [id])).rows[0] };
    }),
  );
}

export async function deleteRule(ctx: Ctx, ruleId: number) {
  return ok(
    await write(ctx, `delete rule ${ruleId}`, async (db) => {
      const r = await db.query(`delete from merchant_rules where id = $1 returning pattern`, [ruleId]);
      if (!r.rowCount) throw new Error(`rule ${ruleId} not found`);
      return { deleted: ruleId, pattern: r.rows[0].pattern, note: 'Past transactions keep their category; future imports no longer use this rule.' };
    }),
  );
}

export async function importExport(ctx: Ctx, fileName: string, content: Buffer, opts: { force?: boolean } = {}) {
  const parsed = parseBuffer(content, fileName);
  const r = await write(ctx, `import ${fileName}`, async (db) => {
    const result: ImportResult = await importStatement(db, parsed, opts);
    // nothing written unless imported: roll back is implicit for rejected/duplicate (no writes happened)
    return { ...result, checks: parsed.statement.checks };
  });
  return ok(r);
}

export async function snapshotForecast(ctx: Ctx, month: string) {
  return ok(
    await write(ctx, `snapshot forecast ${month}`, async (db) => ({
      lines: (await db.query<{ n: number }>(`select f_snapshot_forecast($1) as n`, [monthStart(month)])).rows[0].n,
    })),
  );
}

export async function postOffStatement(ctx: Ctx, month: string) {
  return ok(
    await write(ctx, `post off-statement commitments ${month}`, async (db) => ({
      posted: (await db.query<{ n: number }>(`select f_post_off_statement($1) as n`, [monthStart(month)])).rows[0].n,
    })),
  );
}

export async function undo(ctx: Ctx, opId: string) {
  return ok(
    await write(ctx, `undo ${opId}`, async (db) => ({
      undone: opId,
      rows_reverted: (await db.query<{ n: number }>(`select undo_operation($1) as n`, [opId])).rows[0].n,
    })),
  );
}

export async function saveReview(ctx: Ctx, month: string, summaryMd: string) {
  return ok(
    await write(ctx, `monthly review ${month}`, async (db) => {
      await db.query(
        `insert into reviews (period, summary_md) values ($1, $2)
         on conflict (user_id, period) do update set summary_md = excluded.summary_md, created_at = now()`,
        [monthStart(month), summaryMd],
      );
      return { month };
    }),
  );
}

export async function getReview(ctx: Ctx, month?: string) {
  return read(ctx, async (db) =>
    (
      await db.query(
        `select to_char(period, 'YYYY-MM') as month, summary_md, created_at from reviews
         where $1::date is null or period = $1::date order by period desc limit 1`,
        [month ? monthStart(month) : null],
      )
    ).rows[0] ?? null,
  );
}
