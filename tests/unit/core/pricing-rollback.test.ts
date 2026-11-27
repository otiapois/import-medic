import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as csv from '../../../src/core/csv';
import { decodeCsv, parseCsv, serializeCsv } from '../../../src/core/csv';
import { buildPriceDiff, parseBaseline, parseSupplier, previewPricingFormula } from '../../../src/core/shopify-price-diff';
import type { ColumnSelection, PricingRule } from '../../../src/core/shopify-price-diff';
import { preparePricing, validatePricingRule } from '../../../src/core/shopify-price-diff/pricing-rules';
import { readAmount } from '../../../src/core/shopify-price-diff/prices';
import { applySupplierRecipe, createSupplierRecipe, parseSupplierRecipe, serializeSupplierRecipe } from '../../../src/core/shopify-price-diff/recipe';

const bytes = (text: string) => new TextEncoder().encode(text);
const headers = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Variant Compare At Price', 'Tags', 'Image Src'];
const original = [
  ['boots', '  Côte, "Nuit"  ', 'Color', 'Red', '00123', '020.000', '', 'keep', ''],
  ['boots', '', '', 'Blue', '00124', '30.000', '045.000', 'sibling', ''],
  ['boots', '', '', '', '', '', '', '', 'https://example.invalid/boot.png'],
  ['hat', 'Hat', 'Title', 'Default Title', '00125', '9.990', '', 'untouched', ''],
];
const shop = () => parseBaseline(bytes(serializeCsv(headers, original, 'shopify-products')));
const supplier = (lines: string, columns = 'SKU,Cost,Compare-at price') => parseSupplier(bytes(columns + '\n' + lines), 'supplier.csv').sheets[0];
const csvCells = (data: Uint8Array) => parseCsv(decodeCsv(data).text).records.map(({ cells }) => cells);
const settings: ColumnSelection = {
  confirmed: true, compareAtColumn: 2, pricingRule: { mode: 'multiplier', multiplier: '2.2', rounding: 'ending-99' },
};

