/**
 * Input schemas shared by the MCP tools and the web app's server actions.
 * One definition per operation, so the agent and the UI validate exactly the same way.
 */
import * as z from 'zod';

export const Currency = z.enum(['UYU', 'USD']);
export const Nature = z.enum(['fixed', 'variable', 'savings', 'income', 'excluded']);
export const Kind = z.enum([
  'purchase', 'refund', 'fee', 'interest', 'tax', 'loan_payment', 'cash_withdrawal', 'card_payment', 'transfer', 'income', 'fx',
]);
export const Month = z.string().regex(/^\d{4}-\d{2}$/, 'YYYY-MM');
export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const TagName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^\s]+$/, 'tags are one word, lowercase (use - instead of spaces)');
export const MatchType = z.enum(['exact', 'prefix', 'contains', 'regex']);

export const TransactionFilter = z.object({
  from: Month.optional().describe('First accounting month, inclusive (YYYY-MM)'),
  to: Month.optional().describe('Last accounting month, inclusive (YYYY-MM)'),
  currency: Currency.optional(),
  account_id: z.number().int().optional(),
  category: z.string().optional().describe('Category name (exact, case-insensitive)'),
  tag: z.string().optional().describe('Tag name; includes its child tags (autos includes nivus and byd)'),
  merchant: z.string().optional().describe('Merchant name (exact, case-insensitive)'),
  text: z.string().optional().describe('Search in the bank description, merchant and note'),
  kind: Kind.optional(),
  spending_only: z.boolean().optional().describe('Only rows that count as spending (no transfers, fx, income, savings or excluded)'),
  uncategorized: z.boolean().optional().describe('Only spending rows with no category'),
  needs_review: z.boolean().optional().describe('Only rows flagged by the importer and not answered yet'),
  pending: z.boolean().optional().describe('Rows waiting for an answer: flagged by the importer or spending with no category'),
  one_off: z.boolean().optional().describe('Only rows marked one-off (true) or only regular rows (false)'),
  min_amount: z.number().optional(),
  max_amount: z.number().optional(),
  sort: z.enum(['date_desc', 'date_asc', 'amount_desc', 'amount_asc']).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});
export type TransactionFilter = z.infer<typeof TransactionFilter>;

export const SpendSummary = z.object({
  group_by: z.enum(['category', 'tag', 'merchant', 'account', 'nature', 'month']),
  by_month: z.boolean().optional().describe('Also split each group by month'),
  from: Month.optional(),
  to: Month.optional(),
  currency: Currency.optional(),
  category: z.string().optional(),
  tag: z.string().optional().describe('Restrict to a tag (and its children)'),
  exclude_one_off: z.boolean().optional().describe('Leave out rows marked one-off'),
});
export type SpendSummary = z.infer<typeof SpendSummary>;

export const Categorize = z.object({
  transaction_id: z.number().int(),
  category: z.string().min(1).describe('Category name; created if missing'),
  nature: Nature.optional().describe('Used only when the category is new. Default variable'),
  kind: Kind.optional(),
  tags: z.array(TagName).optional(),
  note: z.string().optional(),
  one_off: z.boolean().optional().describe('Keep it out of the variable baseline used by the forecast'),
});

export const LearnRule = z.object({
  pattern: z.string().min(2).describe('Text to match in the bank description'),
  match_type: MatchType.optional().describe('Default contains. Regex must work in both Postgres and JavaScript'),
  merchant: z.string().min(1).describe('Normalized merchant name; created if missing'),
  category: z.string().optional(),
  nature: Nature.optional().describe('Nature of the category if it is new. Default variable'),
  kind: Kind.optional().describe('Force a kind, e.g. transfer'),
  tags: z.array(TagName).optional(),
  account_id: z.number().int().optional().describe('Only for this account'),
  priority: z.number().int().optional().describe('Lower wins. Default 100; generic rules 200, amount-specific 50'),
  amount_min: z.number().optional(),
  amount_max: z.number().optional(),
});

export const UpdateTransaction = z.object({
  transaction_id: z.number().int(),
  category: z.string().nullable().optional().describe('Category name; null clears it'),
  kind: Kind.optional(),
  note: z.string().nullable().optional(),
  merchant: z.string().nullable().optional().describe('Merchant name; created if missing; null clears it'),
  one_off: z.boolean().optional(),
  commitment_id: z.number().int().nullable().optional().describe('Link to (or unlink from) a commitment'),
});

