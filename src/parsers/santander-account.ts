/**
 * Santander Uruguay bank account export ("AccountMovementsExtended"), e.g. Cuenta Corriente in UYU or USD.
 *
 * Layout: header (Cuenta "Cuenta Corriente Select, 000000226505", Moneda, Sucursal), period
 * "01/09/2026 - 30/09/2026", then a table, newest first:
 *   Fecha | Referencia | Tipo Movimiento | Descripción | Débito (negative) | Crédito | Saldo
 *
 * The movement text carries the meaning, so each pattern below maps it to a kind and a counterparty.
 * Anything not recognized is imported with needsReview set, never dropped.
 * Reconciliation: every row's Saldo must equal the previous (older) Saldo plus that row's movement.
 */
import type { Currency, Grid, ParsedStatement, ParsedTx, Parser, TxKind } from './types.ts';
import { cents, colOf, findRow, isDate, last4, monthOf, parseAmount, parseDate, round2, str, stripCodes, titleCase } from './util.ts';

const TAX_COUNTERPARTIES = /\b(DGI|BPS|CJPPU|IMPO|INTENDENCIA|SUCIVE)\b/i;

/** "BUENAS MIGAS .LOCAL" -> "Buenas Migas", "MERPAGO.ALEJANDRO" -> "Alejandro". */
const cleanMerchant = (s: string): string =>
  titleCase(stripCodes(s.replace(/\s*\.(LOCAL|HANDY)\.?$/i, '').replace(/^MERPAGO\./i, '')));

interface Rule {
  re: RegExp;
  kind: (m: RegExpMatchArray, credit: boolean) => TxKind;
  merchant?: (m: RegExpMatchArray) => string | null;
  review?: (m: RegExpMatchArray, credit: boolean) => string | undefined;
  extra?: (m: RegExpMatchArray, ref: string) => Record<string, unknown>;
}

