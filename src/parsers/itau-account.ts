/**
 * Itaú Uruguay account statement export ("Estado de Cuenta"), e.g. Caja de Ahorro in pesos.
 *
 * Layout: header (Nombre, Tipo de cuenta, Moneda "Pesos"/"Dólares", Nro de cuenta), then, oldest first:
 *   Fecha | Concepto | Débito | Crédito | Saldo | Referencia | Destino
 * framed by "SALDO ANTERIOR" and "SALDO FINAL" rows.
 *
 * Concepts seen:
 *   COMPRA <merchant>              debit-card purchase
 *   REDIVA <code><merchant>        VAT refund credited after a debit purchase
 *   CRE. CAMBIOSOP....<n>          currency exchange: pesos bought with dollars (fx)
 *   DEB. CAMBIOSST....<n>          transfer to Santander (seen matching Santander credits exactly)
 *   DEB. CAMBIOSCOM.<n>            commission on an outgoing transfer
 *   DEB./CRE. CAMBIOSTOLD|TOLC<n>  transfer to / from another bank
 *   TRASPASO A|DE <account>ILINK   transfer to / from another Itaú account (Referencia = the payer's note)
 *   DEB. VARIOS PAGO D.G.I.        tax payment
 *   RETIRO <network>               cash withdrawal
 * Reconciliation: every row's Saldo = previous Saldo + Crédito − Débito, from SALDO ANTERIOR to SALDO FINAL.
 */
import type { Currency, Grid, ParsedStatement, ParsedTx, Parser, TxKind } from './types.ts';
import { cents, findRow, isDate, last4, monthOf, parseAmount, parseDate, round2, str, stripCodes, titleCase } from './util.ts';

interface Rule {
  re: RegExp;
  kind: (credit: boolean) => TxKind;
  merchant: (m: RegExpMatchArray, ref: string) => string | null;
  review?: (m: RegExpMatchArray, credit: boolean) => string | undefined;
}

const RULES: Rule[] = [
  { re: /^COMPRA\s+(.+)$/i, kind: (c) => (c ? 'refund' : 'purchase'), merchant: (m) => titleCase(stripCodes(m[1])) },
  { re: /^REDIVA\s+\d*\s*(.+)$/i, kind: () => 'refund', merchant: (m) => titleCase(stripCodes(m[1])) },
  { re: /^CRE\.\s*CAMBIOSOP/i, kind: () => 'fx', merchant: () => 'Cambio de moneda' },
  { re: /^DEB\.\s*CAMBIOSST/i, kind: () => 'transfer', merchant: () => 'Santander (cuenta propia)' },
  { re: /^DEB\.\s*CAMBIOSCOM/i, kind: () => 'fee', merchant: () => 'Itaú' },
  {
    re: /^(DEB|CRE)\.\s*CAMBIOSTOL[CD]/i,
    kind: (c) => (c ? 'income' : 'purchase'),
    merchant: (_m, ref) => (ref ? titleCase(ref) : null),
    review: (_m, c) => (c ? 'incoming transfer from another bank: income, reimbursement or own-account move?' : 'transfer to another bank: what was it for?'),
  },
  {
    re: /^TRASPASO\s+(A|DE)\s+(\d+)ILINK/i,
    kind: (c) => (c ? 'income' : 'purchase'),
    merchant: (m, ref) => (ref ? titleCase(ref) : `Cuenta Itaú ·${last4(m[2])}`),
    review: (_m, c) => (c ? 'incoming Itaú transfer: income, reimbursement or own-account move?' : 'transfer to an Itaú account: what was it for?'),
  },
  { re: /PAGO D\.?G\.?I/i, kind: () => 'tax', merchant: () => 'DGI' },
  { re: /^RETIRO/i, kind: () => 'cash_withdrawal', merchant: () => 'Efectivo' },
];

