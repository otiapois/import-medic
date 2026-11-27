import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repairCsv } from '../../../src/core';
import { decodeCsv, parseCsv } from '../../../src/core/csv';
import { buildPriceDiff, parseBaseline, parseSupplier } from '../../../src/core/shopify-price-diff';

const bank = readFileSync(new URL('./guard-bank.csv', import.meta.url));
const baselineFixture = readFileSync(new URL('../../../fixtures/shopify-price-diff/baseline-agency.csv', import.meta.url));
const supplierFixture = readFileSync(new URL('../../../fixtures/shopify-price-diff/supplier-agency.csv', import.meta.url));
const csvCells = (csv: string) => parseCsv(decodeCsv(new TextEncoder().encode(csv)).text).records.map(({ cells }) => cells);
const formula = '=HYPERLINK("https://example.invalid")';

describe('guarded export byte replay', () => {
  it('escapes text in bank CSV output, preserves signed numbers, and audits exact source lines', () => {
    const plain = repairCsv(bank, 'bank.csv', 'quickbooks-bank');
    const guarded = repairCsv(bank, 'bank.csv', 'quickbooks-bank', { formulaGuard: true });
    expect(csvCells(plain.repairedCsv)[1].slice(1)).toEqual([formula, '-12.50']);
    expect(guarded.canDownload).toBe(true);
    expect(csvCells(guarded.repairedCsv).slice(1).map((row) => row.slice(1))).toEqual([["'" + formula, '-12.50'], ["'+medical", '42.01']]);
    expect(guarded.roundtripCheck).toEqual({ checked: true, autoFixableRemaining: 0, needsManualReviewCount: 0 });
    expect(guarded.formulaGuard).toEqual({ enabled: true, blocked: [], neutralized: [
      { row: 2, column: 'Description', before: formula, after: "'" + formula },
      { row: 3, column: 'Description', before: '+medical', after: "'+medical" },
    ] });
    expect(guarded.rows[0].before[1]).toBe(formula);
    expect(guarded.rows[0].after[1]).toBe("'" + formula);
  });

  it('blocks all native Shopify output rather than rewriting a title needed by a sibling update', () => {
    const source = Buffer.from(baselineFixture.toString('utf8').replace('  Canvas Jacket  ', '"  ' + formula.replaceAll('"', '""') + '  "'));
    const baseline = parseBaseline(source, 'baseline.csv');
    const supplier = parseSupplier(supplierFixture, 'supplier.csv').sheets[0];
    const resolutions = { 2: { skip: true } };
    const plain = buildPriceDiff(baseline, supplier, {}, resolutions);
    expect(plain.canDownload).toBe(true);
    expect(csvCells(plain.updateCsv!).slice(1).map((row) => row[1])).toEqual(['  ' + formula + '  ', '', '']);
    const guarded = buildPriceDiff(baseline, supplier, { formulaGuard: true }, resolutions);
    expect(guarded.canDownload).toBe(false);
    expect(guarded.updateCsv).toBeNull();
    expect(guarded.issues).toContainEqual(expect.objectContaining({ code: 'formula-guard-blocked', blocking: true }));
    const blocked = { row: 2, column: 'Title', before: '  ' + formula + '  ', after: "'  " + formula + '  ' };
    expect(guarded.formulaGuard).toEqual({ enabled: true, blocked: [blocked], neutralized: [] });
    expect(JSON.parse(guarded.auditJson).formulaGuard.blocked).toEqual([blocked]);
    expect(csvCells(guarded.auditCsv).some((row) => row[0] === 'Formula guard blocked cell' && row[3] === '2')).toBe(true);
  });
});
