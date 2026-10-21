/**
 * Santander Uruguay credit card statement export ("CreditCardStatementMovementsMod").
 *
 * Layout: header block (Cuenta, Fecha de Cierre, Vencimiento, Período Consultado), then a table
 *   Fecha | Tarjeta | Detalle | <importe origen> | Importe $ | Importe U$S
 * framed by "Saldo Anterior" and "Saldo final" rows, one column per currency.
 *
 * Notes
 * - Cuotas keep their original purchase date ("Samsung Store Cuota 05 06" dated in May on the September
 *   statement), so every row's accounting month is the statement month.
 * - "Pago ..." rows with negative amounts are payments of the card itself (card_payment), already
 *   visible as an outflow in the bank account: excluded from spending.
 * - Reconciliation per currency: saldo anterior + sum(rows) = saldo final.
 */
import type { Currency, Grid, ParsedStatement, ParsedTx, Parser, TxKind } from './types.ts';
import { cents, colOf, findRow, isDate, last4, monthOf, parseAmount, parseDate, round2, str, stripCodes, titleCase } from './util.ts';

const PROCESSORS: [RegExp, string][] = [
  [/^merpago\s+/i, 'mercadopago'],
  [/^dlo\s+(help\s+)?/i, 'dlocal'],
  [/^paypal\s+/i, 'paypal'],
];

function classify(detail: string, amount: number): { kind: TxKind; needsReview?: string } {
  if (/^pago\b/i.test(detail) && amount < 0) return { kind: 'card_payment' };
  if (/seguro saldo deudor/i.test(detail)) return { kind: 'fee' };
  if (/inter[eé]s/i.test(detail)) return { kind: 'interest' };
  if (/\b(iva|imesi|impuesto)\b/i.test(detail)) return { kind: 'tax' };
  if (/comisi[oó]n|cargo por|recargo|mora/i.test(detail)) return { kind: 'fee' };
  if (amount < 0) return { kind: 'refund' };
  return { kind: 'purchase' };
}

function merchantFrom(detail: string): { merchant: string; processor: string | null } {
  let s = detail.replace(/\s+cuota\s+\d+\s+\d+\s*$/i, '');
  let processor: string | null = null;
  for (const [re, name] of PROCESSORS) {
    if (re.test(s)) {
      processor = name;
      s = s.replace(re, '');
      break;
    }
  }
  s = s.replace(/\s+visa(\s+deb)?$/i, '').replace(/\s+local\s+\d+$/i, '');
  return { merchant: titleCase(stripCodes(s)), processor };
}

