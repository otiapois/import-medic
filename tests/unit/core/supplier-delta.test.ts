import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseBigCommerceBaseline } from '../../../src/core/bigcommerce-price-diff';
import { parseWooCommerceBaseline } from '../../../src/core/woocommerce-price-diff';
import { parseCsv, serializeCsv } from '../../../src/core/csv';
import { buildPriceDiff, parseBaseline, parseSupplier, type ColumnSelection } from '../../../src/core/shopify-price-diff';
import { createSupplierRecipe, parseSupplierRecipe, applySupplierRecipe, serializeSupplierRecipe } from '../../../src/core/shopify-price-diff/recipe';
import { createSignoffHtml } from '../../../src/core/shopify-price-diff/signoff-html';
import { buildSupplierDelta, inspectSupplierDeltaSource } from '../../../src/core/supplier-delta/engine';
import { listWorkbookSheets } from '../../../src/core/xlsx';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../../fixtures/supplier-delta/${name}`, import.meta.url)));
const workbook = fixture('synthetic-pricebook.xlsx');
const filename = 'synthetic-pricebook.xlsx';
const csvText = (text: string, name = 'supplier.csv') => ({ bytes: new TextEncoder().encode(text), filename: name });
const old = { bytes: fixture('synthetic-previous.csv'), filename: 'synthetic-previous.csv' };
const fresh = { bytes: workbook, filename, sheetName: 'Q4_Prices' };
const digest = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

describe('named XLSX worksheets', () => {
  it('lists only visible worksheets, keeps exact text and uses original sparse rows', () => {
    expect(listWorkbookSheets(workbook)).toEqual(['Instructions', 'Q4_Prices', 'Q3_Prices']);
    const legacy = parseSupplier(workbook, filename);
    expect(Object.keys(legacy)).toEqual(['name', 'sheets', 'issues']);
    expect(legacy.sheets[0].name).toBe('Instructions');
    const selected = parseSupplier(workbook, filename, { sheetName: 'Q4_Prices' });
    expect(selected).toMatchObject({ selectedSheet: 'Q4_Prices', sheetNames: ['Instructions', 'Q4_Prices', 'Q3_Prices'], issues: [] });
    expect(selected.sheets).toHaveLength(1);
    expect(selected.sheets[0].rows.map(({ line, cells }) => [line, cells[0].value])).toEqual([
      [2, '00123'], [4, '0045-BLK'], [8, 'KEPT'], [10, 'NEW-ONLY'],
    ]);
    for (const sheetName of ['q4_prices', 'Q4_Prices ', 'Cost_Chart', 'Hidden_Notes', 'Archived_Notes']) {
      expect(parseSupplier(workbook, filename, { sheetName })).toMatchObject({ sheets: [], issues: [{ code: 'missing-worksheet' }] });
    }
  });

  it('isolates worksheet content and rejects disallowed OOXML relationships across the whole archive', () => {
    const entries = unzipSync(workbook);
    const sheet = 'xl/worksheets/sheet1.xml';
    const malformed = zipSync({ ...entries, [sheet]: strToU8('<worksheet>') });
    expect(listWorkbookSheets(malformed)).toContain('Q4_Prices');
    expect(parseSupplier(malformed, filename).issues).toMatchObject([{ code: 'invalid-xlsx' }]);
    expect(parseSupplier(malformed, filename, { sheetName: 'Q4_Prices' }).sheets[0].headers).toEqual(['SKU', 'Cost', 'Inventory']);
    const dtd = zipSync({ ...entries, [sheet]: strToU8('<!DOCTYPE worksheet><worksheet/>') });
    expect(() => listWorkbookSheets(dtd)).toThrow('invalid-xlsx');
    const invalid = zipSync({ ...entries, 'xl/worksheets/_rels/sheet4.xml.rels': strToU8(
      '<Relationships><Relationship Id="ext" Type="pointer" Target="https://example.invalid/value" TargetMode="External"/></Relationships>',
    ) });
    expect(parseSupplier(invalid, filename, { sheetName: 'Q4_Prices' }).issues).toMatchObject([{ code: 'external-xlsx-relationship' }]);
  });

  it('writes the exact chosen worksheet into v6 recipes and Build receipts, while warning and blocking formulas without caches', () => {
    const selected = parseSupplier(workbook, filename, { sheetName: 'Q4_Prices' });
    const selection: ColumnSelection = { confirmed: true, joinKey: 'sku', skuColumn: 0, priceColumn: 1, inventoryColumn: 2,
      inventoryDropThresholdPercent: 75, conflictPolicy: 'prefer-first',
      pricingRule: { mode: 'tiered-brackets', fx: { sourceCurrency: 'USD', storeCurrency: 'CAD', fxRate: '1.25' },
        brackets: [{ mode: 'multiplier', multiplier: '2', upTo: '50' }, { mode: 'multiplier', multiplier: '1.5', upTo: null }] } };
    const created = createSupplierRecipe('Synthetic', selected.sheets[0].headers, selection, 'Q4_Prices', 'Store', { selectedSheet: 'Q4_Prices' });
    expect(created).toMatchObject({ ok: true, value: { version: 6, sheetName: 'Q4_Prices', selectedSheet: 'Q4_Prices', fxRateNeedsRecheck: true,
      inventoryColumn: 'Inventory', conflictPolicy: 'prefer-first' } });
    if (!created.ok) throw new Error('Expected workbook recipe');
    expect(parseSupplierRecipe(csvText(serializeSupplierRecipe(created.value)).bytes)).toEqual(created);
    const legacy = parseSupplier(workbook, filename);
    expect(applySupplierRecipe(created.value, legacy, 0)).toMatchObject({ ok: true, value: { sheetIndex: 1,
      selection: { inventoryColumn: 2, fxRateConfirmed: false, confirmed: false } } });
    expect(parseSupplierRecipe(csvText(JSON.stringify({ ...created.value, selectedSheet: 'Q3_Prices' })).bytes)).toMatchObject({
      ok: false, diagnostics: [{ code: 'invalid-recipe-schema' }],
    });
    if (created.value.version !== 6) throw new Error('Expected a version six recipe');
    expect(applySupplierRecipe({ ...created.value, sheetName: 'Hidden_Notes', selectedSheet: 'Hidden_Notes' }, legacy, 0))
      .toMatchObject({ ok: false, diagnostics: [{ code: 'recipe-missing-sheet' }] });

    const baseline = parseBaseline(fixture('synthetic-shopify.csv'));
    const before = { ...selection, pricingRule: { mode: 'direct' } as const, inventoryColumn: null };
    const actual = buildPriceDiff(baseline, selected.sheets[0], before);
    expect(actual.canDownload).toBe(true);
    expect(JSON.parse(actual.auditJson).supplier.selectedSheet).toBe('Q4_Prices');
    const custody = { baselineSha256: digest(fixture('synthetic-shopify.csv')), suppliers: [
      { filename, sha256: digest(workbook), bytes: workbook.length, selectedSheet: 'Q4_Prices' },
    ] };
    expect(createSignoffHtml(baseline, actual, undefined, undefined, custody)).toContain('Worksheet: Q4_Prices');
    const entries = unzipSync(workbook);
    const path = 'xl/worksheets/sheet2.xml';
    const noCache = zipSync({ ...entries, [path]: strToU8(strFromU8(entries[path]).replace('<v>10.00</v>', '<f>SUM(10)</f>')) });
    const sheet = parseSupplier(noCache, filename, { sheetName: 'Q4_Prices' }).sheets[0];
    const blocked = buildPriceDiff(baseline, sheet, before);
    expect(blocked.canDownload).toBe(false);
    expect(blocked.issues).toContainEqual(expect.objectContaining({ code: 'formula-without-cached-value', row: 4, column: 'Cost', blocking: false }));
    const mappedSkuFormula = zipSync({ ...entries, [path]: strToU8(strFromU8(entries[path]).replace('<v>28.50</v>', '<f>SUM(28.5)</f>')) });
    const matchingFormula = parseSupplier(mappedSkuFormula, filename, { sheetName: 'Q4_Prices' }).sheets[0];
    for (const [platform, parse] of [['woocommerce', parseWooCommerceBaseline], ['bigcommerce', parseBigCommerceBaseline]] as const) {
      const file = readFileSync(new URL(`../../../fixtures/${platform}-price-diff/baseline.csv`, import.meta.url));
      const baseline = parse(file, 'baseline.csv');
      const blocked = buildPriceDiff(baseline, matchingFormula, before);
      expect(blocked.canDownload).toBe(false);
      expect(blocked.issues).toContainEqual(expect.objectContaining({ code: 'formula-without-cached-value', row: 2, column: 'Cost', blocking: false }));
      expect(JSON.parse(blocked.auditJson).supplier.selectedSheet).toBe('Q4_Prices');
      expect(createSignoffHtml(baseline, blocked, undefined, undefined, custody)).toContain('Worksheet: Q4_Prices');
    }
  });
});

describe('Supplier Delta', () => {
  it('classifies the synthetic supplier pair and hashes the exact downloaded bytes', async () => {
    expect(inspectSupplierDeltaSource(fresh)).toMatchObject({ selectedSheet: 'Q4_Prices', headers: ['SKU', 'Cost', 'Inventory'],
      suggestions: { mapping: { skuColumn: 0, costColumn: 1, inventoryColumn: 2 } }, rowCount: 4 });
    const comparison = await buildSupplierDelta(old, fresh);
    expect(comparison).toMatchObject({ status: 'ready', maxHikePercent: '14.00',
      counts: { 'cost-increased': 1, 'cost-decreased': 1, unchanged: 1, 'added-sku': 1, 'removed-sku': 1 } });
    expect(comparison.rows).toMatchObject([
      { sku: '00123', delta: '+3.50', deltaPercent: '+14.00', inventoryDelta: '-5', previousRow: 2, newRow: 2 },
      { sku: '0045-BLK', delta: '-2.20', deltaPercent: '-18.03', inventoryDelta: '2', previousRow: 3, newRow: 4 },
      { sku: 'KEPT', delta: '0.00', inventoryDelta: '2', previousRow: 4, newRow: 8 },
      { sku: 'OLD-ONLY', previousRow: 5, newRow: null },
      { sku: 'NEW-ONLY', previousRow: null, newRow: 10 },
    ]);
    const audit = JSON.parse(comparison.auditJson);
    expect(audit.sources.next.selectedSheet).toBe('Q4_Prices');
    expect(comparison.custody).toEqual({ previousSha256: digest(old.bytes), newSha256: digest(workbook),
      deltaCsvSha256: digest(comparison.deltaCsv!), signOffHtmlSha256: digest(comparison.signOffHtml!) });
    expect(audit.custody).toEqual(comparison.custody);
    expect(parseCsv(comparison.deltaCsv!).records[1].cells[0]).toBe('00123');
    expect(comparison.deltaCsv).toContain('\r\n');
    expect(comparison.signOffHtml).toContain('id="major-only"');
    expect(comparison.signOffHtml).toContain(comparison.custody.deltaCsvSha256!);
  });

  it('reports identical duplicate SKUs on their physical multiline CSV records and withholds output', async () => {
    const duplicate = csvText('SKU,Cost,Note\r\n00123,28.50,"first\r\nsecond"\r\n0045-BLK,10.00,ok\r\n00123,28.50,repeated');
    const held = await buildSupplierDelta(old, duplicate);
    expect(held).toMatchObject({ status: 'blocked', deltaCsv: null, signOffHtml: null, counts: { 'blocked-duplicate-sku': 1 } });
    expect(held.issues).toContainEqual(expect.objectContaining({ side: 'next', code: 'blocked-duplicate-sku', sku: '00123', rows: [2, 5] }));
    expect(JSON.parse(held.auditJson).custody).toEqual({ previousSha256: digest(old.bytes), newSha256: digest(duplicate.bytes) });
  });

  it('guards spreadsheet formulas in CSV and escapes user input in the offline report', async () => {
    const riskySku = '="><script>https://example.invalid</script>';
    const old = csvText(serializeCsv(['SKU', 'Price'], [[riskySku, '1']], 'supplier-delta'));
    const next = csvText(serializeCsv(['SKU', 'Price'], [[riskySku, '3']], 'supplier-delta'), 'https://example.invalid/<img>.csv');
    const result = await buildSupplierDelta(old, next);
    expect(result.status).toBe('ready');
    expect(parseCsv(result.deltaCsv!).records[1].cells[0]).toBe("'" + riskySku);
    expect(result.rows[0].sku).toBe(riskySku);
    expect(result.signOffHtml).not.toMatch(/https:\/\/|<script|<img\b/);
    expect(result.signOffHtml).toContain('script-src \'none\'');
  });

  it('handles explicit mapping, exact rounded percentages, zero costs and incompatible currencies', async () => {
    const previous = csvText('Product ID,Rate,Unused,Warehouse\n00123,10000000000,1,6\nZERO,0.00,0,2');
    const next = csvText('SKU,Wholesale cost,Price,Inventory\n00123,10000499999,1,11\nZERO,0.005,0,2');
    const mapping = { previous: { skuColumn: 0, costColumn: 1, inventoryColumn: 3 }, next: { costColumn: 1 } };
    expect(await buildSupplierDelta(previous, fresh)).toMatchObject({ status: 'blocked',
      counts: { 'added-sku': 0, 'removed-sku': 0 }, rows: [] });
    const result = await buildSupplierDelta(previous, next, mapping);
    expect(result.rows).toMatchObject([{ delta: '+499999.00', deltaPercent: '+0.00', inventoryDelta: '5' },
      { delta: '+0.005', deltaPercent: null }]);
    expect(result.maxHikePercent).toBe('0.00');
    const amounts = await buildSupplierDelta(csvText('SKU,Cost (USD)\n00123,10'), csvText('SKU,Cost,Currency\n00123,20,EUR'));
    expect(amounts).toMatchObject({ status: 'blocked', counts: { 'blocked-currency': 1 }, rows: [{ delta: null }] });
    expect(amounts.issues).toContainEqual(expect.objectContaining({ code: 'currency-conflict', blocking: true }));
  });
});
