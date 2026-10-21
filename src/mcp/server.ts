/**
 * MCP server: the agent's view of the finance data. One instance per request, bound to the signed-in user.
 * Every tool calls the same domain layer as the web app; writes are audited as actor 'claude' and return an
 * op_id that undo_operation reverts.
 */
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { Ctx } from '../core/db.ts';
import { dbErrorMessage } from '../core/db.ts';
import * as F from '../core/finance.ts';
import * as S from '../core/schemas.ts';

const INSTRUCTIONS = `Personal finance data for one user (Uruguay). Conventions:
- amount > 0 = money out, < 0 = money in. UYU and USD are separate everywhere: never add or convert between them.
- "month" is the accounting month: statement month for credit cards, posted month for bank accounts.
- Spending excludes transfers, currency exchange (fx), income, savings/investments and categories of nature "excluded".
- Categories say what the money was (Supermercado); tags say what it was for (house, byd, camelcase). Tags nest (autos > nivus, byd).
- To answer "what is this charge", prefer learn_rule when the same description will repeat (it applies to past and future rows);
  use categorize_transaction for one-time answers. Mark unusual purchases one_off so they stay out of the forecast baseline.
- Imported rows are facts: never delete them; recategorize or move them to an excluded category instead.
- Every write returns op_id. Tell the user what changed; undo_operation(op_id) reverts it.
- Ask the user before writes they did not ask for, and before import_statement with force.`;

type Json = Record<string, unknown> | unknown[] | null;

function result(data: Json) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] };
}

