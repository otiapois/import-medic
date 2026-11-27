import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeCsv, parseCsv } from '../../../src/core/csv';
import { buildPriceDiff, parseBaseline, parseSupplier, previewPricingFormula } from '../../../src/core/shopify-price-diff';
import type { ColumnSelection, PricingRule } from '../../../src/core/shopify-price-diff';
import { applySupplierRecipe, createSupplierRecipe, parseSupplierRecipe, serializeSupplierRecipe } from '../../../src/core/shopify-price-diff/recipe';

const bytes = (text: string) => new TextEncoder().encode(text);
const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/shopify-price-diff/${name}`, import.meta.url));
const csv = (data: Uint8Array) => parseCsv(decodeCsv(data).text).records.map(({ cells }) => cells);
const baseline = parseBaseline(fixture('baseline-fx.csv'));
const source = parseSupplier(fixture('supplier-fx.csv'), 'supplier-fx.csv');
const sheet = source.sheets[0];
const supplier = (rows: string, headers = 'SKU,Cost,Compare-at price,Currency') => parseSupplier(bytes(`${headers}\n${rows}`), 'batch.csv').sheets[0];
const fx = { sourceCurrency: 'EUR', storeCurrency: 'USD', fxRate: '1.0850' };
const compareAtRule = { multiplier: '1.25' };
const rule: PricingRule = { mode: 'multiplier', multiplier: '2.2', rounding: 'ending-99', fx, compareAtRule };
const selection: ColumnSelection = { joinKey: 'sku', skuColumn: 0, priceColumn: 1, confirmed: true, fxRateConfirmed: true, pricingRule: rule };

describe('batch FX and Compare-at', () => {
  it('produces a local draft without confirmation and blocks both native files until confirmed', () => {
    const unconfirmed = { ...selection, fxRateConfirmed: false };
    expect(previewPricingFormula(baseline, sheet, unconfirmed)).toEqual({ supplierRow: 2, supplierPrice: '10.00 EUR', computedPrice: '23.99', computedCompareAtPrice: '29.99', fxApplied: fx });
    expect(buildPriceDiff(baseline, sheet, unconfirmed)).toMatchObject({ canDownload: false, updateBytes: null, rollbackBytes: null, issues: [expect.objectContaining({ code: 'fx-rate-confirmation-required' })] });
  });

  it('exports exact FX and automatic Compare-at prices and replays original costs, cells and blanks', () => {
    const result = buildPriceDiff(baseline, sheet, selection);
    expect(result.rows[0]).toMatchObject({ computedPrice: '23.99', newPrice: '23.99', newCompareAtPrice: '29.99', fxApplied: fx });
    expect(result.rows[1]).toMatchObject({ computedPrice: '25.99', newCompareAtPrice: '32.99' });
    expect(result.rollbackVerification).toEqual({ checked: true, restoredVariants: 2 });
    const [headers, ...update] = csv(result.updateBytes!);
    const [rollbackHeaders, ...rollback] = csv(result.rollbackBytes!);
    expect(rollbackHeaders).toEqual(headers);
    expect(update.map((row) => row.slice(-3))).toEqual([['001', '23.99', '29.99'], ['002', '25.99', '32.99']]);
    expect(rollback.map((row) => [row[1], row[2], row[3], ...row.slice(-3)])).toEqual([
      ['  Alpine, "Black"  ', 'Color', 'Black', '001', '020.000', ''], ['', '', 'Blue', '002', '25.000', '035.000'],
    ]);
    expect(headers).not.toContain('Tags');
    expect(headers).not.toContain('Image Src');
    expect(JSON.parse(result.auditJson).rows[0].fxApplied).toEqual(fx);
    const [auditHeaders, , audit] = csv(bytes(result.auditCsv));
    expect(audit[auditHeaders.indexOf('FX Applied')]).toBe('EUR -> USD @ 1.0850');
    expect(auditHeaders.at(-1)).toBe('Review and Resolution (JSON)');
  });

  it('recomputes automatic Compare-at after a manual retail change in store units', () => {
    const result = buildPriceDiff(baseline, sheet, selection, { 2: { price: '30.000' } });
    expect(result.canDownload).toBe(true);
    expect(result.rows[0]).toMatchObject({ computedPrice: '23.99', newPrice: '30.000', newCompareAtPrice: '37.99', fxApplied: fx });
    expect(csv(result.updateBytes!)[1].slice(-2)).toEqual(['30.000', '37.99']);
  });

  it('does not convert Store Compare-at overrides twice', () => {
    const result = buildPriceDiff(baseline, sheet, selection, { 2: { compareAtPrice: '27.50 USD' } });
    expect(result.canDownload).toBe(true);
    expect(csv(result.updateBytes!)[1].slice(-2)).toEqual(['23.99', '27.50']);
  });

  it('converts a mapped compare-at into store cents without markup or retail endings', () => {
    const result = buildPriceDiff(baseline, sheet, { ...selection, compareAtColumn: 2, pricingRule: { ...rule, compareAtRule: undefined } });
    expect(result.canDownload).toBe(true);
    expect(csv(result.updateBytes!)[1].slice(-2)).toEqual(['23.99', '28.75']);
  });

  it('blocks equality, even with explicit row confirmation, and allows correction', () => {
    const mapped = { confirmed: true, compareAtColumn: 2 };
    const batch = supplier('001,22,22,\n003,9,11,');
    const result = buildPriceDiff(baseline, batch, mapped, { 2: { confirm: true } });
    expect(result).toMatchObject({ canDownload: false, updateBytes: null, rollbackBytes: null });
    expect(result.rows[0]).toMatchObject({ status: 'Blocked', newCompareAtPrice: '22', issues: [expect.objectContaining({ code: 'compare-at-not-above-price', blocking: true, row: 2, value: '22' })] });
    expect(buildPriceDiff(baseline, batch, mapped, { 2: { compareAtPrice: '22.01' } }).canDownload).toBe(true);
    const skipped = buildPriceDiff(baseline, batch, mapped, { 2: { skip: true } });
    expect(skipped.canDownload).toBe(true);
    expect(csv(skipped.updateBytes!)[1].slice(-3)).toEqual(['003', '9', '11']);
  });

  it('checks a baseline Compare-at retained from a blank mapped supplier cell', () => {
    const result = buildPriceDiff(baseline, supplier('002,36,,'), { confirmed: true, compareAtColumn: 2 });
    expect(result.rows[1]).toMatchObject({ status: 'Blocked', newPrice: '36', newCompareAtPrice: '035.000', issues: [expect.objectContaining({ code: 'compare-at-not-above-price' })] });
  });

  it('saves an FX rate with a literal recheck and restores it unconfirmed against reordered headers', () => {
    const made = createSupplierRecipe('Supplier', sheet.headers, selection, null, 'Store');
    expect(made).toMatchObject({ ok: true, value: { version: 3, fxRateNeedsRecheck: true, pricingRule: rule } });
    if (!made.ok) throw new Error('Expected FX recipe');
    const serialized = serializeSupplierRecipe(made.value);
    expect(serialized).not.toContain('fxRateConfirmed');
    expect(parseSupplierRecipe(bytes(serialized))).toEqual(made);
    const batch = parseSupplier(bytes('Currency,Cost,SKU\nEUR,10,001'), 'next.csv');
    const reloaded = applySupplierRecipe(made.value, batch, 0);
    expect(reloaded).toMatchObject({ ok: true, value: { selection: { confirmed: false, fxRateConfirmed: false, skuColumn: 2, priceColumn: 1, pricingRule: rule } } });
    if (!reloaded.ok) throw new Error('Expected reapplied recipe');
    expect(buildPriceDiff(baseline, batch.sheets[0], { ...reloaded.value.selection, confirmed: true }).canDownload).toBe(false);
    expect(buildPriceDiff(baseline, batch.sheets[0], { ...reloaded.value.selection, confirmed: true, fxRateConfirmed: true }).canDownload).toBe(true);
  });

  it.each(['', '0', '-0.1', '1e-2', 'NaN', 'Infinity', '1,08', '1. 085', undefined, 1.085])('rejects invalid FX rate %s even with confirmation', (fxRate) => {
    const pricingRule = { mode: 'direct', fx: { ...fx, fxRate } } as PricingRule;
    expect(buildPriceDiff(baseline, sheet, { ...selection, pricingRule })).toMatchObject({ canDownload: false, updateBytes: null, rollbackBytes: null, issues: [expect.objectContaining({ code: 'invalid-pricing-rule' })] });
    expect(previewPricingFormula(baseline, sheet, { ...selection, pricingRule })).toBeNull();
  });

  it.each([
    ['FX precedes one rounding step', '0.025', '.5', { mode: 'multiplier', multiplier: '2' }, '0.03'],
    ['fixed fee uses store currency', '10.03', '.5', { mode: 'multiplier', multiplier: '2', fixedFee: '1.005' }, '11.04'],
    ['markup uses the full conversion', '0.14', '1.25', { mode: 'percent-markup', markupPercent: '10' }, '0.19'],
    ['target margin uses the full conversion', '3.215', '1.25', { mode: 'target-margin', marginPercent: '25' }, '5.36'],
    ['nearest whole compares exact half units', '13.6', '1.25', { mode: 'direct', rounding: 'nearest-whole' }, '17.00'],
    ['FX amount remains exact immediately below a half cent', '10.004999999999999999999', '1', { mode: 'direct' }, '10.00'],
  ] as const)('%s', (_, cost, fxRate, pricing, expected) => {
    const result = buildPriceDiff(baseline, supplier(`001,${cost},,`), { ...selection, dropThresholdPercent: 100, pricingRule: { ...pricing, fx: { ...fx, fxRate } } });
    expect(result.canDownload).toBe(true);
    expect(result.rows[0].computedPrice).toBe(expected);
    expect(csv(result.updateBytes!)[1].at(-1)).toBe(expected);
  });

  it.each([
    ['price text', '001,USD 10,30,EUR', 1],
    ['mapped compare-at text', '001,10,30 GBP,EUR', 2],
    ['dedicated currency column', '001,10,30,CAD', 3],
    ['price currency symbol', '001,$10,30,EUR', 1],
    ['currency symbols after manual replacement', '001,10 CAD,30,EUR', 1],
  ] as const)('blocks contradictory supplier units in %s', (_, row, column) => {
    const input = supplier(row + '\n003,9,11,EUR');
    const mapped = { ...selection, compareAtColumn: 2, pricingRule: { mode: 'direct', fx } as const };
    const result = buildPriceDiff(baseline, input, mapped, { 2: { price: '22', compareAtPrice: '31', confirm: true } });
    expect(result).toMatchObject({ canDownload: false, updateBytes: null, rollbackBytes: null });
    expect(result.rows[0]).toMatchObject({ status: 'Blocked', issues: [expect.objectContaining({ code: 'fx-source-currency-conflict', column: input.headers[column], row: 2 })] });
    expect(previewPricingFormula(baseline, input, mapped)?.supplierRow).toBe(3);
    expect(buildPriceDiff(baseline, input, mapped, { 2: { skip: true } }).canDownload).toBe(true);
  });

  it('recognizes an explicit source currency that matches a supplier currency symbol', () => {
    const input = supplier('001,€10,30,EUR');
    const result = buildPriceDiff(baseline, input, { ...selection, dropThresholdPercent: 100, pricingRule: { mode: 'direct', fx } });
    expect(result.canDownload).toBe(true);
    expect(result.rows[0]).toMatchObject({ newPrice: '10.85', fxApplied: fx });
    expect(result.issues.map(({ code }) => code)).not.toContain('currency-confirmation-required');
  });

  it('requires the same currency confirmation and original audit fields when FX is off', () => {
    const result = buildPriceDiff(baseline, sheet, { confirmed: true, dropThresholdPercent: 100 });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'currency-confirmation-required' }));
    const allowed = buildPriceDiff(baseline, sheet, { confirmed: true, sameCurrencyConfirmed: true, dropThresholdPercent: 100 });
    expect(allowed.canDownload).toBe(true);
    expect(JSON.parse(allowed.auditJson).rows[0]).not.toHaveProperty('fxApplied');
    expect(JSON.parse(allowed.auditJson).mapping).not.toHaveProperty('fxRateConfirmed');
    expect(csv(bytes(allowed.auditCsv))[0]).not.toContain('FX Applied');
  });

  it.each([
    ['retail', { price: '25 EUR' }, 'invalid-price'],
    ['compare-at', { compareAtPrice: '30 EUR' }, 'invalid-compare-at-price'],
  ] as const)('validates the store unit on manual %s overrides', (_, resolution, code) => {
    const result = buildPriceDiff(baseline, sheet, selection, { 2: resolution });
    expect(result.canDownload).toBe(false);
    expect(result.rows[0].issues).toContainEqual(expect.objectContaining({ code, blocking: true }));
  });

  it.each([
    ['nearest whole equality', { mode: 'direct', rounding: 'nearest-whole', compareAtRule: { multiplier: '1.01' } }, '20.00'],
    ['cent rounding ends below a raw high-precision retail', { mode: 'direct', compareAtRule: { multiplier: '1.00001' } }, '20.00'],
    ['a retail floor does not lift automatic Compare-at', { mode: 'direct', minimumRetail: '25', compareAtRule: { multiplier: '0.9' } }, '22.50'],
  ] as const)('blocks automatic Compare-at for %s', (_, pricingRule, compareAt) => {
    const result = buildPriceDiff(baseline, supplier('001,20.004,,'), { confirmed: true, pricingRule }, { 2: { confirm: true } });
    expect(result.canDownload).toBe(false);
    expect(result.rows[0]).toMatchObject({ newCompareAtPrice: compareAt, issues: [expect.objectContaining({ code: 'compare-at-not-above-price' })] });
    expect(buildPriceDiff(baseline, supplier('001,20.004,,'), { confirmed: true, pricingRule }, { 2: { compareAtPrice: '35.000' } }).canDownload).toBe(true);
  });

  it('leaves a lower existing compare-at outside the scope if neither rule nor mapping is selected', () => {
    const result = buildPriceDiff(baseline, supplier('002,36,4,'), { confirmed: true });
    expect(result.canDownload).toBe(true);
    expect(csv(result.updateBytes!)[0]).not.toContain('Variant Compare At Price');
    expect(csv(result.rollbackBytes!)[0]).not.toContain('Variant Compare At Price');
    expect(result.rows[1]).toMatchObject({ newCompareAtPrice: '035.000', compareAtOutput: 'omitted' });
  });

  it('requires the baseline compare-at column when the auto rule is selected', () => {
    const noCompare = parseBaseline(fixture('baseline-no-compare-at.csv'));
    const result = buildPriceDiff(noCompare, sheet, { ...selection });
    expect(result).toMatchObject({ canDownload: false, updateBytes: null, rollbackBytes: null });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing-baseline-compare-at' }));
  });

  it('requires an unambiguous choice between automatic and mapped Compare-at', () => {
    const conflicting = { ...selection, compareAtColumn: 2 };
    expect(buildPriceDiff(baseline, sheet, conflicting)).toMatchObject({ canDownload: false, issues: [expect.objectContaining({ code: 'conflicting-compare-at-rules' })] });
    expect(createSupplierRecipe('Supplier', sheet.headers, conflicting, null)).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'conflicting-compare-at-rules' })] });
  });

  it('emits compare-at-only v3 without a rate marker and preserves direct retail precision', () => {
    const settings: ColumnSelection = { ...selection, pricingRule: { mode: 'direct', compareAtRule } };
    const input = supplier('001,22.003,,');
    const result = buildPriceDiff(baseline, input, settings);
    expect(csv(result.updateBytes!)[1].slice(-2)).toEqual(['22.003', '27.50']);
    const created = createSupplierRecipe('Supplier', input.headers, settings, null);
    expect(created).toMatchObject({ ok: true, value: { version: 3, compareAtColumn: null, pricingRule: settings.pricingRule } });
    if (!created.ok) throw new Error('Expected Compare-at recipe');
    expect(created.value).not.toHaveProperty('fxRateNeedsRecheck');
    expect(parseSupplierRecipe(bytes(serializeSupplierRecipe(created.value)))).toEqual(created);
  });

  it.each([
    ['missing FX rate recheck', { fxRateNeedsRecheck: undefined }],
    ['false FX rate recheck', { fxRateNeedsRecheck: false }],
    ['persisted FX confirmation', { fxRateConfirmed: true }],
    ['a legacy version with v3 pricing extensions', { version: 2, fxRateNeedsRecheck: undefined }],
    ['an FX marker on a compare-at-only v3', { pricingRule: { mode: 'direct', compareAtRule } }],
    ['unextended v3', { pricingRule: { mode: 'direct' }, fxRateNeedsRecheck: undefined }],
  ])('rejects a recipe with %s', (_, changes) => {
    const created = createSupplierRecipe('Supplier', sheet.headers, selection, null);
    if (!created.ok) throw new Error('Expected FX recipe');
    expect(parseSupplierRecipe(bytes(JSON.stringify({ ...created.value, ...changes })))).toMatchObject({ ok: false });
  });

  it('exports legacy recipe versions without extension fields for default and regular pricing', () => {
    const v1 = createSupplierRecipe('Supplier', sheet.headers, { ...selection, pricingRule: { mode: 'direct', fx: undefined } }, null);
    const v2 = createSupplierRecipe('Supplier', sheet.headers, { ...selection, pricingRule: { mode: 'multiplier', multiplier: '2', compareAtRule: undefined } }, null);
    expect(v1).toMatchObject({ ok: true, value: { version: 1 } });
    expect(v2).toMatchObject({ ok: true, value: { version: 2, pricingRule: { mode: 'multiplier', multiplier: '2' } } });
    if (!v1.ok || !v2.ok) throw new Error('Expected legacy recipes');
    expect(JSON.parse(serializeSupplierRecipe(v1.value))).not.toHaveProperty('pricingRule');
    expect(JSON.parse(serializeSupplierRecipe(v2.value)).pricingRule).toEqual({ mode: 'multiplier', multiplier: '2' });
  });
});