export const itauAccount: Parser = {
  source: 'itau-account',

  detect: (sheetName, grid) =>
    sheetName === 'Estado de Cuenta' && findRow(grid, ['Fecha', 'Concepto', 'Débito', 'Crédito', 'Saldo']) >= 0,

  parse(grid: Grid): ParsedStatement {
    const hdr = findRow(grid, ['Tipo de cuenta', 'Moneda']);
    if (hdr < 0) throw new Error('Itaú account: header not found');
    const H = grid[hdr].map(str);
    const V = grid[hdr + 1];
    const col = (label: string) => H.findIndex((c) => c.toLowerCase() === label.toLowerCase());
    const product = str(V[col('Tipo de cuenta')]);
    const moneda = str(V[col('Moneda')]).toLowerCase();
    const currency: Currency = /d[oó]lar|usd|u\$s/.test(moneda) ? 'USD' : /peso|uyu|\$/.test(moneda) ? 'UYU' : (() => { throw new Error(`Itaú account: unsupported currency ${moneda}`); })();
    const accountNo = str(V[col('Nro de cuenta')]);

    const th = findRow(grid, ['Fecha', 'Concepto', 'Débito', 'Crédito', 'Saldo']);
    const T = grid[th].map(str);
    const c = (label: string) => T.findIndex((x) => x.toLowerCase() === label.toLowerCase());
    const cDate = c('Fecha'), cConcept = c('Concepto'), cDebit = c('Débito'), cCredit = c('Crédito'), cBal = c('Saldo');
    const cRef = c('Referencia'), cDest = c('Destino');
    if ([cDate, cConcept, cDebit, cCredit, cBal].some((x) => x < 0)) throw new Error('Itaú account: unexpected table columns');

    let opening: number | null = null;
    let closing: number | null = null;
    let periodStart: string | null = null;
    let periodEnd: string | null = null;
    const rows: { tx: ParsedTx; balance: number; movement: number }[] = [];

    for (let r = th + 1; r < grid.length; r++) {
      const row = grid[r];
      const concept = str(row[cConcept]);
      if (/^SALDO ANTERIOR/i.test(concept)) {
        opening = parseAmount(row[cBal]);
        if (isDate(row[cDate])) periodStart = parseDate(row[cDate]);
        continue;
      }
      if (/^SALDO FINAL/i.test(concept)) {
        closing = parseAmount(row[cBal]);
        continue;
      }
      if (!isDate(row[cDate])) continue;

      const debit = parseAmount(row[cDebit]);
      const credit = parseAmount(row[cCredit]);
      const movement = credit - debit; // account perspective
      const isCredit = movement > 0;
      const ref = cRef >= 0 ? str(row[cRef]) : '';
      const dest = cDest >= 0 ? str(row[cDest]) : '';

      const rule = RULES.find((x) => x.re.test(concept));
      const m = rule ? concept.match(rule.re)! : null;
      const postedOn = parseDate(row[cDate]);
      periodEnd = postedOn;
      rows.push({
        movement,
        balance: parseAmount(row[cBal]),
        tx: {
          postedOn,
          periodMonth: monthOf(postedOn),
          description: [concept, ref].filter(Boolean).join(' · '),
          merchantHint: rule ? rule.merchant(m!, ref) : null,
          amount: round2(-movement),
          currency,
          kind: rule ? rule.kind(isCredit) : isCredit ? 'income' : 'purchase',
          reference: ref || undefined,
          needsReview: rule ? rule.review?.(m!, isCredit) : 'unrecognized movement type',
          raw: { row: row.map(str), reference: ref || null, destination: dest || null },
        },
      });
    }

    const checks = [];
    if (opening === null || closing === null) {
      checks.push({ name: 'balances present', ok: false, detail: 'SALDO ANTERIOR / SALDO FINAL not found' });
    } else {
      let prev = cents(opening), breaks = 0;
      for (const r of rows) {
        if (prev + cents(r.movement) !== cents(r.balance)) breaks++;
        prev = cents(r.balance);
      }
      checks.push({
        name: 'running balance',
        ok: breaks === 0 && prev === cents(closing),
        detail: breaks === 0 && prev === cents(closing)
          ? `${rows.length} rows chain from ${opening} to ${closing}`
          : `${breaks} row(s) don't chain; ends at ${prev / 100}, statement says ${closing}`,
      });
    }

    return {
      source: this.source,
      account: {
        name: `Itaú ${titleCase(product)} ${currency} ·${last4(accountNo)}`,
        kind: 'bank',
        issuer: 'Itaú',
        externalRef: last4(accountNo),
        defaultCurrency: currency,
      },
      periodStart,
      periodEnd,
      transactions: rows.map((r) => r.tx),
      checks,
    };
  },
};