describe('exact decimal pricing', () => {
  const cases: [string, string, PricingRule, string | null][] = [
    ['direct preserves additional decimal places', '19.00500', { mode: 'direct' }, '19.00500'],
    ['explicit direct cents rounds a half-cent up', '19.005', { mode: 'direct', rounding: 'none' }, '19.01'],
    ['cents stay below the half-cent', '19.004999999999999999999', { mode: 'multiplier', multiplier: '1' }, '19.00'],
    ['multiply without binary float drift', '9.995', { mode: 'multiplier', multiplier: '2' }, '19.99'],
    ['apply fixed fee before rounding', '10.00', { mode: 'multiplier', multiplier: '2.2', fixedFee: '3.005' }, '25.01'],
    ['round only after adding fee', '0.003', { mode: 'multiplier', multiplier: '1', fixedFee: '0.002' }, '0.01'],
    ['increase percent before rounding', '19.99', { mode: 'percent-markup', markupPercent: '35' }, '26.99'],
    ['decrease percent before rounding', '19.99', { mode: 'percent-markup', markupPercent: '-10' }, '17.99'],
    ['target margin uses division', '11.00', { mode: 'target-margin', marginPercent: '45' }, '20.00'],
    ['zero margin preserves cost to cents', '9.995', { mode: 'target-margin', marginPercent: '0' }, '10.00'],
    ['near-100 percent margin stays exact', '1', { mode: 'target-margin', marginPercent: '99.999999999999999999' }, '100000000000000000000.00'],
    ['overflowing margin amount fails closed', '9'.repeat(64), { mode: 'target-margin', marginPercent: '99' }, null],
    ['99 ending at half a unit', '0.50', { mode: 'direct', rounding: 'ending-99' }, '0.99'],
    ['99 ending preserves a matching ending', '9.99', { mode: 'direct', rounding: 'ending-99' }, '9.99'],
    ['99 ending rounds up past an exact ending', '9.99001', { mode: 'direct', rounding: 'ending-99' }, '10.99'],
    ['99 ending never decreases from a whole value', '100.00', { mode: 'direct', rounding: 'ending-99' }, '100.99'],
    ['95 ending at half a unit', '0.50', { mode: 'direct', rounding: 'ending-95' }, '0.95'],
    ['95 ending below the next whole value still rounds up', '9.99', { mode: 'direct', rounding: 'ending-95' }, '10.95'],
    ['95 ending preserves a matching ending', '10.95', { mode: 'direct', rounding: 'ending-95' }, '10.95'],
    ['95 ending never decreases from a whole value', '100.00', { mode: 'direct', rounding: 'ending-95' }, '100.95'],
    ['99 ending keeps the floor inclusive', '4', { mode: 'direct', rounding: 'ending-99', minimumRetail: '9.99' }, '9.99'],
    ['95 ending clears the floor', '4', { mode: 'direct', rounding: 'ending-95', minimumRetail: '9.99' }, '10.95'],
    ['whole rounding goes down below a half', '9.49999', { mode: 'direct', rounding: 'nearest-whole' }, '9.00'],
    ['whole rounding goes up at a half', '9.50', { mode: 'direct', rounding: 'nearest-whole' }, '10.00'],
    ['whole rounding respects an exact non-integer floor', '9.20', { mode: 'direct', rounding: 'nearest-whole', minimumRetail: '9.01' }, '10.00'],
    ['whole rounding applies a floor to a positive near-zero subtotal', '0.20', { mode: 'multiplier', multiplier: '1', rounding: 'nearest-whole', minimumRetail: '9.99' }, '10.00'],
    ['cents apply a floor to a positive near-zero subtotal', '0.004', { mode: 'multiplier', multiplier: '1', minimumRetail: '0.01' }, '0.01'],
    ['cents honor a sub-cent floor', '3.99', { mode: 'direct', minimumRetail: '4.001' }, '4.01'],
    ['a positive amount rounding to zero fails without a floor', '0.004', { mode: 'direct', rounding: 'none' }, null],
    ['zero cost cannot be rescued by a fee or floor', '0.00', { mode: 'multiplier', multiplier: '2', fixedFee: '3', minimumRetail: '9.99' }, null],
    ['negative cost cannot be rescued by a floor', '-1', { mode: 'direct', minimumRetail: '9.99' }, null],
    ['zero computed subtotal cannot be rescued by a floor', '9.99', { mode: 'percent-markup', markupPercent: '-100', minimumRetail: '9.99' }, null],
    ['negative computed subtotal cannot be rescued by a floor', '9.99', { mode: 'percent-markup', markupPercent: '-101', minimumRetail: '9.99' }, null],
    ['rounding overflow fails closed', '9'.repeat(64) + '.995', { mode: 'direct', rounding: 'none' }, null],
  ];
  it.each(cases)('%s', (_, input, rule, expected) => {
    expect(validatePricingRule(rule)).toBeNull();
    expect(preparePricing(rule)(readAmount(input)!)?.text ?? null).toBe(expected);
  });

  it.each([
    { mode: 'target-margin', marginPercent: '100' },
    { mode: 'target-margin', marginPercent: '-0.001' },
    { mode: 'target-margin', marginPercent: '99,99' },
    { mode: 'multiplier', multiplier: '0' },
    { mode: 'multiplier', multiplier: '1e3' },
    { mode: 'multiplier', multiplier: '2', fixedFee: '-1' },
    { mode: 'percent-markup', markupPercent: ' 35' },
    { mode: 'direct', minimumRetail: '0' },
    { mode: 'direct', rounding: 'up' },
    { mode: 'direct', markupPercent: '25' },
  ])('rejects invalid parameters %j', (rule) => {
    expect(validatePricingRule(rule as PricingRule)).toBeTruthy();
    expect(buildPriceDiff(shop(), supplier('00123,10,39'), { ...settings, pricingRule: rule as PricingRule })).toMatchObject({
      status: 'review', canDownload: false, rollbackCsv: null, updateCsv: null,
      issues: [expect.objectContaining({ code: 'invalid-pricing-rule', blocking: true })],
    });
  });
});

