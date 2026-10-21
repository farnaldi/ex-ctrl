import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as XLSX from 'xlsx';
import { itauAccount } from './itau-account.ts';
import { santanderAccount } from './santander-account.ts';
import { santanderCard } from './santander-card.ts';
import type { Grid, ParsedStatement, ParsedTx, Parser } from './types.ts';
import { cents } from './util.ts';

export * from './types.ts';

/** Registered parsers, tried in order. Adding a bank = adding a Parser here. */
export const PARSERS: Parser[] = [santanderCard, santanderAccount, itauAccount];

export interface ParsedFile {
  fileName: string;
  fileHash: string;
  statement: ParsedStatement;
}

/**
 * Stable per-row id: same row in an overlapping or re-downloaded export -> same fingerprint.
 * Card statements are closed periods that never overlap, so the statement month is part of the key:
 * a row that appears in two statements was billed twice (seen: a toll dated in February billed again in March).
 * Bank account exports can overlap (any date range), so their key is the row alone.
 */
function fingerprint(st: ParsedStatement, tx: ParsedTx, occurrence: number): string {
  const statement = st.account.kind === 'credit_card' ? tx.periodMonth : '';
  const key = [st.source, st.account.externalRef, statement, tx.postedOn, tx.currency, cents(tx.amount), tx.description, tx.reference ?? '', occurrence].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** Fingerprints for every row; identical rows in one statement (same day, amount, text) are told apart by order. */
export function fingerprintAll(statement: ParsedStatement): string[] {
  const seen = new Map<string, number>();
  return statement.transactions.map((tx) => {
    const k = [tx.periodMonth, tx.postedOn, tx.currency, cents(tx.amount), tx.description, tx.reference ?? ''].join('|');
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return fingerprint(statement, tx, n);
  });
}

export function parseFile(path: string): ParsedFile & { fingerprints: string[] } {
  return parseBuffer(readFileSync(path), basename(path));
}

/** Parse an uploaded export (web upload, MCP tool). */
export function parseBuffer(buf: Buffer, fileName: string): ParsedFile & { fingerprints: string[] } {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });

  for (const sheetName of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' }) as Grid;
    const parser = PARSERS.find((p) => p.detect(sheetName, grid));
    if (!parser) continue;

    const statement = parser.parse(grid, { fileName });
    return { fileName, fileHash: createHash('sha256').update(buf).digest('hex'), statement, fingerprints: fingerprintAll(statement) };
  }
  throw new Error(`${fileName}: format not recognized. Supported: ${PARSERS.map((p) => p.source).join(', ')}`);
}
