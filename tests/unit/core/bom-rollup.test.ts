import { readFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../../../src/core/audit/custody';
import { parseBom, rollupBom, type BomCost } from '../../../src/core/bom/rollup';
import { decodeCsv, parseCsv } from '../../../src/core/csv';
import { buildMultiSupplierDiff, buildPriceDiff, parseSupplier } from '../../../src/core/shopify-price-diff';
import { createSignoffHtml } from '../../../src/core/shopify-price-diff/signoff-html';
import type { ColumnSelection } from '../../../src/core/shopify-price-diff/types';
import { inspectImport } from '../../../src/core/verify-import/inspector';
import { runPriceComparison, simulatePriceScenarios, type PriceComparison } from '../../../src/core/whatif/simulator';

import { syntheticBomBaseline } from './bom-fixtures';

const bytes = (value: string) => new TextEncoder().encode(value);
const bom = (value: string) => parseBom(bytes(value), 'parts.csv');
const cost = (cents: bigint): BomCost => ({ cents, source: { kind: 'baseline', filename: 'base.csv', line: 2, column: 'Cost' } });
const selection = { confirmed: true, pricingRule: { mode: 'multiplier', multiplier: '2' } } as const;
const basicBom = 'Bundle SKU,Component SKU,Quantity,Assembly Cost\nSUB,00123,2,0.75\nSUB,WRAP,1,0.750\nKIT,SUB,2,1.50\nKIT,BOX,1,';
const source = (data = 'SKU,Cost\n00123,3.00', name = 'supplier.csv') => parseSupplier(bytes(data), name).sheets[0];
const catalog = [
  ['00123', '5.000', '2.50'], ['WRAP', '2.500', '1.25'], ['BOX', '4.000', '2.00'],
  ['SUB', '14.000', '7.00'], ['KIT', '35.000', '17.50'],
] as const;

describe('M17 bundle BOM', () => {
  it.each(['shopify', 'woocommerce', 'bigcommerce'] as const)('rolls up and replays the native %s byte pair', async (platform) => {
    const { baseline, data } = syntheticBomBaseline(platform, catalog);
    const result = buildPriceDiff(baseline, source(), selection, {}, undefined, undefined, undefined, { sheet: bom(basicBom) });
    expect(result.issues).toEqual([]);
    expect(result.bom?.kits).toMatchObject([
      { sku: 'SUB', baselineLine: 5, lines: [2, 3], depth: 1, oldCost: '7.00', oldCostSource: 'baseline', assemblyCost: '0.75', assemblyLine: 2,
        newCost: '8.00', newRetail: '16.00', grossMarginPercent: '50.00', components: [
          { sku: '00123', line: 2, quantity: '2', unitCost: '3.00', extendedCost: '6.00', source: { kind: 'supplier', line: 2, column: 'Cost' } },
          { sku: 'WRAP', line: 3, quantity: '1', unitCost: '1.25', extendedCost: '1.25', source: { kind: 'baseline', line: 3 } },
        ] },
      { sku: 'KIT', baselineLine: 6, lines: [4, 5], depth: 2, oldCost: '17.50', newCost: '19.50', newRetail: '39.00', grossMarginPercent: '50.00',
        components: [{ sku: 'SUB', line: 4, unitCost: '8.00', extendedCost: '16.00', source: { kind: 'bundle', line: 2 } }, { sku: 'BOX', line: 5 }] },
    ]);
    expect(result.canDownload).toBe(true);
    const { updateBytes, rollbackBytes } = result;
    expect(parseCsv(decodeCsv(updateBytes!).text).records.slice(1).map(({ cells }) => cells.at(-1))).toEqual(['6.00', '16.00', '39.00']);
    expect(parseCsv(decodeCsv(rollbackBytes!).text).records.slice(1).map(({ cells }) => cells.at(-1))).toEqual(['5.000', '14.000', '35.000']);
    const replay = await inspectImport(platform, data, rollbackBytes!, updateBytes!);
    expect(replay).toMatchObject({ verdict: 'PASS', nonTargetMutations: 0, brokenGroups: 0, rollback: { scope: 'paired-update', residualDiffs: 0, restored: true } });
    const custody = { baselineSha256: await sha256(data), suppliers: [], bom: { filename: 'parts.csv', bytes: bytes(basicBom).length, sha256: await sha256(bytes(basicBom)) },
      updateCsvSha256: await sha256(updateBytes!), rollbackCsvSha256: await sha256(rollbackBytes!) };
    expect(JSON.parse(result.serializeAuditJson(custody))).toMatchObject({ bom: result.bom, custody });
    const html = createSignoffHtml(baseline, result, undefined, undefined, custody);
    expect(html).toContain('Bundle Cost Rollup');
    expect(html).toContain('Baseline cost · store.csv · Row 3 ·');
    expect(html).toContain(custody.bom.sha256);
    expect(parseCsv(result.auditCsv).records[0].cells.at(-1)).toBe('Review and Resolution (JSON)');
  });

  it('retains the physical start line of each quoted record and reports the exact cycle', () => {
    const input = bom('Bundle SKU,Component SKU,Quantity,Assembly Cost,Notes\r\nKIT-A,KIT-B,1,,"first\r\nsecond"\r\n\r\nKIT-B,KIT-C,1,,\r\nKIT-C,KIT-A,1,,');
    const result = rollupBom(input, () => ({ previous: null, current: null }));
    expect(result.issues).toMatchObject([{ source: 'bom', code: 'bom-cycle', row: 2, rows: [2, 5, 6], bomPath: ['KIT-A', 'KIT-B', 'KIT-C', 'KIT-A'] }]);
    expect(result.kits.every(({ newCost }) => newCost === null)).toBe(true);
  });

  it('reads text and numeric cell types from a sparse XLSX with original row numbers', () => {
    const fixture = readFileSync(new URL('../../../fixtures/shopify-price-diff/supplier-numeric.xlsx', import.meta.url));
    const entries = unzipSync(fixture);
    const worksheet = 'xl/worksheets/sheet1.xml';
    const text = strFromU8(entries[worksheet]);
    entries[worksheet] = strToU8(text.replace(/<sheetData[\s\S]*?<\/sheetData>/,
      '<sheetData><row r="3"><c r="A3" t="inlineStr"><is><t>Bundle SKU</t></is></c><c r="B3" t="inlineStr"><is><t>Component SKU</t></is></c><c r="C3" t="inlineStr"><is><t>Quantity</t></is></c></row>'
      + '<row r="9"><c r="A9" t="inlineStr"><is><t>KIT-0001</t></is></c><c r="B9" t="inlineStr"><is><t>00123</t></is></c><c r="C9"><v>2</v></c></row>'
      + '<row r="12"><c r="A12" t="inlineStr"><is><t>KIT-0001</t></is></c><c r="B12"><v>00124</v></c><c r="C12"><v>1</v></c></row></sheetData>'));
    const table = parseBom(zipSync(entries), 'sparse.xlsx');
    expect(table.rowCount).toBe(2);
    expect(table.worksheet).toBeTruthy();
    const result = rollupBom(table, (sku) => sku === '00123' ? { current: cost(100n), previous: null } : { current: null, previous: null });
    expect(result.issues).toMatchObject([{ code: 'invalid-bom-sku', row: 12, column: 'Component SKU' }]);
    expect(result.kits[0]).toMatchObject({ sku: 'KIT-0001', newCost: '2.00', components: [{ sku: '00123', line: 9 }] });
  });

  it('invalidates blank, fractional, nonpositive, and malformed quantities on their own lines', () => {
    const input = bom('Bundle SKU,Component SKU,Quantity,Assembly Cost\nKIT,A,,\nKIT,B,0.50,\nKIT,C,0,\nKIT,D,-2,\nKIT,E,2x,\nKIT,F,1,-4.00\nKIT,G,1,0.01\nKIT,H,1,0.02\nKIT,G,1,0.01');
    expect(input.issues.map(({ code, row }) => [code, row])).toEqual([
      ['invalid-bom-quantity', 2], ['invalid-bom-quantity', 3], ['invalid-bom-quantity', 4], ['invalid-bom-quantity', 5],
      ['invalid-bom-quantity', 6], ['invalid-bom-assembly-cost', 7], ['conflicting-bom-assembly-cost', 9], ['duplicate-bom-component', 10],
    ]);
  });

  it('reports a five-level chain as supported and a sixth bundle with exact lines', () => {
    const rows = ['A,B,1', 'B,C,1', 'C,D,1', 'D,E,1', 'E,F,1', 'F,LEAF,1'];
    const result = rollupBom(bom('Bundle SKU,Component SKU,Quantity\n' + rows.join('\n')), () => ({ previous: cost(25n), current: cost(25n) }));
    expect(result.issues).toMatchObject([{ code: 'bom-depth-limit', rows: [2, 3, 4, 5, 6], bomPath: ['A', 'B', 'C', 'D', 'E', 'F'] }]);
    expect(result.kits.slice(0, 2)).toMatchObject([{ sku: 'A', depth: 6, newCost: null }, { sku: 'B', depth: 5, newCost: '0.25' }]);
  });

  it('reports recorded, recomputed, and unknown old costs from cost evidence, including zero', () => {
    const records = [['00123', '12', '0.00'], ['WRAP', '10', '0.20'], ['SUB', '4', ''], ['KIT', '8', '']] as const;
    const { baseline } = syntheticBomBaseline('shopify', records);
    const sheet = bom('Bundle SKU,Component SKU,Quantity\nSUB,00123,2\nSUB,WRAP,1\nKIT,SUB,2');
    const result = buildPriceDiff(baseline, source('SKU,Cost\n00123,0.00'), { ...selection, dropThresholdPercent: 100 }, {}, undefined, undefined, undefined, { sheet });
    expect(result.canDownload).toBe(true);
    expect(result.rows[0]).toMatchObject({ newPrice: '12', status: 'Unchanged' });
    expect(result.bom?.kits).toMatchObject([
      { sku: 'SUB', oldCost: '0.20', newCost: '0.20', oldCostSource: 'recomputed', components: [{ unitCost: '0.00', previousUnitCost: '0.00' }, { unitCost: '0.20' }] },
      { sku: 'KIT', oldCost: '0.40', newCost: '0.40', oldCostSource: 'recomputed' },
    ]);
    const without = syntheticBomBaseline('shopify', [['00123', '12', ''], ...records.slice(1)]).baseline;
    const other = buildPriceDiff(without, source('SKU,Cost\n00123,0.00'), { ...selection, dropThresholdPercent: 100 }, {}, undefined, undefined, undefined, { sheet });
    expect(other.bom?.kits.map(({ oldCost, oldCostSource }) => [oldCost, oldCostSource])).toEqual([[null, null], [null, null]]);
  });

  it('fails closed on unpriced, ambiguous, or retail-only components', () => {
    const { baseline } = syntheticBomBaseline('shopify', [['00123', '12', '2.50'], ['WRAP', '10', ''], ['SUB', '4', '1'], ['KIT', '8', '3']]);
    const sheet = bom('Bundle SKU,Component SKU,Quantity\nSUB,WRAP,2\nSUB,UNKNOWN,1\nKIT,SUB,2');
    const run = buildPriceDiff(baseline, source(), selection, {}, undefined, undefined, undefined, { sheet });
    expect(run.bom?.issues).toMatchObject([{ code: 'orphan-component', row: 2, value: 'WRAP' }, { code: 'orphan-component', row: 3, value: 'UNKNOWN' }]);
    expect(run).toMatchObject({ canDownload: false, updateBytes: null, rollbackBytes: null });
    const ambiguous = syntheticBomBaseline('shopify', catalog, ['Unit Cost'], catalog.map(() => ['9'])).baseline;
    const attempt = buildPriceDiff(ambiguous, source(), selection, {}, undefined, undefined, undefined, { sheet: bom(basicBom) });
    expect(attempt.bom?.issues.every(({ message }) => message.includes('ambiguous baseline cost'))).toBe(true);
    const offers = [{ supplierId: 'prices', filename: 'price.csv', sheet: source('SKU,Price\n00123,7'), selection: { confirmed: true } },
      { supplierId: 'costs', filename: 'cost.csv', sheet: source('SKU,Cost\nWRAP,2'), selection }];
    const retail = buildMultiSupplierDiff(baseline, offers, {}, undefined, undefined, { sheet: bom('Bundle SKU,Component SKU,Quantity\nKIT,00123,1') });
    expect(retail.bom?.issues).toMatchObject([{ code: 'orphan-component', row: 2, value: '00123' }]);
    expect(retail.canDownload).toBe(false);
  });

  it('converts unit cost once at confirmed FX and holds inconsistent baseline currency', () => {
    const data = syntheticBomBaseline('shopify', catalog, ['Currency'], catalog.map(() => ['USD']));
    const rules: ColumnSelection = { ...selection, fxRateConfirmed: true,
      pricingRule: { ...selection.pricingRule, fx: { sourceCurrency: 'EUR', storeCurrency: 'USD', fxRate: '1.125' } } };
    const supplier = source('SKU,Cost,Currency\n00123,2.68,EUR');
    const sheet = bom(basicBom);
    const go = buildPriceDiff(data.baseline, supplier, rules, {}, undefined, undefined, undefined, { sheet });
    expect(go.canDownload).toBe(true);
    expect(go.bom).toMatchObject({ currency: 'USD', kits: [{ newCost: '8.04', newRetail: '16.08',
      components: [{ unitCost: '3.02', source: { kind: 'supplier', currency: 'USD', fx: rules.pricingRule?.fx } }, { unitCost: '1.25' }] },
    { newCost: '19.58', newRetail: '39.16' }] });
    const notConfirmed = buildPriceDiff(data.baseline, supplier, { ...rules, fxRateConfirmed: false }, {}, undefined, undefined, undefined, { sheet });
    expect(notConfirmed.issues.some(({ code }) => code === 'fx-rate-confirmation-required')).toBe(true);
    expect(notConfirmed.canDownload).toBe(false);
    const mixed = syntheticBomBaseline('shopify', catalog, ['Currency'], catalog.map(() => ['CAD'])).baseline;
    const inconsistent = buildPriceDiff(mixed, supplier, rules, {}, undefined, undefined, undefined, { sheet });
    expect(inconsistent.bom?.issues).toMatchObject([{ code: 'bom-currency-conflict' }]);
    expect(inconsistent.bom?.kits.every(({ newCost, newRetail }) => newCost === null && newRetail === null)).toBe(true);
    expect(inconsistent.canDownload).toBe(false);
  });

  it('requires an explicit kit rule when mapped rules disagree, honoring the supplier component winner', () => {
    const { baseline } = syntheticBomBaseline('shopify', catalog);
    const suppliers = [{ supplierId: 'first', filename: 'first.csv', sheet: source('SKU,Cost\n00123,3.10'), selection },
      { supplierId: 'second', filename: 'second.csv', sheet: source(), selection: { ...selection, pricingRule: { mode: 'multiplier', multiplier: '3' } as const } }];
    const settings = { conflictPolicy: 'prefer-first', conflictPolicyConfirmed: true } as const;
    const input = { sheet: bom(basicBom) };
    const held = buildMultiSupplierDiff(baseline, suppliers, settings, undefined, undefined, input);
    expect(held.bom?.issues).toMatchObject([{ code: 'bom-pricing-rule-required' }]);
    expect(held.canDownload).toBe(false);
    const result = buildMultiSupplierDiff(baseline, suppliers, settings, undefined, undefined, { ...input, pricingSupplierId: 'second' });
    expect(result.canDownload).toBe(true);
    expect(result.bom?.kits[0]).toMatchObject({ newCost: '8.20', newRetail: '24.60', pricingSupplierId: 'second',
      components: [{ source: { supplierId: 'first' } }, { source: { kind: 'baseline' } }] });
    const competing = buildPriceDiff(baseline, source('SKU,Cost\n00123,3\nKIT,19'), selection, {}, undefined, undefined, undefined, input);
    expect(competing.bom?.issues).toMatchObject([{ code: 'bom-bundle-supplier-conflict', row: 4 }]);
    expect(competing.canDownload).toBe(false);
    const supported = buildPriceDiff(baseline, source('SKU,Cost\n00123,3\nKIT,19'), selection, { 3: { skip: true } }, undefined, undefined, undefined, input);
    expect(supported.canDownload).toBe(true);
  });

  it('accepts an exact supplier-only component cost without creating a native catalog row', () => {
    const { baseline } = syntheticBomBaseline('shopify', catalog.slice(1));
    const supplier = source('SKU,Cost,Currency\n00123,3.00,USD');
    const input = { sheet: bom(basicBom) };
    const blocked = buildPriceDiff(baseline, supplier, selection, {}, undefined, undefined, undefined, input);
    expect(blocked.issues.some(({ code }) => code === 'currency-confirmation-required')).toBe(true);
    expect(blocked.canDownload).toBe(false);
    const confirmed = { ...selection, sameCurrencyConfirmed: true };
    const result = buildPriceDiff(baseline, supplier, confirmed, {}, undefined, undefined, undefined, input);
    expect(result.canDownload).toBe(true);
    expect(result.bom?.kits).toMatchObject([{ newCost: '8.00', components: [{ sku: '00123', source: { kind: 'supplier', line: 2 }, previousUnitCost: null }, { sku: 'WRAP' }] },
      { newCost: '19.50' }]);
    expect(result.rows.find(({ sku }) => sku === '00123')).toMatchObject({ status: 'Unmatched Supplier Row', baselineRow: null });
    expect(result.updateCsv).not.toContain('00123');
    const suppliers = [{ supplierId: 'a', sheet: supplier, filename: 'a.csv', selection: confirmed },
      { supplierId: 'b', sheet: source('SKU,Cost,Currency\n00123,3.10,USD'), filename: 'b.csv', selection: confirmed }];
    expect(buildMultiSupplierDiff(baseline, suppliers, {}, undefined, undefined, input).canDownload).toBe(false);
    const chosen = buildMultiSupplierDiff(baseline, suppliers, { conflictPolicy: 'prefer-last', conflictPolicyConfirmed: true }, undefined, undefined, input);
    expect(chosen.canDownload).toBe(true);
    expect(chosen.bom?.kits[0]).toMatchObject({ newCost: '8.20', components: [{ source: { supplierId: 'b' } }, { sku: 'WRAP' }] });
    expect(chosen.updateCsv).not.toContain('00123');
  });

  it('does not coalesce equivalent retail offers with different confirmed costs', () => {
    const { baseline } = syntheticBomBaseline('shopify', catalog);
    const make = (supplierId: string, fxRate: string, multiplier: string) => ({
      supplierId, filename: supplierId + '.csv', sheet: source('SKU,Cost,Currency\n00123,3.00,EUR'),
      selection: { confirmed: true, fxRateConfirmed: true, pricingRule: { mode: 'multiplier' as const, multiplier,
        fx: { sourceCurrency: 'EUR', storeCurrency: 'USD', fxRate } } },
    });
    const suppliers = [make('one', '1', '2'), make('two', '2', '1')];
    const input = { sheet: bom(basicBom), pricingSupplierId: 'one' };
    const result = buildMultiSupplierDiff(baseline, suppliers, {}, undefined, undefined, input);
    expect(result.issues.some(({ code }) => code === 'supplier-conflict')).toBe(true);
    expect(result.canDownload).toBe(false);
    const chosen = buildMultiSupplierDiff(baseline, suppliers, { conflictPolicy: 'prefer-first', conflictPolicyConfirmed: true }, undefined, undefined, input);
    expect(chosen.canDownload).toBe(true);
    expect(chosen.bom?.kits[0]).toMatchObject({ newCost: '8.00', components: [{ source: { supplierId: 'one' } }, { source: { kind: 'baseline' } }] });
  });

  it('keeps the BOM attached across scenario simulation and reapplication', () => {
    const { baseline } = syntheticBomBaseline('shopify', catalog);
    const comparison: PriceComparison = { kind: 'single', supplier: { supplierId: 'primary', filename: 'supplier.csv', sheet: source(), selection },
      bom: { sheet: bom(basicBom) } };
    const original = runPriceComparison(baseline, comparison);
    const [scenario] = simulatePriceScenarios(baseline, comparison, [{ id: 'plus', markupPercent: '10' }], original);
    expect(scenario).toMatchObject({ canApply: true, changedSkuCount: 3, totalRetailDeltaCents: '1310' });
    const applied = runPriceComparison(baseline, { ...comparison, supplier: { ...comparison.supplier,
      selection: { ...selection, pricingRule: scenario.suppliers[0].pricingRule } } });
    expect(applied.bom?.kits).toMatchObject([{ newCost: '8.00', newRetail: '17.60' }, { newCost: '19.50', newRetail: '42.90' }]);
  });

  it('holds kits crossing a movement guard or selling below cost, and escapes BOM evidence in the offline report', () => {
    const kit = '<img src=x onerror=alert(1)>';
    const { baseline } = syntheticBomBaseline('shopify', [...catalog.slice(0, -1), [kit, '35', '17.50']]);
    const sheet = bom(basicBom.replaceAll('KIT,', kit + ','));
    const result = buildPriceDiff(baseline, source(), { ...selection, increaseThresholdPercent: 5 }, {}, undefined, undefined, undefined, { sheet });
    expect(result.bom?.issues).toMatchObject([{ code: 'bom-price-movement' }, { code: 'bom-price-movement' }]);
    expect(result.canDownload).toBe(false);
    const html = createSignoffHtml(baseline, result);
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain(kit);
    const small = buildPriceDiff(baseline, source(), { ...selection, pricingRule: { mode: 'multiplier', multiplier: '0.60' } },
      {}, undefined, undefined, undefined, { sheet });
    expect(small.bom?.issues.some(({ code }) => code === 'bom-below-cost')).toBe(true);
    expect(small.canDownload).toBe(false);
  });
});