describe('verified M4 pricing exports', () => {
  it('produces both verified files from exact raw and transformed amounts and restores every source cell', () => {
    const baseline = shop();
    const result = buildPriceDiff(baseline, supplier('00123,10.00,39.99'), settings);
    expect(result.rows[0]).toMatchObject({ supplierPrice: '10.00', computedPrice: '22.99', newPrice: '22.99' });
    expect(result).toMatchObject({
      canDownload: true, verification: { checked: true, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 },
      rollbackVerification: { checked: true, restoredVariants: 2 },
    });
    const [updateHeaders, ...updates] = csvCells(result.updateBytes!);
    const [rollbackHeaders, ...rollbacks] = csvCells(result.rollbackBytes!);
    expect(rollbackHeaders).toEqual(updateHeaders);
    expect(updateHeaders).not.toContain('Tags');
    expect(updateHeaders).not.toContain('Image Src');
    expect(updates.map((row) => row.slice(-3))).toEqual([['00123', '22.99', '39.99'], ['00124', '30.000', '045.000']]);
    expect(rollbacks.map((row) => [row[1], ...row.slice(-3)])).toEqual([
      ['  Côte, "Nuit"  ', '00123', '020.000', ''], ['', '00124', '30.000', '045.000'],
    ]);
    const matrix = original.map((row) => [...row]);
    for (const chunk of [updates, rollbacks]) {
      for (const record of chunk) {
        const variant = matrix.find((row) => row[0] === record[0] && row[3] === record[3])!;
        updateHeaders.forEach((header, outputIndex) => {
          const sourceIndex = headers.indexOf(header);
          if (sourceIndex >= 0) variant[sourceIndex] = record[outputIndex];
        });
      }
    }
    expect(matrix).toEqual(original);
    expect(baseline.rows.map(({ cells }) => cells.map(({ value }) => value))).toEqual(original);
  });

  it('uses the exact final retail override for guards and audit while preserving the theoretical price', () => {
    const result = buildPriceDiff(shop(), supplier('00123,10.00,39.99'), { ...settings, increaseThresholdPercent: 20 }, { 2: { price: '32.000' } });
    expect(result).toMatchObject({ status: 'review', updateCsv: null, rollbackCsv: null });
    expect(result.rows[0]).toMatchObject({ supplierPrice: '10.00', computedPrice: '22.99', newPrice: '32.000', deltaPercent: '60' });
    expect(result.rows[0].issues).toContainEqual(expect.objectContaining({ code: 'price-increase', value: '32.000', blocking: true }));
    const approved = buildPriceDiff(shop(), supplier('00123,10.00,39.99'), { ...settings, increaseThresholdPercent: 20 }, { 2: { price: '32.000', confirm: true } });
    expect(approved.canDownload).toBe(true);
    expect(csvCells(approved.updateBytes!)[1].slice(-2)).toEqual(['32.000', '39.99']);
    const [header, , row] = csvCells(bytes(approved.auditCsv));
    expect(header.map((name, index) => [name, row[index]])).toEqual(expect.arrayContaining([
      ['Raw Supplier Price', '10.00'], ['Computed Price', '22.99'], ['New Price', '32.000'],
    ]));
    expect(JSON.parse(approved.auditJson).rows[0]).toMatchObject({
      supplierPrice: '10.00', computedPrice: '22.99', newPrice: '32.000', resolution: { price: '32.000', confirm: true },
    });
  });

  it('guards a transformed increase even when the raw amount equals the baseline', () => {
    const result = buildPriceDiff(shop(), supplier('00123,20.000,'), settings);
    const guarded = buildPriceDiff(shop(), supplier('00123,20.000,'), { ...settings, increaseThresholdPercent: 100 });
    expect(result.canDownload).toBe(true);
    expect(guarded.rows[0]).toMatchObject({ computedPrice: '44.99', deltaPercent: '124.95' });
    expect(guarded.issues).toContainEqual(expect.objectContaining({ code: 'price-increase' }));
    expect(guarded.updateCsv).toBeNull();
    expect(guarded.rollbackCsv).toBeNull();
  });

  it('demands fresh pricing confirmation even for an unambiguous retail header', () => {
    const result = buildPriceDiff(shop(), supplier('00123,10', 'SKU,Price'), { pricingRule: settings.pricingRule });
    expect(result).toMatchObject({ status: 'review', updateBytes: null, rollbackBytes: null });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'mapping-confirmation-required' }));
  });

  it.each(['Wholesale Cost', 'Wholesale Price'])('suggests %s and requires review before exporting', (column) => {
    const input = supplier('00123,10.00', 'SKU,' + column);
    const proposed = buildPriceDiff(shop(), input);
    expect(proposed.suggestions).toMatchObject({ priceColumns: [1], selection: { priceColumn: 1 }, requiresConfirmation: true });
    expect(proposed.canDownload).toBe(false);
    const approved = buildPriceDiff(shop(), input, { confirmed: true, pricingRule: settings.pricingRule });
    expect(approved.rows[0]).toMatchObject({ supplierPrice: '10.00', computedPrice: '22.99' });
    expect(approved.canDownload).toBe(true);
  });

  it('uses the first eligible matched supplier row for the live preview', () => {
    const input = supplier('99999,5,\n00124,zero,\n00123,10.00,');
    expect(previewPricingFormula(shop(), input, { ...settings, confirmed: false })).toEqual({ supplierRow: 4, supplierPrice: '10.00', computedPrice: '22.99' });
    expect(previewPricingFormula(shop(), supplier('99999,5,'), settings)).toBeNull();
    expect(previewPricingFormula(shop(), input, { ...settings, pricingRule: { mode: 'target-margin', marginPercent: '100' } })).toBeNull();
  });

  it('rejects exact output overflows even when the user previously confirmed the movement', () => {
    const result = buildPriceDiff(shop(), supplier('00123,' + '9'.repeat(64) + ','), { ...settings, pricingRule: { mode: 'multiplier', multiplier: '2' } }, { 2: { confirm: true } });
    expect(result).toMatchObject({ status: 'review', updateCsv: null, rollbackCsv: null });
    expect(result.rows[0].issues).toContainEqual(expect.objectContaining({ code: 'invalid-computed-price' }));
  });

  it('omits unmapped compare-at prices in both files and permits a compare-only mapped change', () => {
    const baseline = shop();
    const unmapped = buildPriceDiff(baseline, supplier('00123,10.00,39.99'), { ...settings, compareAtColumn: null });
    expect(csvCells(unmapped.updateBytes!)[0]).not.toContain('Variant Compare At Price');
    expect(csvCells(unmapped.rollbackBytes!)[0]).not.toContain('Variant Compare At Price');
    const compareOnly = buildPriceDiff(baseline, supplier('00123,20,23.00'), { ...settings, pricingRule: undefined });
    expect(csvCells(compareOnly.updateBytes!)[1].slice(-2)).toEqual(['020.000', '23.00']);
    expect(csvCells(compareOnly.rollbackBytes!)[1].slice(-2)).toEqual(['020.000', '']);
  });

  it('keeps both downloads absent for no-op, invalid price, or formula guard cases', () => {
    const noChange = buildPriceDiff(shop(), supplier('00123,20.000,'), { ...settings, pricingRule: undefined });
    expect(noChange).toMatchObject({ status: 'no-changes', canDownload: false, updateCsv: null, rollbackCsv: null });
    const invalid = buildPriceDiff(shop(), supplier('00123,0.00,'), { ...settings, pricingRule: { mode: 'direct', minimumRetail: '9.99' } });
    expect(invalid).toMatchObject({ status: 'review', canDownload: false, updateBytes: null, rollbackBytes: null });
    const guardedBaseline = parseBaseline(bytes(serializeCsv(headers, [['boots', '=2+2', 'Color', 'Red', '00123', '20', '', 'keep', '']], 'shopify-products')));
    const guarded = buildPriceDiff(guardedBaseline, supplier('00123,10.00,30'), { ...settings, formulaGuard: true });
    expect(guarded).toMatchObject({ status: 'review', canDownload: false, updateCsv: null, rollbackCsv: null });
    expect(guarded.formulaGuard.blocked).toEqual([{ row: 2, column: 'Title', before: '=2+2', after: "'=2+2" }]);
  });

  it('withholds an otherwise valid update when actual rollback bytes change an original blank cell', () => {
    const baseline = shop();
    const input = supplier('00123,10.00,39.99');
    const serialize = serializeCsv;
    const writer = vi.spyOn(csv, 'serializeCsv').mockImplementationOnce(serialize).mockImplementationOnce((head, rows, format) => {
      const altered = rows.map((row) => [...row]);
      altered[0][head.indexOf('Variant Compare At Price')] = '29.99';
      return serialize(head, altered, format);
    });
    try {
      expect(buildPriceDiff(baseline, input, settings)).toMatchObject({
        status: 'review', canDownload: false, updateBytes: null, rollbackBytes: null,
        verification: { checked: true, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 },
        rollbackVerification: { checked: true, restoredVariants: 0 },
        issues: [expect.objectContaining({ code: 'verification-mismatch', blocking: true })],
      });
    } finally {
      writer.mockRestore();
    }
  });
});