export const Tagging = z.object({
  transaction_ids: z.array(z.number().int()).min(1).max(500),
  add: z.array(TagName).optional(),
  remove: z.array(TagName).optional(),
});

export const ManualTransaction = z.object({
  date: DateStr,
  description: z.string().min(1),
  amount: z.number().describe('Positive = money out (spending), negative = money in'),
  currency: Currency,
  category: z.string().optional(),
  nature: Nature.optional(),
  kind: Kind.optional(),
  tags: z.array(TagName).optional(),
  note: z.string().optional(),
  one_off: z.boolean().optional(),
  commitment_id: z.number().int().optional().describe('The commitment this payment belongs to (e.g. a fixed expense paid in cash)'),
});

export const FixedExpense = z.object({
  description: z.string().min(1),
  amount: z.number().positive(),
  currency: Currency,
  category: z.string().optional(),
  day: z.number().int().min(1).max(31).optional(),
  start: DateStr.optional().describe('Default: first day of the current month'),
  end: DateStr.optional(),
  every_n_months: z.number().int().min(1).max(60).optional().describe('1 monthly (default), 2 bimonthly, 12 yearly'),
  off_statement: z.boolean().optional().describe('True when the payment will not appear in imported exports (cash, unimported account)'),
  tags: z.array(TagName).optional(),
  merchant: z.string().optional().describe('Imported payments to this merchant are linked to the commitment'),
  tolerance: z.number().min(0).max(1).optional().describe('Allowed variation, 0.05 = 5%'),
});

export const Loan = z.object({
  description: z.string().min(1),
  loan_kind: z.enum(['mortgage', 'personal', 'car', 'other']),
  principal: z.number().positive(),
  currency: Currency,
  annual_rate: z.number().min(0).describe('% per year, e.g. 6.8'),
  term_months: z.number().int().positive(),
  first_payment: DateStr,
  payment: z.number().positive().optional().describe('Monthly payment if it differs from the French-amortization one'),
  category: z.string().optional(),
  day: z.number().int().min(1).max(31).optional(),
  off_statement: z.boolean().optional(),
  tags: z.array(TagName).optional(),
});

export const UpdateCommitment = z.object({
  commitment_id: z.number().int(),
  description: z.string().optional(),
  expected_amount: z.number().positive().optional(),
  tolerance: z.number().min(0).max(1).optional(),
  day: z.number().int().min(1).max(31).nullable().optional(),
  start: DateStr.optional(),
  end: DateStr.nullable().optional(),
  status: z.enum(['active', 'ended', 'cancelled']).optional(),
  category: z.string().optional(),
  merchant: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  add_tags: z.array(TagName).optional(),
  remove_tags: z.array(TagName).optional(),
});

export const PlannedEvent = z.object({
  title: z.string().min(1),
  kind: z.enum(['event', 'plan']).optional().describe('event: something happening (a trip); plan: a purchase you intend to make'),
  start_month: Month,
  end_month: Month.optional().describe('The amount is split evenly across the months'),
  amount: z.number().positive(),
  currency: Currency,
  category: z.string().optional(),
  tags: z.array(TagName).optional(),
  body: z.string().optional(),
});

export const TagEdit = z.object({
  name: TagName,
  parent: TagName.nullable().optional().describe('Parent tag (created if missing); null removes the parent'),
  rename_to: TagName.optional(),
  archived: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

export const MerchantEdit = z.object({
  name: z.string().min(1).describe('Existing merchant name (case-insensitive)'),
  add_tags: z.array(TagName).optional().describe('Tags every row of this merchant gets'),
  remove_tags: z.array(TagName).optional(),
  apply_to_transactions: z
    .boolean()
    .optional()
    .describe('Default true: also add/remove the tag on the merchant\'s existing rows (only tags that came from the merchant are removed)'),
});

export const CategoryEdit = z.object({
  name: z.string().min(1),
  nature: Nature.optional(),
  parent: z.string().nullable().optional(),
  rename_to: z.string().min(1).optional(),
});

export const ImportStatement = z.object({
  file_name: z.string().min(1).describe('Original file name, e.g. Setiembre-santander-visa.xls'),
  content_base64: z.string().min(1).describe('The export file, base64-encoded'),
  force: z.boolean().optional().describe('Import even if reconciliation fails (only when the user confirms)'),
});
