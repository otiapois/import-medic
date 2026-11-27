import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBigCommerceBaseline } from '../../../src/core/bigcommerce-price-diff/source';
import { parseCsv, serializeCsv } from '../../../src/core/csv';
import { buildMultiSupplierDiff, buildPriceDiff, parseBaseline, parseSupplier, previewPricingFormula } from '../../../src/core/shopify-price-diff';
import { createSignoffHtml } from '../../../src/core/shopify-price-diff/signoff-html';
import type { ColumnSelection } from '../../../src/core/shopify-price-diff/types';
import { inspectImport } from '../../../src/core/verify-import/inspector';

const bytes = (csv: string) => new TextEncoder().encode(csv);
const matrix = (text: string) => parseCsv(text).records.map(({ cells, parseError }) => {
  expect(parseError).toBeUndefined();
  return cells;
});
const fixture = (name: string) => readFileSync(new URL('../../../fixtures/' + name, import.meta.url), 'utf8');
const supplier = (text: string) => parseSupplier(bytes(text), 'supplier.csv').sheets[0];
const marketCsv = fixture('shopify-price-diff/baseline-markets.csv');
const marketBaseline = parseBaseline(bytes(marketCsv));
const fx: ColumnSelection = { market: 'UAE', confirmed: true, fxRateConfirmed: true,
  pricingRule: { mode: 'direct', fx: { sourceCurrency: 'USD', storeCurrency: 'AED', fxRate: '3.6725' } } };
const bigCsv = fixture('bigcommerce-price-diff/baseline.csv');
const bigBaseline = parseBigCommerceBaseline(bytes(bigCsv));
const bigSupplier = supplier(fixture('bigcommerce-price-diff/supplier.csv'));
const bigSelection = { confirmed: true, compareAtColumn: 2, inventoryColumn: 3 };
const scopeColumns = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Price / UAE'];

describe('M11 Shopify Markets', () => {
  it('applies exact manual FX to one market and carries every original variant without other storefront columns', async () => {
    expect(marketBaseline.markets).toEqual([
      { name: 'UAE', priceHeader: 'Price / UAE', compareAtHeader: 'Compare At Price / UAE' },
      { name: 'European Union', priceHeader: 'Price / European Union', compareAtHeader: 'Compare At Price / European Union' },
    ]);
    const sheet = supplier('SKU,Price,Currency\n00001,12,USD');
    expect(previewPricingFormula(marketBaseline, sheet, fx)).toMatchObject({ computedPrice: '44.07' });
    const run = buildPriceDiff(marketBaseline, sheet, fx);
    expect(run.issues).toEqual([]);
    expect(run).toMatchObject({ canDownload: true, market: marketBaseline.markets![0],
      verification: { nonTargetFieldsChanged: 0, brokenVariantGroups: 0 },
      rollbackVerification: { checked: true, restoredVariants: 2 } });
    expect(matrix(run.updateCsv!)).toEqual([scopeColumns, ['filter', 'Filter & Travel Case', 'Color', 'Red', '00001', '44.07'], ['filter', '', '', 'Blue', '00002', '']]);
    expect(matrix(run.rollbackCsv!)[1].at(-1)).toBe('036.7250');
    expect(JSON.parse(run.auditJson)).toMatchObject({ market: marketBaseline.markets![0], rows: [{ sku: '00001', market: marketBaseline.markets![0] }, { sku: '00002' }] });
    expect(matrix(run.auditCsv)[0]).toContain('Market');
    expect(createSignoffHtml(marketBaseline, run, fx.pricingRule)).toContain('Price / UAE');
    expect(await inspectImport('shopify', bytes(marketCsv), run.updateBytes!)).toMatchObject({ verdict: 'PASS', market: marketBaseline.markets![0], unchangedSiblingSkus: 1 });
    expect(await inspectImport('shopify', bytes(marketCsv), run.rollbackBytes!, run.updateBytes!)).toMatchObject({ verdict: 'PASS', rollback: { restored: true, residualDiffs: 0 } });
    const base = buildPriceDiff(marketBaseline, sheet, { confirmed: true, sameCurrencyConfirmed: true });
    expect(base.market).toBeUndefined();
    expect(matrix(base.updateCsv!)[0]).toContain('Variant Price');
    expect(matrix(base.updateCsv!)[0]).not.toContain('Price / UAE');
    expect(await inspectImport('shopify', bytes(marketCsv), base.rollbackBytes!, run.updateBytes!))
      .toMatchObject({ verdict: 'FAIL_UNSAFE', issues: [expect.objectContaining({ code: 'rollback-scope-mismatch' })] });
  });

  it('rejects unchanged invalid effective compare-at, inherited edits, inventory and incorrect market casing', async () => {
    const [headers, original, sibling] = matrix(marketCsv);
    const offered = supplier('SKU,Price\n00001,49.95');
    const selected = { market: 'UAE', confirmed: true };
    const againstUnchanged = buildPriceDiff(marketBaseline, offered, selected);
    expect(againstUnchanged.issues).toContainEqual(expect.objectContaining({ code: 'compare-at-not-above-price', column: 'Compare At Price / UAE' }));
    const candidate = (columns: string[], rows: string[][]) => bytes(serializeCsv(columns, rows.map(row => columns.map(column => row[headers.indexOf(column)])), 'shopify-products'));
    const invalid = [...original];
    invalid[headers.indexOf('Price / UAE')] = '49.95';
    expect((await inspectImport('shopify', bytes(marketCsv), candidate(scopeColumns, [invalid, sibling]))).issues)
      .toContainEqual(expect.objectContaining({ code: 'compare-at-not-above-price' }));
    const inherited = buildPriceDiff(marketBaseline, supplier('SKU,Price\n00002,33'), selected);
    expect(inherited.issues).toContainEqual(expect.objectContaining({ code: 'market-inherited-price' }));
    expect(buildPriceDiff(marketBaseline, offered, { ...selected, market: 'uae' })).toMatchObject({ canDownload: false });
    expect(buildPriceDiff(marketBaseline, supplier('SKU,Price,Stock\n00001,37,6'), { ...selected, inventoryColumn: 2 }).issues)
      .toContainEqual(expect.objectContaining({ code: 'market-inventory-out-of-scope' }));
    for (const column of ['Variant Price', 'Price / European Union', 'Included / UAE', 'Body (HTML)', 'Variant Inventory Qty']) {
      const check = await inspectImport('shopify', bytes(marketCsv), candidate([...scopeColumns, column], [original, sibling]));
      expect(check.verdict).toBe('FAIL_UNSAFE');
      expect(check.issues).toContainEqual(expect.objectContaining({ code: 'forbidden-column', column }));
    }
    const inputs = [{ supplierId: 'a', filename: 'supplier.csv', sheet: supplier('SKU,Price\n00001,44'), selection: { confirmed: true } }];
    const batch = buildMultiSupplierDiff(marketBaseline, inputs, { market: 'UAE' });
    expect(batch).toMatchObject({ canDownload: true, market: { priceHeader: 'Price / UAE' } });
    expect(buildMultiSupplierDiff(marketBaseline, [{ ...inputs[0], selection: { market: 'European Union' } }], { market: 'UAE' }).issues)
      .toContainEqual(expect.objectContaining({ code: 'mixed-shopify-market' }));
  });
});

