/**
 * Itaú UY account parser on a synthetic statement (same layout as the real "Estado de Cuenta" export,
 * invented names and numbers).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import * as XLSX from 'xlsx';
import { parseFile } from '../src/parsers/index.ts';

function statement(rows: (string | number)[][], opening: number, closing: number, moneda = 'Pesos'): string {
  const grid: (string | number)[][] = [
    [], [], [],
    ['', 'Nombre', '', '', 'Tipo de cuenta', 'Moneda', 'Nro de cuenta'],
    ['', 'PEREZ JUAN', '', '', 'Caja de Ahorro', moneda, '1234567'],
    [],
    ['', 'Fecha', 'Concepto', '', 'Débito', 'Crédito', 'Saldo', 'Referencia', 'Destino'],
    ['', '30/01/2026', 'SALDO ANTERIOR', '', '', '', opening],
    ...rows.map((r) => ['', ...r]),
    ['', '', 'SALDO FINAL', '', '', '', closing],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), 'Estado de Cuenta');
  const path = join(mkdtempSync(join(tmpdir(), 'itau-')), 'itau.xls');
  writeFileSync(path, XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }));
  return path;
}

describe('itau-account parser', () => {
  test('parses kinds, merchants and reconciles the running balance', () => {
    const path = statement(
      [
        ['02/02/2026', 'COMPRA ANCAP 123', '', 500, '', 9500, '010226 PEREZ JUAN'],
        ['03/02/2026', 'REDIVA 19210ANCAP 123', '', '', 9.5, 9509.5],
        ['04/02/2026', 'DEB. CAMBIOSST....111111', '', 2000, '', 7509.5],
        ['05/02/2026', 'TRASPASO A 7654321ILINK', '', 1200, '', 6309.5, 'CUOTA FEBRERO'],
        ['06/02/2026', 'DEB. CAMBIOSTOLD22222222', '', 2600, '', 3709.5],
        ['06/02/2026', 'DEB. CAMBIOSCOM.22222222', '', 45, '', 3664.5],
        ['10/02/2026', 'CRE. CAMBIOSOP....333333', '', '', 40000, 43664.5],
        ['12/02/2026', 'DEB. VARIOS PAGO D.G.I.', '', 4000, '', 39664.5],
        ['15/02/2026', 'RETIRO BRED 999', '', 1000, '', 38664.5],
      ],
      10000,
      38664.5,
    );
    const { statement: st } = parseFile(path);
    assert.equal(st.source, 'itau-account');
    assert.deepEqual(st.checks.map((c) => c.ok), [true]);
    assert.equal(st.account.externalRef, '4567');
    assert.equal(st.account.defaultCurrency, 'UYU');
    assert.deepEqual(
      st.transactions.map((t) => [t.kind, t.amount, t.merchantHint]),
      [
        ['purchase', 500, 'ANCAP'],
        ['refund', -9.5, 'ANCAP'],
        ['transfer', 2000, 'Santander (cuenta propia)'],
        ['purchase', 1200, 'Cuota Febrero'],
        ['purchase', 2600, null],
        ['fee', 45, 'Itaú'],
        ['fx', -40000, 'Cambio de moneda'],
        ['tax', 4000, 'DGI'],
        ['cash_withdrawal', 1000, 'Efectivo'],
      ],
    );
    assert.equal(st.transactions[3].description, 'TRASPASO A 7654321ILINK · CUOTA FEBRERO');
    assert.ok(st.transactions[4].needsReview);
  });

  test('flags a statement whose balance does not chain', () => {
    const path = statement([['02/02/2026', 'COMPRA ANCAP', '', 500, '', 9400]], 10000, 9400, 'Dólares');
    const { statement: st } = parseFile(path);
    assert.equal(st.account.defaultCurrency, 'USD');
    assert.equal(st.checks[0].ok, false);
  });
});
