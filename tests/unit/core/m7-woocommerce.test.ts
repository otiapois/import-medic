import { readFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { decodeCsv, parseCsv, serializeCsv } from '../../../src/core/csv';
import { buildMultiSupplierDiff, buildPriceDiff, parseSupplier, suggestColumns } from '../../../src/core/shopify-price-diff';
import type { Baseline, ColumnSelection, PriceDiffResult, RowResolution, SupplierDiffInput } from '../../../src/core/shopify-price-diff/types';
import { createSignoffHtml } from '../../../src/core/shopify-price-diff/signoff-html';
import { parseWooCommerceBaseline } from '../../../src/core/woocommerce-price-diff';

const bytes = (text: string) => new TextEncoder().encode(text);
const fixtures = (name: string) => readFileSync(new URL('../../../fixtures/woocommerce-price-diff/' + name, import.meta.url));
const fromText = (text: string) => parseSupplier(bytes(text), 'supplier.csv').sheets[0];
const load = (name = 'baseline.csv') => parseWooCommerceBaseline(fixtures(name), name);
const supplier = parseSupplier(fixtures('supplier.csv'), 'supplier.csv').sheets[0];
const choose = { confirmed: true, compareAtColumn: 2, inventoryColumn: 3, pricingRule: { mode: 'multiplier', multiplier: '2.5' } } as const;
const baseHeaders = ['ID', 'Type', 'SKU', 'Parent', 'Regular price', 'Sale price', 'Stock', 'Description'];
const baseRows = [
  ['99', 'variable', '00009', '', '', '', '', 'Retain variable'],
  ['765', 'variation', '00023', '00009', '050.000', '40.00', '008', 'Variation, with\r\nlines'],
  ['766', 'variation', '00024', 'id:99', '55.10', '', '012', 'Retain sibling'],
  ['900', 'simple', '00090', '', '10.00', '', '001', 'Retain simple'],
];
const native = (csv: Uint8Array) => parseCsv(decodeCsv(csv).text).records.map(({ cells, parseError }) => {
  expect(parseError).toBeUndefined();
  return cells;
});
const asWoo = (rows: string[][], headers = baseHeaders) => parseWooCommerceBaseline(bytes(serializeCsv(headers, rows, 'woocommerce')));
const field: ColumnSelection = { confirmed: true, dropThresholdPercent: 100, increaseThresholdPercent: 100_000 };
const single = (baseline: Baseline, text: string, selection: ColumnSelection = field, resolutions?: Record<number, RowResolution>) =>
  buildPriceDiff(baseline, fromText(text), selection, resolutions);
const held = (result: PriceDiffResult, code: string) => {
  expect(result).toMatchObject({ status: 'review', canDownload: false, updateBytes: null, rollbackBytes: null });
  expect(result.issues).toContainEqual(expect.objectContaining({ code, blocking: true }));
};

describe('M7 WooCommerce native scope', () => {
  it('replays both real CSV payloads over all source cells, keeping only changed sellable IDs', () => {
    const baseline = load();
    expect(baseline.issues).toEqual([]);
    const matched = { ...choose, pricingRule: { mode: 'tiered-brackets', brackets: [
      { upTo: '20.00', mode: 'multiplier', multiplier: '2.5' },
      { upTo: '100.00', mode: 'multiplier', multiplier: '2.0' },
      { upTo: null, mode: 'multiplier', multiplier: '1.6' },
    ], rounding: 'ending-99' } } satisfies ColumnSelection;
    const result = buildPriceDiff(baseline, supplier, matched);
    expect(result.canDownload).toBe(true);
    const [headers, ...update] = native(result.updateBytes!);
    const [rollbackHeaders, ...rollback] = native(result.rollbackBytes!);
    expect(headers).toEqual(['ID', 'Type', 'SKU', 'Parent', 'Regular price', 'Sale price', 'Stock']);
    expect(rollbackHeaders).toEqual(headers);
    expect(update).toEqual([
      ['4101', 'variation', '00123', '00040', '50.99', '39.00', '9'],
      ['4102', 'variation', '00124', 'id:4100', '40.99', '', '11'],
      ['4103', 'simple', '00125', '', '160.99', '140.00', '7'],
    ]);
    expect(rollback).toEqual([
      ['4101', 'variation', '00123', '00040', '50.50', '40.00', '008'],
      ['4102', 'variation', '00124', 'id:4100', '39.99', '', '010'],
      ['4103', 'simple', '00125', '', '155.00', '', '006'],
    ]);
    const original = native(fixtures('baseline.csv')).slice(1);
    const copy = original.map(row => [...row]);
    for (const projection of [update, rollback]) {
      for (const record of projection) {
        const row = copy.find(row => row[0] === record[0])!;
        headers.forEach((header, column) => { row[baseline.headers.indexOf(header)] = record[column]; });
      }
      expect(copy[0]).toEqual(original[0]);
      expect(copy.map(row => row.slice(8))).toEqual(original.map(row => row.slice(8)));
    }
    expect(copy).toEqual(original);
    expect(result.verification).toEqual({ checked: true, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 });
    expect(result.rollbackVerification).toEqual({ checked: true, restoredVariants: 3 });
    const [auditHeader, ...auditRows] = native(bytes(result.auditCsv));
    expect(auditHeader.slice(0, 5)).toEqual(['Status', 'SKU', 'ID', 'Type', 'Parent']);
    expect(auditHeader.slice(-2)).toEqual(['Matched Tier', 'Review and Resolution (JSON)']);
    expect(auditRows.every(row => row.length === auditHeader.length)).toBe(true);
    expect(JSON.parse(result.auditJson).rows[1]).toMatchObject({ sku: '00123', matchedTier: 'Tier 1 (<= 20.00): 2.5x', woocommerce: { id: '4101', type: 'variation', parent: '00040' } });
    expect(createSignoffHtml(baseline, result)).toContain('WooCommerce Price Update');
    expect(createSignoffHtml(baseline, result)).toContain('variation / id:4100');
  });

  it('omits unmapped stock and sale and leaves parent and untouched siblings out of a price-only pair', () => {
    const baseline = asWoo(baseRows);
    const result = single(baseline, 'SKU,Price\n00023,51.75\n23,99.00\n00024,59.00', field, { 4: { skip: true } });
    expect(result.canDownload).toBe(true);
    expect(native(result.updateBytes!)).toEqual([baseHeaders.slice(0, 5), ['765', 'variation', '00023', '00009', '51.75']]);
    expect(native(result.rollbackBytes!)).toEqual([baseHeaders.slice(0, 5), baseRows[1].slice(0, 5)]);
    expect(result.rows).toContainEqual(expect.objectContaining({ sku: '23', status: 'Unmatched Supplier Row' }));
    expect(result.rows).toContainEqual(expect.objectContaining({ sku: '00024', status: 'Skipped' }));
  });

  it.each(['-003', "'-003"])('updates and restores managed backordered stock %s and the exact Type flags', (stock) => {
    const baseline = parseWooCommerceBaseline(bytes(decodeCsv(fixtures('backordered-stock.csv')).text.replace('-003', stock)));
    const result = single(baseline, 'SKU,Price,Stock\n00123,50.50,7', { ...field, inventoryColumn: 2 });
    expect(result.canDownload).toBe(true);
    expect(native(result.updateBytes!)[1]).toEqual(['4101', 'variation, virtual', '00123', '00040', '50.50', '7']);
    expect(native(result.rollbackBytes!)[1]).toEqual(['4101', 'variation, virtual', '00123', '00040', '50.50', stock]);
  });

  it('holds an automatic native sale clearance on reduction without mapping Sale price', () => {
    const result = buildPriceDiff(load(), parseSupplier(fixtures('invalid-retained-sale.csv'), 'invalid-retained-sale.csv').sheets[0], field);
    held(result, 'woo-sale-not-below-regular');
    expect(result.rows[1]).toMatchObject({ status: 'Blocked', oldCompareAtPrice: '40.00', newCompareAtPrice: '40.00', newPrice: '39.00' });
  });

  it('holds an inherited stock row when Stock is included and permits an otherwise valid scoped price-only pair', () => {
    const baseline = load('invalid-inherited-stock.csv');
    const input = 'SKU,Price,Stock\n00123,51.00,9';
    held(single(baseline, input, { ...field, inventoryColumn: 2 }), 'woo-stock-not-managed');
    const result = single(baseline, input);
    expect(result.canDownload).toBe(true);
    expect(native(result.updateBytes!)[0]).not.toContain('Stock');
  });

  it.each([
    ['case-insensitive duplicate baseline SKU', 2, 2, '00023', 'duplicate-sku'],
    ['duplicate baseline ID', 2, 0, '765', 'duplicate-woo-id'],
    ['scientific baseline SKU', 2, 2, '12E2', 'scientific-sku'],
    ['malformed baseline SKU', 2, 2, ' 00024', 'invalid-sku'],
    ['normalized-away SKU octet', 2, 2, 'SKU%2f5', 'invalid-sku'],
    ['non-canonical baseline ID', 2, 0, '0766', 'invalid-woo-id'],
    ['invalid baseline type', 2, 1, 'variation,simple', 'invalid-woo-type'],
    ['duplicate type flags', 2, 1, 'variation, virtual,virtual', 'invalid-woo-type'],
    ['missing parent', 2, 3, '', 'invalid-woo-parent'],
    ['missing parent ID', 2, 3, 'id:9999', 'invalid-woo-parent'],
    ['variation parent is simple', 2, 3, '00090', 'invalid-woo-parent'],
    ['variation parent is child', 2, 3, '00023', 'invalid-woo-parent'],
    ['variation parent loses SKU zeros', 2, 3, '9', 'invalid-woo-parent'],
    ['parent on simple', 3, 3, 'id:99', 'unexpected-woo-parent'],
    ['malformed original regular price', 2, 4, '50e2', 'invalid-baseline-price'],
    ['malformed original sale price', 2, 5, '-1.25', 'invalid-baseline-sale-price'],
  ] as const)('holds %s', (_label, row, column, mutation, code) => {
    const mutated = baseRows.map(record => [...record]);
    mutated[row][column] = mutation;
    held(single(asWoo(mutated), 'SKU,Price\n00023,52'), code);
  });

  it.each([
    ['malformed supplier row', 'SKU,Price\n00023,51,unmapped', 'row-width'],
    ['duplicate supplier SKU', 'SKU,Price\n00023,51\n00023,52', 'duplicate-sku'],
    ['case-insensitive duplicate supplier SKU', 'SKU,Price\n00023,51\nABC,51\nabc,52', 'duplicate-sku'],
    ['scientific text SKU', 'SKU,Price\n001E23,51', 'scientific-sku'],
    ['empty supplier SKU', 'SKU,Price\n,52', 'missing-supplier-key'],
    ['invalid supplier amount', 'SKU,Price\n00023,5e1', 'invalid-price'],
    ['ambiguous supplier column', 'SKU,Price,price\n00023,51,52', 'duplicate-header'],
  ] as const)('holds %s', (_label, csv, code) => held(single(asWoo(baseRows), csv), code));

  it('holds a mapped sale equal to regular and a retained sale equal to the original regular', () => {
    const input = 'SKU,Price,Sale price\n00023,51,51';
    held(single(asWoo(baseRows), input, { ...field, compareAtColumn: 2 }), 'woo-sale-not-below-regular');
    const bad = baseRows.map(row => [...row]);
    bad[1][5] = '50';
    held(single(asWoo(bad), 'SKU,Price\n00023,52'), 'invalid-baseline-sale-price');
  });

  it('requires the Sale price baseline column when lowering the regular price', () => {
    const baseline = asWoo(baseRows.map(row => row.filter((_, index) => index !== 5)), baseHeaders.filter(column => column !== 'Sale price'));
    held(single(baseline, 'SKU,Price\n00023,45'), 'woo-sale-price-required');
    expect(single(baseline, 'SKU,Price\n00023,52').canDownload).toBe(true);
  });

  it('holds the pair if any emitted row would switch its stock-management mode', () => {
    const mixed = baseRows.map(row => [...row]);
    mixed[2][6] = '';
    const input = (supplierId: string, text: string, selection: ColumnSelection) => ({ supplierId, filename: supplierId, sheet: fromText(text), selection });
    const sources = [
      input('one', 'SKU,Price,Stock\n00023,52,9', { ...field, inventoryColumn: 2 }),
      input('two', 'SKU,Price\n00024,58', field),
    ];
    held(buildMultiSupplierDiff(asWoo(mixed), sources), 'woo-stock-not-managed');
  });

  it('keeps SKU mapping exclusive and prevents automatic Shopify compare-at rules', () => {
    const baseline = asWoo(baseRows);
    expect(suggestColumns(baseline, fromText('SKU,Regular price,Sale price,Handle,Option1 Value')).selection).toMatchObject({
      joinKey: 'sku', skuColumn: 0, priceColumn: 1, compareAtColumn: null,
    });
    held(single(baseline, 'SKU,Price\n00023,51', { ...field, joinKey: 'handle-options' }), 'unsupported-woo-mapping');
    held(single(baseline, 'SKU,Price\n00023,51', { ...field, pricingRule: { mode: 'direct', compareAtRule: { multiplier: '2' } } }), 'unsupported-woo-mapping');
  });

  it('blocks mapped variable-parent writes, even for a valid parent SKU', () => {
    held(single(asWoo(baseRows), 'SKU,Price\n00009,53'), 'unsupported-woo-update-type');
  });

  it('accepts a mixed XLSX and CSV batch and rejects Excel numeric cells as exact SKUs', () => {
    const template = readFileSync(new URL('../../../fixtures/shopify-price-diff/supplier-agency.xlsx', import.meta.url));
    const entries = unzipSync(template);
    const part = 'xl/worksheets/sheet2.xml';
    const original = strFromU8(entries[part]);
    const xlsx = (cell: string) => parseSupplier(zipSync({ ...entries,
      [part]: strToU8(original.replace(/<c r="A2"[^>]*>.*?<\/c>/, cell).replace('<v>18.00</v>', '<v>53.25</v>')),
    }), 'supplier.xlsx').sheets[1];
    const supplierCsv = fromText('SKU,Price\n00024,57');
    const sources = (cell: string): SupplierDiffInput[] => [
      { supplierId: 'csv', filename: 'supplier.csv', sheet: supplierCsv, selection: field },
      { supplierId: 'xlsx', filename: 'supplier.xlsx', sheet: xlsx(cell), selection: { ...field, skuColumn: 0, priceColumn: 1 } },
    ];
    const result = buildMultiSupplierDiff(asWoo(baseRows), sources('<c r="A2" t="inlineStr"><is><t>00023</t></is></c>'));
    expect(result.canDownload).toBe(true);
    expect(native(result.updateBytes!).slice(1)).toEqual([
      ['765', 'variation', '00023', '00009', '53.25'], ['766', 'variation', '00024', 'id:99', '57'],
    ]);
    held(buildMultiSupplierDiff(asWoo(baseRows), sources('<c r="A2"><v>00023</v></c>')), 'non-text-sku');
  });

  it('requires a decision for equally priced offers whose mapped stock disagrees', () => {
    const input = (id: string, stock: number): SupplierDiffInput => ({
      supplierId: id, filename: id, sheet: fromText('SKU,Price,Stock\n00023,52,' + stock), selection: { ...field, inventoryColumn: 2 },
    });
    const sources = [input('a', 10), input('b', 11), input('c', 10)];
    const baseline = asWoo(baseRows);
    held(buildMultiSupplierDiff(baseline, sources, { conflictPolicy: 'prefer-lowest', conflictPolicyConfirmed: true }), 'supplier-conflict');
    held(buildMultiSupplierDiff(baseline, sources, { conflictPolicy: 'prefer-first' }), 'supplier-conflict-confirmation-required');
    const ready = buildMultiSupplierDiff(baseline, sources, { conflictPolicy: 'prefer-last', conflictPolicyConfirmed: true });
    expect(ready).toMatchObject({ canDownload: true, overlapCount: 1, conflictCount: 1 });
    expect(ready.rows[1]).toMatchObject({ supplierId: 'c', newInventoryQty: '10', supplierContenders: expect.arrayContaining([expect.objectContaining({ supplierId: 'b', inventoryQty: '11' })]) });
  });

  it('holds a losing supplier offer whose Woo sale would clear on import', () => {
    const input = (id: string, price: string, sale: string): SupplierDiffInput => ({
      supplierId: id, filename: id, sheet: fromText('SKU,Price,Sale price\n00023,' + price + ',' + sale),
      selection: { ...field, compareAtColumn: 2 },
    });
    const result = buildMultiSupplierDiff(asWoo(baseRows), [input('a', '53', '45'), input('b', '60', '61')], {
      conflictPolicy: 'prefer-first', conflictPolicyConfirmed: true,
    });
    held(result, 'woo-sale-not-below-regular');
  });
});
