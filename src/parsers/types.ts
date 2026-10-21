export type Currency = 'UYU' | 'USD';

export type TxKind =
  | 'purchase'
  | 'refund'
  | 'fee'
  | 'interest'
  | 'tax'
  | 'loan_payment'
  | 'cash_withdrawal'
  | 'card_payment'
  | 'transfer'
  | 'income'
  | 'fx';

export interface ParsedTx {
  /** Date printed on the export (YYYY-MM-DD). For card cuotas this is the original purchase date. */
  postedOn: string;
  /** Accounting month (YYYY-MM-01): statement month for cards, posted month for bank accounts. */
  periodMonth: string;
  /** Description exactly as exported (whitespace collapsed). Used for rules and fingerprints. */
  description: string;
  /** Best-effort merchant / counterparty name, cleaned of processor prefixes, cuota suffixes, cities. */
  merchantHint: string | null;
  /** Positive = money out, negative = money in. */
  amount: number;
  currency: Currency;
  kind: TxKind;
  installment?: { number: number; total: number };
  /** Bank reference, when the export has one. */
  reference?: string;
  /** Why the importer could not classify this confidently (Claude asks the user about these). */
  needsReview?: string;
  /** Original row and extra parsed details, stored untouched as jsonb. */
  raw: Record<string, unknown>;
}

export interface ParsedAccount {
  /** Display name, e.g. "Santander Visa ·7740". */
  name: string;
  kind: 'credit_card' | 'debit_card' | 'bank' | 'cash';
  issuer: string;
  /** Masked issuer-side id (last 4 digits); the full account number is never stored. */
  externalRef: string;
  defaultCurrency: Currency;
  closingDay?: number;
  dueDay?: number;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ParsedStatement {
  source: string;
  account: ParsedAccount;
  periodStart: string | null;
  periodEnd: string | null;
  transactions: ParsedTx[];
  /** Reconciliation checks: an import with a failed check is rejected. */
  checks: Check[];
}

/** A spreadsheet as a grid of cell values (string | number | ''), row-major. */
export type Grid = (string | number)[][];

export interface Parser {
  source: string;
  /** True when this parser recognizes the file. */
  detect(sheetName: string, grid: Grid): boolean;
  parse(grid: Grid, ctx: { fileName: string }): ParsedStatement;
}