function failure(e: unknown) {
  return { content: [{ type: 'text' as const, text: `Error: ${dbErrorMessage(e)}` }], isError: true };
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

export function buildMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: 'finanzas', version: '0.2.0' }, { instructions: INSTRUCTIONS });

  // Small helper: register a tool whose handler returns JSON, with uniform error handling.
  function tool<T extends z.ZodType>(
    name: string,
    description: string,
    input: T,
    annotations: typeof READ | typeof WRITE | typeof DESTRUCTIVE,
    run: (args: z.infer<T>) => Promise<unknown>,
  ) {
    server.registerTool(name, { description, inputSchema: input as never, annotations }, (async (args: z.infer<T>) => {
      try {
        return result((await run(args)) as Json);
      } catch (e) {
        return failure(e);
      }
    }) as never);
  }

  const none = z.object({});
  const month = z.object({ month: S.Month.describe('YYYY-MM') });

  // ---------------------------------------------------------------- read
  tool('search_transactions', 'Find transactions with filters (month range, currency, account, category, tag incl. children, merchant, text, review state). Returns rows, total count and totals per currency.', S.TransactionFilter, READ, (a) => F.listTransactions(ctx, a));
  tool('get_transaction', 'One transaction in full: raw bank row, tags, linked commitment and its change history.', z.object({ transaction_id: z.number().int() }), READ, (a) => F.getTransaction(ctx, a.transaction_id));
  tool('spend_summary', 'Spending totals grouped by category, tag (rolled up to parents), merchant, account, nature or month; optionally split by month. Per currency.', S.SpendSummary, READ, (a) => F.spendSummary(ctx, a));
  tool('monthly_totals', 'Spending per month and currency, with the committed (fixed) and one-off parts.', z.object({ from: S.Month.optional(), to: S.Month.optional() }), READ, (a) => F.monthlyTotals(ctx, a));
  tool('list_accounts', 'Bank accounts and cards, with last imported month.', none, READ, () => F.listAccounts(ctx));
  tool('list_categories', 'Categories with nature (fixed, variable, savings, income, excluded) and usage.', none, READ, () => F.listCategories(ctx));
  tool('list_tags', 'Tags with parent, usage and notes.', none, READ, () => F.listTags(ctx));
  tool('list_merchants', 'Merchants (normalized names) with default category and tags.', z.object({ search: z.string().optional() }), READ, (a) => F.listMerchants(ctx, a.search));
  tool('list_rules', 'Learned categorization rules (pattern → merchant/category/kind), lowest priority first.', z.object({ search: z.string().optional() }), READ, (a) => F.listRules(ctx, a.search));
  tool('list_commitments', 'Fixed expenses, subscriptions, card installment plans and loans (with balance), next due month and last paid month.', z.object({ status: z.enum(['active', 'ended', 'cancelled', 'all']).optional() }), READ, (a) => F.listCommitments(ctx, a));
  tool('get_forecast', 'Forecast for a month per currency: totals with range, by tag, and every line (commitments due, variable baseline, planned events).', z.object({ month: S.Month, lookback: z.number().int().min(1).max(12).optional() }), READ, (a) => F.forecast(ctx, a.month, a.lookback));
  tool('forecast_accuracy', 'Forecast vs actual for months whose forecast was snapshotted.', none, READ, () => F.forecastAccuracy(ctx));
  tool('review_queue', 'What needs an answer: flagged or uncategorized transactions, missed commitment payments (last 3 months), open anomalies.', none, READ, () => F.reviewQueue(ctx));
  tool('recurring_candidates', 'Merchants that charge regularly but are not tracked as a commitment yet.', none, READ, () => F.recurringCandidates(ctx));
  tool('list_notes', 'Planned events and facts (trips, intended purchases) that feed the forecast.', none, READ, () => F.listNotes(ctx));
  tool('list_operations', 'Change history: one row per operation (web edit, agent tool call, import), newest first.', z.object({ limit: z.number().int().min(1).max(200).optional(), actor: z.enum(['user', 'claude']).optional() }), READ, (a) => F.listOperations(ctx, a));
  tool('get_operation', 'Every row an operation changed, before and after.', z.object({ op_id: z.string().uuid() }), READ, (a) => F.getOperation(ctx, a.op_id));
  tool('get_review', 'The saved monthly review (markdown) for a month, or the latest.', z.object({ month: S.Month.optional() }), READ, (a) => F.getReview(ctx, a.month));

  // ---------------------------------------------------------------- write
  tool('categorize_transaction', 'One-time answer for a single transaction: category (created if missing), kind, tags, note, one-off. No rule is created.', S.Categorize, WRITE, (a) => F.categorize(ctx, a));
  tool('learn_rule', 'Teach a rule: bank descriptions matching the pattern map to a merchant/category/kind/tags. Applies to all past matching rows and to future imports. Returns how many rows changed.', S.LearnRule, WRITE, (a) => F.learnRule(ctx, a));
  tool('update_transaction', 'Edit one transaction: category, kind, merchant, note, one-off, linked commitment.', S.UpdateTransaction, WRITE, (a) => F.updateTransaction(ctx, a));
  tool('tag_transactions', 'Add and/or remove tags on transactions (tags are created if missing).', S.Tagging, WRITE, (a) => F.tagTransactions(ctx, a));
  tool('add_manual_transaction', 'Record a payment that is not in any imported export (cash, an account that is not imported). Goes to the Manual account.', S.ManualTransaction, WRITE, (a) => F.addManualTransaction(ctx, a));
  tool('delete_manual_transaction', 'Delete a transaction recorded by hand (Manual account only).', z.object({ transaction_id: z.number().int() }), DESTRUCTIVE, (a) => F.deleteManualTransaction(ctx, a.transaction_id));
  tool('add_fixed_expense', 'New recurring commitment (rent, a bill, a subscription, a yearly fee). Payments to its merchant get linked automatically.', S.FixedExpense, WRITE, (a) => F.addFixedExpense(ctx, a));
  tool('add_loan', 'New loan or mortgage; the monthly payment is computed with French amortization unless given.', S.Loan, WRITE, (a) => F.addLoan(ctx, a));
  tool('update_commitment', 'Edit a commitment: amount, tolerance, dates, status (ended/cancelled), category, merchant, notes, tags.', S.UpdateCommitment, WRITE, (a) => F.updateCommitment(ctx, a));
  tool('add_planned_event', 'A planned expense (trip, purchase) for the forecast, optionally spread over several months.', S.PlannedEvent, WRITE, (a) => F.addPlannedEvent(ctx, a));
  tool('delete_note', 'Delete a planned event or fact.', z.object({ note_id: z.number().int() }), DESTRUCTIVE, (a) => F.deleteNote(ctx, a.note_id));
  tool('edit_tag', 'Create or edit a tag: parent, rename, archive, notes.', S.TagEdit, WRITE, (a) => F.editTag(ctx, a));
  tool('edit_category', 'Create or edit a category: nature, parent, rename.', S.CategoryEdit, WRITE, (a) => F.editCategory(ctx, a));
  tool('delete_rule', 'Delete a learned rule (past rows keep their category).', z.object({ rule_id: z.number().int() }), DESTRUCTIVE, (a) => F.deleteRule(ctx, a.rule_id));
  tool('import_statement', 'Import a bank export (Santander UY card or account, Itaú UY account; .xls/.xlsx). Reconciliation must pass. Re-importing is safe: duplicates are skipped.', S.ImportStatement, WRITE, (a) => F.importExport(ctx, a.file_name, Buffer.from(a.content_base64, 'base64'), { force: a.force }));
  tool('post_off_statement', 'Record the month’s off-statement commitments (paid outside imported accounts) as Manual transactions. Idempotent.', month, WRITE, (a) => F.postOffStatement(ctx, a.month));
  tool('snapshot_forecast', 'Save the current forecast for a month, to compare with what actually happens.', month, WRITE, (a) => F.snapshotForecast(ctx, a.month));
  tool('save_review', 'Save the monthly review (markdown) for a month, replacing any earlier one.', z.object({ month: S.Month, summary_md: z.string().min(1) }), WRITE, (a) => F.saveReview(ctx, a.month, a.summary_md));
  tool('undo_operation', 'Revert everything one operation changed (from list_operations or a write’s op_id). Fails if a later operation changed the same rows.', z.object({ op_id: z.string().uuid() }), DESTRUCTIVE, (a) => F.undo(ctx, a.op_id));

  return server;
}