export const santanderCard: Parser = {
  source: 'santander-credit-card',

  detect: (sheetName, grid) =>
    sheetName === 'CreditCardStatementMovementsMod' || findRow(grid, ['Fecha', 'Tarjeta', 'Detalle']) >= 0,

  parse(grid: Grid, { fileName }): ParsedStatement {
    // ---- header block
    const hdr = findRow(grid, ['Cuenta', 'Fecha de Cierre']);
    if (hdr < 0) throw new Error('Santander card: header block not found');
    const H = grid[hdr];
    const V = grid[hdr + 1];
    const accountNo = str(V[colOf(H, 'Cuenta')]);
    const closing = parseDate(V[colOf(H, 'Fecha de Cierre')]);
    const due = parseDate(V[colOf(H, 'Vencimiento')]);
    const period = monthOf(closing);

    const brand = /visa/i.test(fileName) ? 'Visa' : /master/i.test(fileName) ? 'Mastercard' : /amex/i.test(fileName) ? 'Amex' : 'Card';

    // ---- movements table
    const th = findRow(grid, ['Fecha', 'Tarjeta', 'Detalle']);
    if (th < 0) throw new Error('Santander card: movements table not found');
    const T = grid[th];
    const cDate = colOf(T, 'Fecha');
    const cCard = colOf(T, 'Tarjeta');
    const cDetail = colOf(T, 'Detalle');
    const cUYU = colOf(T, 'Importe $');
    const cUSD = colOf(T, 'Importe U$S');
    if ([cDate, cDetail, cUYU, cUSD].some((c) => c < 0)) throw new Error('Santander card: unexpected table columns');

    let opening: Record<Currency, number> | null = null;
    let closingBal: Record<Currency, number> | null = null;
    let cOrigin = -1;
    const txs: ParsedTx[] = [];
    // rows the export printed with 0 in both currencies (seen: a "Seguro Saldo Deudor" whose amount is missing
    // from the export but included in the statement total)
    const blankRows: { row: (string | number)[]; postedOn: string; detail: string; card: string }[] = [];

    for (let r = th + 1; r < grid.length; r++) {
      const row = grid[r];
      const labelCol = row.findIndex((c) => /^saldo (anterior|final)$/i.test(str(c)));
      if (labelCol >= 0) {
        const bal = { UYU: parseAmount(row[cUYU]), USD: parseAmount(row[cUSD]) };
        if (/anterior/i.test(str(row[labelCol]))) {
          opening = bal;
          cOrigin = labelCol; // the "origin amount" column shares the label's column
        } else closingBal = bal;
        continue;
      }
      if (!isDate(row[cDate])) continue;

      const detail = str(row[cDetail]);
      const postedOn = parseDate(row[cDate]);
      const card = str(row[cCard]);
      const origin = cOrigin >= 0 ? str(row[cOrigin]) : '';
      const inst = detail.match(/\s+cuota\s+(\d+)\s+(\d+)\s*$/i);
      const { merchant, processor } = merchantFrom(detail);

      if (parseAmount(row[cUYU]) === 0 && parseAmount(row[cUSD]) === 0) {
        blankRows.push({ row, postedOn, detail, card });
        continue;
      }

      for (const currency of ['UYU', 'USD'] as const) {
        const amount = parseAmount(row[currency === 'UYU' ? cUYU : cUSD]);
        if (amount === 0) continue;
        const { kind, needsReview } = classify(detail, amount);
        txs.push({
          postedOn,
          periodMonth: period,
          description: detail,
          merchantHint: kind === 'card_payment' ? null : merchant || null,
          amount: round2(amount),
          currency,
          kind,
          installment: inst ? { number: Number(inst[1]), total: Number(inst[2]) } : undefined,
          needsReview,
          raw: {
            row: row.map(str),
            card: card ? last4(card) : null,
            processor,
            ...(origin && parseAmount(origin) !== 0 ? { originalAmount: origin } : {}),
          },
        });
      }
    }

    // ---- reconciliation
    const checks = [];
    if (!opening || !closingBal) {
      checks.push({ name: 'balances present', ok: false, detail: 'Saldo Anterior / Saldo final not found' });
    } else {
      for (const cur of ['UYU', 'USD'] as const) {
        const sum = txs.filter((t) => t.currency === cur).reduce((a, t) => a + cents(t.amount), 0);
        const expected = cents(closingBal[cur]) - cents(opening[cur]);
        const gap = expected - sum;
        // Exactly one blank row and an unexplained gap: the gap is that row's amount. Recorded, flagged, explained.
        if (gap !== 0 && blankRows.length === 1) {
          const b = blankRows.shift()!;
          const amount = gap / 100;
          const { kind } = classify(b.detail, amount);
          txs.push({
            postedOn: b.postedOn,
            periodMonth: period,
            description: b.detail,
            merchantHint: merchantFrom(b.detail).merchant || null,
            amount,
            currency: cur,
            kind,
            needsReview: `amount missing in the bank's export; inferred ${amount} ${cur} from the statement total`,
            raw: { row: b.row.map(str), card: b.card ? last4(b.card) : null, inferredFromStatementTotal: true },
          });
          checks.push({
            name: `${cur} balance`,
            ok: true,
            detail: `opening ${opening[cur]} + movements ${expected / 100} = ${closingBal[cur]}; ${amount} inferred for blank row "${b.detail}" (${b.postedOn})`,
          });
          continue;
        }
        checks.push({
          name: `${cur} balance`,
          ok: gap === 0,
          detail: `opening ${opening[cur]} + movements ${sum / 100} = ${(cents(opening[cur]) + sum) / 100} (statement says ${closingBal[cur]})`,
        });
      }
    }

    return {
      source: this.source,
      account: {
        name: `Santander ${brand} ·${last4(accountNo)}`,
        kind: 'credit_card',
        issuer: 'Santander',
        externalRef: last4(accountNo),
        defaultCurrency: 'UYU',
        closingDay: Number(closing.slice(8, 10)),
        dueDay: Number(due.slice(8, 10)),
      },
      periodStart: null, // the export only states the closing date; the statement month is periodMonth on each row
      periodEnd: closing,
      transactions: txs,
      checks,
    };
  },
};
