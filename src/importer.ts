/**
 * Loads a parsed statement into Postgres for one user.
 *
 * - Runs in one transaction with app.user_id set, so row-level security scopes every read and write.
 * - Idempotent: a file already imported (same hash) is skipped; rows already present (same fingerprint,
 *   e.g. from an overlapping export) are skipped.
 * - Applies what the system has learned: merchant_rules (merchant, category, kind, tags) and merchant
 *   default categories. Merchant/commitment tags are inherited by a database trigger.
 * - Card cuotas become installment_plan commitments, so remaining cuotas show up in the forecast.
 * - Rejects statements whose reconciliation checks fail (unless force), so a parser bug or a truncated
 *   export can't silently corrupt the numbers.
 */
import type { ParsedFile, ParsedTx } from './parsers/index.ts';

/** Minimal query interface: satisfied by pg Client/PoolClient and by PGlite. */
export interface Db {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface ImportResult {
  file: string;
  status: 'imported' | 'already_imported' | 'rejected';
  account: string;
  inserted: number;
  duplicates: number;
  installmentPlansCreated: number;
  uncategorized: number;
  needsReview: { id: number; postedOn: string; description: string; amount: number; currency: string; reason: string }[];
  failedChecks: string[];
}

interface RuleRow {
  id: number;
  pattern: string;
  match_type: 'exact' | 'prefix' | 'contains' | 'regex';
  account_id: number | null;
  merchant_id: number;
  category_id: number | null;
  kind: string | null;
  amount_min: string | null;
  amount_max: string | null;
  tag_ids: number[];
}

function ruleMatches(r: RuleRow, text: string, accountId: number, amount: number): boolean {
  if (r.account_id !== null && r.account_id !== accountId) return false;
  if (r.amount_min !== null && amount < Number(r.amount_min)) return false;
  if (r.amount_max !== null && amount > Number(r.amount_max)) return false;
  const t = text.toLowerCase();
  const p = r.pattern.toLowerCase();
  switch (r.match_type) {
    case 'exact':
      return t === p;
    case 'prefix':
      return t.startsWith(p);
    case 'contains':
      return t.includes(p);
    case 'regex':
      return new RegExp(r.pattern, 'i').test(text);
  }
}

/** First day of the month the plan started: statement month minus (cuota - 1). */
function planStart(tx: ParsedTx): string {
  const d = new Date(`${tx.periodMonth}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - (tx.installment!.number - 1));
  return d.toISOString().slice(0, 10);
}

export async function importFile(
  db: Db,
  userId: string,
  file: ParsedFile & { fingerprints: string[] },
  opts: { force?: boolean } = {},
): Promise<ImportResult> {
  await db.query('begin');
  try {
    await db.query(`select set_config('app.user_id', $1, true)`, [userId]);
    const result = await importStatement(db, file, opts);
    await db.query(result.status === 'imported' ? 'commit' : 'rollback');
    return result;
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}

/**
 * Same as importFile, inside a transaction the caller already opened with app.user_id set
 * (the web app and the MCP server, so the import is one audited operation).
 * Writes nothing unless the status is 'imported'.
 */
export async function importStatement(
  db: Db,
  file: ParsedFile & { fingerprints: string[] },
  opts: { force?: boolean } = {},
): Promise<ImportResult> {
  const st = file.statement;
  const result: ImportResult = {
    file: file.fileName,
    status: 'imported',
    account: st.account.name,
    inserted: 0,
    duplicates: 0,
    installmentPlansCreated: 0,
    uncategorized: 0,
    needsReview: [],
    failedChecks: st.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
  };
  if (result.failedChecks.length && !opts.force) return { ...result, status: 'rejected' };

  const dup = await db.query(`select id from import_batches where file_hash = $1`, [file.fileHash]);
  if (dup.rows.length) return { ...result, status: 'already_imported' };

  // ---- account: matched by issuer + masked ref + kind, created on first sight
  const a = st.account;
  let accountId: number;
  const found = await db.query<{ id: number }>(
    `select id from accounts where issuer = $1 and external_ref = $2 and kind = $3 and default_currency = $4`,
    [a.issuer, a.externalRef, a.kind, a.defaultCurrency],
  );
  if (found.rows.length) {
    accountId = found.rows[0].id;
    await db.query(`update accounts set closing_day = coalesce($2, closing_day), due_day = coalesce($3, due_day) where id = $1`, [
      accountId,
      a.closingDay ?? null,
      a.dueDay ?? null,
    ]);
  } else {
    const ins = await db.query<{ id: number }>(
      `insert into accounts (name, kind, issuer, last4, external_ref, default_currency, closing_day, due_day)
       values ($1, $2, $3, $4, $4, $5, $6, $7) returning id`,
      [a.name, a.kind, a.issuer, a.externalRef, a.defaultCurrency, a.closingDay ?? null, a.dueDay ?? null],
    );
    accountId = ins.rows[0].id;
  }

  const batch = await db.query<{ id: number }>(
    `insert into import_batches (account_id, file_name, file_hash, period_start, period_end, row_count)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [accountId, file.fileName, file.fileHash, st.periodStart, st.periodEnd, st.transactions.length],
  );
  const batchId = batch.rows[0].id;

  // ---- knowledge
  const rules = (
    await db.query<RuleRow>(
      `select r.id, r.pattern, r.match_type, r.account_id, r.merchant_id, r.category_id, r.kind, r.amount_min, r.amount_max,
              coalesce(array(select tag_id from merchant_rule_tags t where t.merchant_rule_id = r.id), '{}') as tag_ids
       from merchant_rules r order by r.priority, r.id`,
    )
  ).rows;
  const merchantRows = (
    await db.query<{ id: number; name: string; default_category_id: number | null }>(`select id, name, default_category_id from merchants`)
  ).rows;
  const merchantsByName = new Map(merchantRows.map((m) => [m.name.toLowerCase(), m]));
  const merchantsById = new Map(merchantRows.map((m) => [m.id, m]));

  // ---- rows
  for (const [i, tx] of st.transactions.entries()) {
    const rule = rules.find((r) => ruleMatches(r, tx.description, accountId, tx.amount));
    const merchant = rule
      ? merchantsById.get(rule.merchant_id)
      : tx.merchantHint
        ? merchantsByName.get(tx.merchantHint.toLowerCase())
        : undefined;
    const categoryId = rule?.category_id ?? merchant?.default_category_id ?? null;
    const categorizedBy = categoryId !== null ? 'rule' : null;
    const kind = rule?.kind ?? tx.kind;

    let commitmentId: number | null = null;
    if (tx.installment) {
      const start = planStart(tx);
      const plan = await db.query<{ id: number }>(
        `select id from commitments
         where kind = 'installment_plan' and account_id = $1 and currency = $2
           and installments_total = $3 and start_date = $4 and lower(description) = lower($5)`,
        [accountId, tx.currency, tx.installment.total, start, tx.merchantHint],
      );
      if (plan.rows.length) commitmentId = plan.rows[0].id;
      else {
        const created = await db.query<{ id: number }>(
          `insert into commitments (kind, description, merchant_id, account_id, category_id, currency, expected_amount,
                                    start_date, installments_total, detected_by, confirmed, notes)
           values ('installment_plan', $1, $2, $3, $4, $5, $6, $7, $8, 'claude', true, $9) returning id`,
          [tx.merchantHint, merchant?.id ?? null, accountId, categoryId, tx.currency, tx.amount, start, tx.installment.total,
           `detected in ${file.fileName}: "${tx.description}"`],
        );
        commitmentId = created.rows[0].id;
        result.installmentPlansCreated++;
      }
    }

    const ins = await db.query<{ id: number }>(
      `insert into transactions (account_id, import_batch_id, raw, posted_on, period_month, description_raw, amount, currency,
                                 kind, merchant_id, category_id, categorized_by, installment_number, installment_total,
                                 commitment_id, fingerprint, review_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       on conflict (user_id, fingerprint) do nothing
       returning id`,
      [accountId, batchId, JSON.stringify({ ...tx.raw, merchantHint: tx.merchantHint, reference: tx.reference ?? null }),
       tx.postedOn, tx.periodMonth, tx.description, tx.amount, tx.currency, kind, merchant?.id ?? null, categoryId, categorizedBy,
       tx.installment?.number ?? null, tx.installment?.total ?? null, commitmentId, file.fingerprints[i],
       rule ? null : tx.needsReview ?? null],
    );
    if (!ins.rows.length) {
      result.duplicates++;
      continue;
    }
    result.inserted++;
    const txId = ins.rows[0].id;

    if (rule) {
      await db.query(`update merchant_rules set hits = hits + 1 where id = $1`, [rule.id]);
      if (rule.tag_ids.length)
        await db.query(
          `insert into transaction_tags (transaction_id, tag_id, tagged_by) select $1, unnest($2::int[]), 'rule' on conflict do nothing`,
          [txId, rule.tag_ids],
        );
    }
    const spending = !['card_payment', 'transfer', 'income', 'fx'].includes(kind);
    if (spending && categoryId === null) result.uncategorized++;
    if (!rule && tx.needsReview)
      result.needsReview.push({ id: txId, postedOn: tx.postedOn, description: tx.description, amount: tx.amount, currency: tx.currency, reason: tx.needsReview });
  }

  // payments to merchants with a recurring commitment (rent, gastos comunes...) get linked to it
  await db.query(`select link_commitments()`);
  return result;
}