describe('M11 BigCommerce legacy', () => {
  it('preserves a legacy Product SKU header and holds ambiguous aliases', async () => {
    const alias = bytes(bigCsv.replace('Product Code/SKU', 'Product SKU'));
    const result = buildPriceDiff(parseBigCommerceBaseline(alias), bigSupplier, bigSelection);
    expect(result.canDownload).toBe(true);
    expect(matrix(result.updateCsv!)[0]).toContain('Product SKU');
    expect(await inspectImport('bigcommerce', alias, result.rollbackBytes!, result.updateBytes!))
      .toMatchObject({ verdict: 'PASS', rollback: { residualDiffs: 0 } });
    const [headers, ...rows] = matrix(bigCsv);
    const duplicate = bytes(serializeCsv([...headers, 'Product SKU'], rows.map(row => [...row, row[3]]), 'bigcommerce'));
    expect(parseBigCommerceBaseline(duplicate).issues).toContainEqual(expect.objectContaining({ code: 'duplicate-bigcommerce-sku-column' }));
  });

  it('roundtrips a golden native projection with leading-zero SKU and IDs, simple pricing and SKU stock only', async () => {
    const result = buildPriceDiff(bigBaseline, bigSupplier, bigSelection);
    expect(result.issues).toEqual([]);
    expect(result).toMatchObject({ canDownload: true, rollbackVerification: { checked: true, restoredVariants: 4 } });
    expect(matrix(result.updateCsv!)).toEqual(matrix(fixture('bigcommerce-price-diff/update.csv')));
    expect(matrix(result.rollbackCsv!)).toEqual(matrix(fixture('bigcommerce-price-diff/rollback.csv')));
    const inspection = await inspectImport('bigcommerce', bytes(bigCsv), result.updateBytes!);
    expect(inspection).toMatchObject({ verdict: 'PASS', changedRows: 2, matchedRows: 4, nonTargetMutations: 0, brokenGroups: 0 });
    const pair = await inspectImport('bigcommerce', bytes(bigCsv), result.rollbackBytes!, result.updateBytes!);
    expect(pair).toMatchObject({ verdict: 'PASS', rollback: { residualDiffs: 0, restored: true } });
    expect(inspection.candidateSha256).toBe(createHash('sha256').update(result.updateBytes!).digest('hex'));
    expect(JSON.parse(result.auditJson)).toMatchObject({ platform: 'bigcommerce',
      rows: expect.arrayContaining([expect.objectContaining({ sku: '00201', bigcommerce: { type: 'SKU', id: '00203', productId: '0202', name: '[RB]Color=Red' } })]) });
    const signoff = createSignoffHtml(bigBaseline, result, undefined, undefined, { baselineSha256: inspection.baselineSha256, suppliers: [],
      updateCsvSha256: inspection.candidateSha256, rollbackCsvSha256: pair.candidateSha256 });
    expect(signoff).toContain('BigCommerce Price Update');
    expect(signoff).toContain('Ignore blank values');
    expect(signoff).toContain('Mug &amp; Travel Case');
    expect(signoff).toContain(inspection.candidateSha256);
  });

  it('blocks read-only SKU prices, inherited grouped prices, blank restoration, unsafe inventory modes and unsafe CSV edits', async () => {
    const select = (csv: string, selection: ColumnSelection = { confirmed: true }) => buildPriceDiff(bigBaseline, supplier(csv), selection);
    expect(select('SKU,Price\n00201,26').issues).toContainEqual(expect.objectContaining({ code: 'bigcommerce-read-only-price' }));
    expect(select('SKU,Price\n00200,26').issues).toContainEqual(expect.objectContaining({ code: 'bigcommerce-grouped-price' }));
    expect(select('SKU,Price,Sale Price\n00301,100,80', { confirmed: true, compareAtColumn: 2 }).issues)
      .toContainEqual(expect.objectContaining({ code: 'bigcommerce-unrestorable-value' }));
    expect(select('SKU,Price,Stock\n00301,99.99,4', { confirmed: true, inventoryColumn: 2 }).issues)
      .toContainEqual(expect.objectContaining({ code: 'bigcommerce-stock-tracking' }));
    expect(select('SKU,Price\n00123,14').issues).toContainEqual(expect.objectContaining({ code: 'bigcommerce-sale-not-below-price' }));
    expect(select('SKU,Price\n00123,21\n00123,22').issues).toContainEqual(expect.objectContaining({ code: 'duplicate-sku' }));
    expect(select('SKU,Price\n1.23E+9,21').issues).toContainEqual(expect.objectContaining({ code: 'scientific-sku' }));
    const result = buildPriceDiff(bigBaseline, bigSupplier, bigSelection);
    function change(csv: string, mutate: (headers: string[], rows: string[][]) => void) {
      const [headers, ...rows] = matrix(csv);
      mutate(headers, rows);
      return bytes(serializeCsv(headers, rows, 'bigcommerce'));
    }
    const mutations: [string, (headers: string[], rows: string[][]) => void][] = [
      ['bigcommerce-read-only-price', (headers, rows) => { rows[2][headers.indexOf('Price')] = '30.00'; }],
      ['bigcommerce-read-only-price', (headers, rows) => { rows[2][headers.indexOf('Sale Price')] = '20.00'; }],
      ['identity-mismatch', (headers, rows) => { rows[2][headers.indexOf('Product Name')] = '[RB]Color=Green'; }],
      ['leading-zero-loss', (headers, rows) => { rows[2][headers.indexOf('Product Code/SKU')] = '201'; }],
      ['broken-bigcommerce-group', (_headers, rows) => { rows.pop(); }],
      ['reordered-bigcommerce-rows', (_headers, rows) => { [rows[2], rows[3]] = [rows[3], rows[2]]; }],
    ];
    for (const [code, mutation] of mutations) {
      const check = await inspectImport('bigcommerce', bytes(bigCsv), change(result.updateCsv!, mutation));
      expect(check.verdict).toBe('FAIL_UNSAFE');
      expect(check.issues).toContainEqual(expect.objectContaining({ code }));
    }
    const missingStock = change(result.rollbackCsv!, (headers, rows) => { rows[2][headers.indexOf('Current Stock Level')] = ''; });
    expect(await inspectImport('bigcommerce', bytes(bigCsv), missingStock, result.updateBytes!))
      .toMatchObject({ verdict: 'FAIL_UNSAFE', rollback: { residualDiffs: 1, restored: false } });
  });
});