describe('version 2 pricing recipes', () => {
  const options: ColumnSelection = { ...settings, joinKey: 'sku', skuColumn: 0, priceColumn: 1, sameCurrencyConfirmed: true };
  const columns = ['SKU', 'Cost', 'Compare-at price'];

  it('saves and reapplies a strict v2 rule while requiring fresh confirmation', () => {
    const created = createSupplierRecipe('Wholesale', columns, options, null, 'Store A');
    expect(created).toMatchObject({ ok: true, value: { version: 2, pricingRule: settings.pricingRule, storeLabel: 'Store A' } });
    if (!created.ok) throw new Error('Expected a new recipe');
    expect(created.value).not.toHaveProperty('sameCurrencyConfirmed');
    expect(parseSupplierRecipe(bytes(serializeSupplierRecipe(created.value)))).toEqual(created);
    const batch = parseSupplier(bytes('Compare-at price,Cost,SKU\n39,10,00123'), 'batch.csv');
    expect(applySupplierRecipe(created.value, batch, 0)).toMatchObject({
      ok: true, value: { selection: { skuColumn: 2, priceColumn: 1, compareAtColumn: 0, pricingRule: settings.pricingRule, confirmed: false, sameCurrencyConfirmed: false } },
    });
  });

  it('keeps v1 as the direct default and creates v2 when only a store label is supplied', () => {
    const direct = { ...options, pricingRule: { mode: 'direct' } as const };
    const v1 = createSupplierRecipe('Wholesale', columns, direct, null);
    expect(v1).toMatchObject({ ok: true, value: { version: 1 } });
    if (!v1.ok) throw new Error('Expected legacy recipe');
    expect(v1.value).not.toHaveProperty('pricingRule');
    expect(createSupplierRecipe('Wholesale', columns, direct, null, 'Store A')).toMatchObject({
      ok: true, value: { version: 2, storeLabel: 'Store A', pricingRule: { mode: 'direct' } },
    });
  });

  it('rejects malformed v2 rules, source role collisions, and unsupported fields', () => {
    const valid = createSupplierRecipe('Wholesale', columns, options, null);
    if (!valid.ok) throw new Error('Expected a new recipe');
    expect(parseSupplierRecipe(bytes(JSON.stringify({ ...valid.value, pricingRule: { mode: 'target-margin', marginPercent: '100' } })))).toMatchObject({
      ok: false, diagnostics: [{ code: 'invalid-recipe-schema', field: 'pricingRule.marginPercent' }],
    });
    expect(parseSupplierRecipe(bytes(JSON.stringify({ ...valid.value, pricingRule: { mode: 'direct', unknown: 1 } })))).toMatchObject({ ok: false });
    expect(parseSupplierRecipe(bytes(JSON.stringify({ ...valid.value, sameCurrencyConfirmed: true })))).toMatchObject({ ok: false });
    expect(parseSupplierRecipe(bytes(JSON.stringify({ ...valid.value, compareAtColumn: 'cost' })))).toMatchObject({
      ok: false, diagnostics: [{ code: 'duplicate-recipe-column' }],
    });
  });

  it('replays the agency walkthrough on two batches and restores the blank original compare-at cell', () => {
    const baseline = parseBaseline(readFileSync(new URL('../../../fixtures/shopify-price-diff/baseline-agency.csv', import.meta.url)));
    const batchOne = supplier('00045-XL,10.00,32.00\n00046-L,10.00,29.00', 'SKU,Wholesale Cost,Compare-at price');
    const firstSelection: ColumnSelection = { ...options, compareAtColumn: 2 };
    const recipe = createSupplierRecipe('Wholesale', batchOne.headers, firstSelection, null, 'Store A');
    if (!recipe.ok) throw new Error('Expected the agency recipe');
    const first = buildPriceDiff(baseline, batchOne, firstSelection);
    expect(first.canDownload).toBe(true);
    expect(first.rows.filter(({ status }) => status === 'Updated').map(({ sku, computedPrice }) => [sku, computedPrice])).toEqual([
      ['00045-XL', '22.99'], ['00046-L', '22.99'],
    ]);
    const rollback = csvCells(first.rollbackBytes!);
    expect(rollback.slice(1).map((row) => row.slice(-3))).toEqual([
      ['00123', '100.00', '130.00'], ['00045-XL', '20.00', '28.00'], ['00046-L', '22.00', ''],
    ]);

    const batchTwo = parseSupplier(bytes('Wholesale Cost,Compare-at price,SKU\n11.00,35.00,00045-XL'), 'second.csv');
    const loaded = parseSupplierRecipe(bytes(serializeSupplierRecipe(recipe.value)));
    if (!loaded.ok) throw new Error('Expected the saved agency recipe');
    const applied = applySupplierRecipe(loaded.value, batchTwo, 0);
    if (!applied.ok) throw new Error('Expected the reordered agency columns');
    const second = buildPriceDiff(baseline, batchTwo.sheets[0], { ...applied.value.selection, confirmed: true });
    expect(second.canDownload).toBe(true);
    expect(second.rows.find(({ sku }) => sku === '00045-XL')).toMatchObject({ supplierPrice: '11.00', computedPrice: '24.99', newPrice: '24.99' });
  });
});