const RULES: Rule[] = [
  {
    re: /^PAGO ELECTRONICO TARJETA CREDITO/i,
    kind: () => 'card_payment',
    extra: (_m, ref) => ({ cardRef: last4(ref) }), // reference ends with the card account number
  },
  {
    re: /^COMPRA CON TARJETA DEBITO (.+?),\s*(.+?)\s+TARJ:/i,
    kind: (_m, credit) => (credit ? 'refund' : 'purchase'),
    merchant: (m) => cleanMerchant(m[1]),
    extra: (m) => ({ city: titleCase(m[2]) }),
  },
  { re: /^RETIRO/i, kind: () => 'cash_withdrawal', merchant: () => 'Efectivo' },
  { re: /^SUELDOS?\b/i, kind: () => 'income', merchant: () => 'Sueldo' },
  {
    re: /^COMISION/i,
    kind: () => 'fee',
    merchant: () => 'Santander',
  },
  {
    // fee charged for an outgoing transfer to another bank; shares the reference with the transfer itself
    re: /^TRANSFERENCIA ENVIADA/i,
    kind: () => 'fee',
    merchant: () => 'Santander',
  },
  {
    re: /^SERVICIO PAC DEBITO PAGO (.+?)\s*\/REF/i,
    kind: () => 'purchase',
    merchant: (m) => titleCase(m[1]),
  },
  {
    re: /^PAGO DE SERVICIO POR BANRED .*?,\s*(.+?)\s+TARJ:/i,
    kind: (m) => (TAX_COUNTERPARTIES.test(m[1]) ? 'tax' : 'purchase'),
    merchant: (m) => titleCase(m[1]),
  },
  {
    // money in from someone: could be a reimbursement, a sale, a gift... ask
    // "T--/NAME" or "TCONCEPT/NAME"
    re: /^CREDITO OPERACION EN BANCA DIGITAL T[^/]*\/(.+)$/i,
    kind: () => 'income',
    merchant: (m) => titleCase(m[1]),
    review: () => 'incoming transfer: income, reimbursement or own-account move?',
  },
  {
    // instant transfer out: "TRANSF INSTANTANEA ENVIADA 558277LE NRR:186936256 NAME"
    re: /^TRANSF INSTANTANEA ENVIADA \S+ NRR:\S+\s+(.+)$/i,
    kind: () => 'purchase',
    merchant: (m) => cleanMerchant(m[1]),
    review: () => 'outgoing transfer to a person: what was it for?',
  },
  {
    // instant transfer in: "TRANSF INSTANTANEA RECIBIDA 854720LR:260105032041789 SURNAME, NAME"
    re: /^TRANSF INSTANTANEA RECIBIDA \S+\s+(.+)$/i,
    kind: () => 'income',
    merchant: (m) => titleCase(m[1]),
    review: () => 'incoming transfer: income, reimbursement or own-account move?',
  },
  {
    // "TRANSFERENCIA RECIBIDA 645803TT RECIBIDA ANTEL" / "... RECIBIDA /NAME /OTHER"
    re: /^TRANSFERENCIA RECIBIDA \S+ RECIBIDA\s+(.+)$/i,
    kind: () => 'income',
    merchant: (m) => titleCase(m[1].replace(/\//g, ' ')),
    review: () => 'incoming transfer: income, reimbursement or own-account move?',
  },
  {
    re: /^DEPOSITO CHEQUES/i,
    kind: () => 'income',
    merchant: () => 'Depósito de cheque',
    review: () => 'cheque deposit: income, or money returning from somewhere?',
  },
  {
    // cash put into the account (branch agent or deposit box)
    re: /^DEPOSITOS? (EN EFECTIVO|POR BUZONERA)/i,
    kind: () => 'income',
    merchant: () => 'Depósito en efectivo',
    review: () => 'cash deposit: income, or your own cash going back to the bank?',
  },
  {
    // discount credited on a debit-card purchase: reduces that merchant's spend
    re: /^PROMOCIONES TARJETAS DE DEBITO DESC (.+)$/i,
    kind: () => 'refund',
    merchant: (m) => cleanMerchant(m[1]),
  },
  {
    // bill paid through an external network (Abitab/RedPagos style), only an invoice number
    re: /^DEBITO RED EXTERNA/i,
    kind: () => 'purchase',
    review: () => 'bill paid through an external network: what was it?',
  },
  {
    // outgoing transfer to a person ("TRF. PLAZA- NAME"): rent, a service, a loan to a friend... ask
    re: /^DEBITO OPERACION EN BANCA DIGITAL \S*TT\S*\s+TRF\.\s*\S*-?\s*(.+)$/i,
    kind: () => 'purchase',
    merchant: (m) => titleCase(m[1]),
    review: () => 'outgoing transfer to a person: what was it for?',
  },
  {
    // banking-app payments: "TGASTOS COMUNES", "TMATI", "DGI IMP2PAGO CONTR", "URUWARE FAELURUWARE"
    re: /^DEBITO OPERACION EN BANCA DIGITAL (.+)$/i,
    kind: (m) => (TAX_COUNTERPARTIES.test(m[1]) ? 'tax' : 'purchase'),
    merchant: (m) => {
      const words = m[1].trim().split(/\s{2,}/)[0]; // first segment before wide spacing
      return titleCase(words.replace(/^T(?=[A-Z])/, '')); // "T" prefix = transfer concept
    },
    review: (m) => (TAX_COUNTERPARTIES.test(m[1]) ? undefined : 'banking-app payment: confirm what it was'),
  },
];

export const santanderAccount: Parser = {
  source: 'santander-account',

  detect: (sheetName, grid) =>
    sheetName === 'AccountMovementsExtended' || findRow(grid, ['Fecha', 'Referencia', 'Tipo Movimiento']) >= 0,

  parse(grid: Grid): ParsedStatement {
    // ---- header
    const hdr = findRow(grid, ['Cuenta', 'Moneda']);
    if (hdr < 0) throw new Error('Santander account: header not found');
    const H = grid[hdr];
    const V = grid[hdr + 1];
    const accountText = str(V[colOf(H, 'Cuenta')]); // "Cuenta Corriente Select, 000000226505"
    const currency = str(V[colOf(H, 'Moneda')]).toUpperCase() as Currency;
    if (currency !== 'UYU' && currency !== 'USD') throw new Error(`Santander account: unsupported currency ${currency}`);
    const [productName, accountNo = ''] = accountText.split(',').map((s) => s.trim());

    let periodStart: string | null = null;
    let periodEnd: string | null = null;
    outer: for (const row of grid) {
      for (const cell of row) {
        const m = str(cell).match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})$/);
        if (m) {
          periodStart = parseDate(m[1]);
          periodEnd = parseDate(m[2]);
          break outer;
        }
      }
    }

    // ---- table
    const th = findRow(grid, ['Fecha', 'Referencia', 'Tipo Movimiento']);
    if (th < 0) throw new Error('Santander account: movements table not found');
    const T = grid[th];
    const cDate = colOf(T, 'Fecha');
    const cRef = colOf(T, 'Referencia');
    const cType = colOf(T, 'Tipo Movimiento');
    const cDesc = colOf(T, 'Descripción');
    const cDebit = colOf(T, 'Débito');
    const cCredit = colOf(T, 'Crédito');
    const cBal = colOf(T, 'Saldo');
    if ([cDate, cType, cDebit, cCredit, cBal].some((c) => c < 0)) throw new Error('Santander account: unexpected table columns');

    const rows: { tx: ParsedTx; balance: number; movement: number }[] = [];
    for (let r = th + 1; r < grid.length; r++) {
      const row = grid[r];
      if (!isDate(row[cDate])) continue;
      const type = str(row[cType]);
      const desc = cDesc >= 0 ? str(row[cDesc]) : '';
      const text = [type, desc].filter(Boolean).join(' ');
      const ref = str(row[cRef]);
      const debit = parseAmount(row[cDebit]); // negative
      const credit = parseAmount(row[cCredit]); // positive
      const movement = debit + credit; // signed, account perspective
      const isCredit = movement > 0;

      const rule = RULES.find((x) => x.re.test(text));
      const m = rule ? text.match(rule.re)! : null;
      const kind: TxKind = rule ? rule.kind(m!, isCredit) : isCredit ? 'income' : 'purchase';
      const needsReview = rule ? rule.review?.(m!, isCredit) : 'unrecognized movement type';

      const postedOn = parseDate(row[cDate]);
      rows.push({
        movement,
        balance: parseAmount(row[cBal]),
        tx: {
          postedOn,
          periodMonth: monthOf(postedOn),
          description: text,
          merchantHint: rule?.merchant ? rule.merchant(m!) : null,
          amount: round2(-movement), // positive = money out
          currency,
          kind,
          reference: ref || undefined,
          needsReview,
          raw: { row: row.map(str), ...(rule?.extra ? rule.extra(m!, ref) : {}) },
        },
      });
    }

    // ---- reconciliation (export is newest-first)
    const checks = [];
    let breaks = 0;
    for (let i = 0; i < rows.length - 1; i++) {
      if (cents(rows[i + 1].balance) + cents(rows[i].movement) !== cents(rows[i].balance)) breaks++;
    }
    checks.push({
      name: 'running balance',
      ok: breaks === 0,
      detail: breaks === 0 ? `${rows.length} rows chain correctly` : `${breaks} row(s) don't match the running balance`,
    });

    return {
      source: this.source,
      account: {
        name: `Santander ${titleCase(productName)} ${currency} ·${last4(accountNo)}`,
        kind: 'bank',
        issuer: 'Santander',
        externalRef: last4(accountNo),
        defaultCurrency: currency,
      },
      periodStart,
      periodEnd,
      transactions: rows.map((r) => r.tx).reverse(), // oldest first
      checks,
    };
  },
};
