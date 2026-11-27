import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSupplier } from '../../../src/core/shopify-price-diff';
import { applySupplierRecipe, createSupplierRecipe, parseSupplierRecipe, serializeSupplierRecipe } from '../../../src/core/shopify-price-diff/recipe';
import type { SupplierRecipe } from '../../../src/core/shopify-price-diff/recipe';

const bytes = (text: string) => new TextEncoder().encode(text);
const csv = (headers: string) => parseSupplier(bytes(headers), 'batch-2.csv');
const workbook = parseSupplier(readFileSync(new URL('../../../fixtures/shopify-price-diff/supplier-agency.xlsx', import.meta.url)), 'agency.xlsx');
const skuRecipe: SupplierRecipe = {
  version: 1, supplierLabel: 'Test agency', joinKey: { type: 'sku', skuColumn: 'SKU' }, priceColumn: 'New Price',
  compareAtColumn: 'Compare-at price', sheetName: null, dropThresholdPercent: 23.123, increaseThresholdPercent: 175, formulaGuard: true,
};

describe('portable supplier recipes', () => {
  it('replays exact column names after a new batch reorders them and requires fresh confirmation', () => {
    const created = createSupplierRecipe('Test agency', ['SKU', 'New Price', 'Compare-at price'], {
      joinKey: 'sku', skuColumn: 0, priceColumn: 1, compareAtColumn: 2, confirmed: true, sameCurrencyConfirmed: true,
      dropThresholdPercent: 23.123, increaseThresholdPercent: 175, formulaGuard: true,
    }, null);
    expect(created).toEqual({ ok: true, value: skuRecipe });
    const parsed = parseSupplierRecipe(bytes(serializeSupplierRecipe(skuRecipe)));
    expect(parsed).toEqual(created);
    expect(applySupplierRecipe(skuRecipe, csv('Compare-at price,Notes,New Price,SKU\n17,,14,0007'), 0)).toEqual({ ok: true, value: {
      sheetIndex: 0, selection: {
        joinKey: 'sku', skuColumn: 3, priceColumn: 2, compareAtColumn: 0, confirmed: false, sameCurrencyConfirmed: false,
        dropThresholdPercent: 23.123, increaseThresholdPercent: 175, formulaGuard: true,
      },
    } });
  });

  it('selects an exact XLSX sheet, and reports missing, renamed, and ambiguous source names', () => {
    const secondary = { ...skuRecipe, sheetName: 'Secondary', compareAtColumn: null };
    const result = applySupplierRecipe(secondary, workbook, 0);
    expect(result).toMatchObject({ ok: true, value: { sheetIndex: 1 } });
    expect(applySupplierRecipe(secondary, csv('SKU,New Price'), 0)).toMatchObject({ ok: false, diagnostics: [{ code: 'recipe-missing-sheet', expected: 'Secondary' }] });
    expect(applySupplierRecipe(skuRecipe, csv('SKU,New Price,new price,Compare-at price'), 0)).toMatchObject({ ok: false, diagnostics: [{ code: 'recipe-ambiguous-column', expected: 'New Price' }] });
    expect(applySupplierRecipe(skuRecipe, csv('SKU,NEW PRICE,Compare-at price'), 0)).toMatchObject({ ok: false, diagnostics: [{ code: 'recipe-missing-column', expected: 'New Price' }] });
    expect(applySupplierRecipe(skuRecipe, csv('SKU,New Price,Compare-at price,notes,Notes'), 0)).toMatchObject({ ok: false, diagnostics: [{ code: 'unsafe-supplier-sheet' }] });
  });

  it('roundtrips all confirmed option dimensions and rejects holes or duplicated source roles', () => {
    const headers = ['Handle', 'Next Price', 'Color', 'Size', 'Finish'];
    const selection = { joinKey: 'handle-options', handleColumn: 0, priceColumn: 1, optionColumns: [2, 3, 4], confirmed: true } as const;
    const created = createSupplierRecipe('Agency', headers, selection, null);
    expect(created).toMatchObject({ ok: true, value: { joinKey: { type: 'handle-options', handleColumn: 'Handle', optionColumns: ['Color', 'Size', 'Finish'] } } });
    if (!created.ok) throw new Error('Expected a portable option recipe');
    expect(applySupplierRecipe(created.value, csv('Finish,Size,Next Price,Handle,Color'), 0)).toMatchObject({ ok: true, value: { selection: { handleColumn: 3, priceColumn: 2, optionColumns: [4, 1, 0] } } });
    expect(createSupplierRecipe('Agency', headers, { ...selection, optionColumns: [2, null, 4] }, null)).toMatchObject({ ok: false });
    expect(createSupplierRecipe('Agency', headers, { ...selection, priceColumn: 3 }, null)).toMatchObject({ ok: false, diagnostics: [{ code: 'duplicate-recipe-column' }] });
    expect(createSupplierRecipe('Agency', headers, { ...selection, confirmed: false }, null)).toMatchObject({ ok: false, diagnostics: [{ code: 'unconfirmed-mapping' }] });
  });

  it.each([
    ['unknown fields', JSON.stringify({ ...skuRecipe, storeCurrencyConfirmed: true }), 'invalid-recipe-schema'],
    ['unknown version', JSON.stringify({ ...skuRecipe, version: 2 }), 'unsupported-version'],
    ['numeric strings', JSON.stringify({ ...skuRecipe, dropThresholdPercent: '25' }), 'invalid-recipe-schema'],
    ['precision beyond engine support', JSON.stringify({ ...skuRecipe, dropThresholdPercent: 20.0001 }), 'invalid-recipe-schema'],
    ['control characters', JSON.stringify({ ...skuRecipe, supplierLabel: '\u202eagency' }), 'invalid-recipe-schema'],
    ['duplicate JSON keys', JSON.stringify(skuRecipe).replace('"version":1', '"version":2,"version":1'), 'duplicate-recipe-property'],
    ['duplicate nested escaped keys', JSON.stringify(skuRecipe).replace('"skuColumn":"SKU"', '"skuColumn":"Wrong","sku\\u0043olumn":"SKU"'), 'duplicate-recipe-property'],
  ])('fails closed for %s', (_, json, code) => {
    expect(parseSupplierRecipe(bytes(json))).toMatchObject({ ok: false, diagnostics: [{ code }] });
  });
});
