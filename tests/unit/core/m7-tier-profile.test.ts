import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeCsv, parseCsv } from '../../../src/core/csv';
import { buildPriceDiff, parseBaseline, parseSupplier, previewPricingFormula } from '../../../src/core/shopify-price-diff';
import { preparePricing, previewTierBrackets, validatePricingRule } from '../../../src/core/shopify-price-diff/pricing-rules';
import type { PricingBracket, PricingRule } from '../../../src/core/shopify-price-diff/pricing-rules';
import { readAmount } from '../../../src/core/shopify-price-diff/prices';
import { applySupplierRecipe, createSupplierRecipe, parseSupplierRecipe, serializeSupplierRecipe } from '../../../src/core/shopify-price-diff/recipe';
import { createSignoffHtml } from '../../../src/core/shopify-price-diff/signoff-html';
import { createWorkspaceProfile, parseWorkspaceProfile, serializeWorkspaceProfile, MAX_WORKSPACE_PROFILE_BYTES } from '../../../src/core/shopify-price-diff/workspace-profile';

const bytes = (text: string) => new TextEncoder().encode(text);
const brackets: PricingBracket[] = [
  { mode: 'multiplier', upTo: '20.00', multiplier: '2.5' },
  { mode: 'percent-markup', upTo: '100.00', markupPercent: '100' },
  { mode: 'multiplier', upTo: null, multiplier: '1.6' },
];
const pricingRule = { mode: 'tiered-brackets', brackets } satisfies PricingRule;
const fx = { sourceCurrency: 'EUR', storeCurrency: 'USD', fxRate: '1.25' };
const baseline = parseBaseline(readFileSync(new URL('../../../fixtures/shopify-price-diff/baseline-fx.csv', import.meta.url)));
const supplier = (input: string) => parseSupplier(bytes(input), 'supplier.csv');
const sheet = supplier('SKU,Cost,Currency\n001,16,EUR').sheets[0];
const map = { joinKey: 'sku', skuColumn: 0, priceColumn: 1, confirmed: true, dropThresholdPercent: 100, increaseThresholdPercent: 100_000 } as const;

describe('M7 exact tiered pricing', () => {
  it.each([
    ['19.99', '49.98', 1], ['20.00', '50.00', 1], ['20.0000000000000000000001', '40.00', 2],
    ['20.01', '40.02', 2], ['100', '200.00', 2], ['100.01', '160.02', 3],
  ] as const)('uses exact threshold boundaries for %s', (cost, expected, tier) => {
    const output = preparePricing(pricingRule)(readAmount(cost)!);
    expect(output?.text).toBe(expected);
    expect(output?.matchedTier).toMatch(new RegExp('^Tier ' + tier + ' '));
  });

  it.each([
    ['none', '50.00'], ['nearest-whole', '50.00'], ['ending-99', '50.99'], ['ending-95', '50.95'],
  ] as const)('preserves %s rounding on the exact post-FX boundary', (rounding, expected) => {
    const output = preparePricing({ ...pricingRule, rounding, fx })(readAmount('16.00')!);
    expect(output).toMatchObject({ text: expected, matchedTier: 'Tier 1 (<= 20.00): 2.5x' });
    expect(preparePricing({ ...pricingRule, rounding, fx })(readAmount('16.0001')!)?.matchedTier).toMatch(/^Tier 2/);
  });

  it('applies the fee after FX and honors the minimum before rejecting rounded zero', () => {
    const fee: PricingRule = {
      ...pricingRule, minimumRetail: '2.001', fx,
      brackets: [{ upTo: '20', mode: 'multiplier', multiplier: '0.001', fixedFee: '0.0001' },
        { upTo: null, mode: 'percent-markup', markupPercent: '12.50', fixedFee: '1.00' }],
    };
    const apply = preparePricing(fee);
    expect(apply(readAmount('0.0001')!)?.text).toBe('2.01');
    expect(apply(readAmount('20')!)?.text).toBe('29.13');
    expect(apply(readAmount('0')!)).toBeNull();
    expect(apply(readAmount('-2')!)).toBeNull();
  });

  it('provides store-currency previews for each tier without applying FX twice', () => {
    expect(previewTierBrackets({ ...pricingRule, fx })).toEqual([
      { sampleCost: '20.00', matchedTier: 'Tier 1 (<= 20.00): 2.5x', computedPrice: '50.00' },
      { sampleCost: '100.00', matchedTier: 'Tier 2 (<= 100.00): +100%', computedPrice: '200.00' },
      { sampleCost: '100.01', matchedTier: 'Tier 3 (catch-all): 1.6x', computedPrice: '160.02' },
    ]);
  });

  it.each([
    ['too few', [brackets[0]]],
    ['too many', Array.from({ length: 7 }, (_, index) => ({ ...brackets[0], upTo: index === 6 ? null : String(index + 1) }))],
    ['equal', [brackets[0], { ...brackets[1], upTo: '20.000' }, brackets[2]]],
    ['decreasing', [brackets[1], brackets[0], brackets[2]]],
    ['missing catch-all', [brackets[0], brackets[1]]],
    ['open first', [brackets[2], brackets[0], brackets[2]]],
    ['blank', [{ ...brackets[0], upTo: '' }, brackets[2]]],
    ['negative limit', [{ ...brackets[0], upTo: '-1' }, brackets[2]]],
    ['zero limit', [{ ...brackets[0], upTo: '0.0' }, brackets[2]]],
    ['zero multiplier', [{ ...brackets[0], multiplier: '0.0' }, brackets[2]]],
    ['negative multiplier', [{ ...brackets[0], multiplier: '-1' }, brackets[2]]],
    ['negative markup', [brackets[0], { ...brackets[1], markupPercent: '-1' }, brackets[2]]],
    ['negative fee', [{ ...brackets[0], fixedFee: '-0.001' }, brackets[2]]],
    ['invalid fee', [{ ...brackets[0], fixedFee: '1e2' }, brackets[2]]],
    ['unexpected key', [{ ...brackets[0], arbitrary: true }, brackets[2]]],
  ])('fails closed on a %s bracket configuration', (_description, invalidBrackets) => {
    const rule = { ...pricingRule, brackets: invalidBrackets } as PricingRule;
    expect(validatePricingRule(rule)).toBeTruthy();
    expect(previewTierBrackets(rule)).toEqual([]);
    expect(buildPriceDiff(baseline, sheet, { ...map, pricingRule: rule })).toMatchObject({
      canDownload: false, updateBytes: null, rollbackBytes: null, issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid-pricing-rule' })]),
    });
  });

  it('preserves matched tier evidence and existing audit tail across preview, comparison, CSV and HTML', () => {
    const selection = { ...map, fxRateConfirmed: true, pricingRule: { ...pricingRule, fx } };
    const matchedTier = 'Tier 1 (<= 20.00): 2.5x';
    expect(previewPricingFormula(baseline, sheet, selection)).toMatchObject({ matchedTier, computedPrice: '50.00' });
    const result = buildPriceDiff(baseline, sheet, selection, { 2: { price: '55.00' } });
    expect(result.canDownload).toBe(true);
    expect(JSON.parse(result.auditJson).rows[0]).toMatchObject({ matchedTier, computedPrice: '50.00', newPrice: '55.00' });
    const [header, summary, row] = parseCsv(decodeCsv(bytes(result.auditCsv)).text).records;
    expect(header.cells.slice(-3)).toEqual(['Matched Tier', 'FX Applied', 'Review and Resolution (JSON)']);
    expect(summary.cells).toHaveLength(header.cells.length);
    expect(row.cells.slice(-3, -1)).toEqual([matchedTier, 'EUR -> USD @ 1.25']);
    const html = createSignoffHtml(baseline, result, selection.pricingRule);
    expect(html).toContain('Shopify Price Update');
    expect(html).toContain('Tier 1 (&lt;= 20.00): 2.5x');
  });
});

describe('M7 portable local settings', () => {
  const profile = {
    version: 1, storeName: 'Local test store', platform: 'woocommerce', storeCurrency: 'USD',
    dropThresholdPercent: 45.125, increaseThresholdPercent: 240, inventoryDropThresholdPercent: 80,
    pricingRule: { ...pricingRule, minimumRetail: '9', rounding: 'ending-99' },
  } as const;

  it('roundtrips a v5 recipe and requires current worksheet, FX and batch confirmation', () => {
    const created = createSupplierRecipe('Vendor', ['SKU', 'Cost', 'Sale', 'Stock'], {
      ...map, compareAtColumn: 2, inventoryColumn: 3, inventoryDropThresholdPercent: 20,
      conflictPolicy: 'prefer-lowest', fxRateConfirmed: true, pricingRule: { ...pricingRule, fx },
    }, null, 'Local test store');
    if (!created.ok) throw new Error('Expected a v5 recipe');
    expect(created.value).toMatchObject({ version: 5, fxRateNeedsRecheck: true, pricingRule: { brackets }, inventoryColumn: 'Stock' });
    const persisted = serializeSupplierRecipe(created.value);
    expect(persisted).not.toMatch(/confirmed|fxRateConfirmed/);
    expect(parseSupplierRecipe(bytes(persisted))).toEqual(created);
    const updated = applySupplierRecipe(created.value, supplier('Sale,Stock,Cost,SKU\n45,7,16,001'), 0);
    expect(updated).toMatchObject({ ok: true, value: { selection: {
      skuColumn: 3, priceColumn: 2, compareAtColumn: 0, inventoryColumn: 1,
      confirmed: false, fxRateConfirmed: false, sameCurrencyConfirmed: false, pricingRule: { brackets },
    } } });
    expect(parseSupplierRecipe(bytes(persisted.replace('"fxRateNeedsRecheck": true,', ''))).ok).toBe(false);
  });

  it.each([1, 2, 3, 4])('rejects tiered content disguised as legacy version %s', (version) => {
    const recipe = createSupplierRecipe('Vendor', ['SKU', 'Cost'], { ...map, pricingRule }, null);
    if (!recipe.ok) throw new Error('Expected a v5 recipe');
    expect(parseSupplierRecipe(bytes(JSON.stringify({ ...recipe.value, version }))).ok).toBe(false);
  });

  it('roundtrips only the approved local defaults across profile encoding', () => {
    const result = createWorkspaceProfile(profile);
    expect(result).toEqual({ ok: true, value: profile });
    if (!result.ok) throw new Error('Expected a workspace profile');
    expect(parseWorkspaceProfile(bytes(serializeWorkspaceProfile(result.value)))).toEqual(result);
    expect(createWorkspaceProfile({ version: 1, storeName: 'Shop', platform: 'shopify', storeCurrency: 'GBP' }).ok).toBe(true);
  });

  it.each([
    ['unknown version', { version: 2 }], ['unknown platform', { platform: 'magento' }], ['unknown property', { files: ['private.csv'] }],
    ['confirmation state', { confirmed: true }], ['lowercase currency', { storeCurrency: 'usd' }], ['invalid currency', { storeCurrency: 'US D' }],
    ['empty name', { storeName: ' ' }], ['control character', { storeName: '\u202eStore' }],
    ['invalid threshold', { inventoryDropThresholdPercent: 100.1 }], ['fractional threshold', { increaseThresholdPercent: 0.0001 }],
    ['FX', { pricingRule: { ...pricingRule, fx } }], ['automatic compare-at', { pricingRule: { ...pricingRule, compareAtRule: { multiplier: '2' } } }],
    ['other pricing mode', { pricingRule: { mode: 'direct' } }],
  ])('rejects %s in profiles', (_description, invalid) => {
    const mutation = { ...profile, ...invalid };
    expect(createWorkspaceProfile(mutation).ok).toBe(false);
    expect(parseWorkspaceProfile(bytes(JSON.stringify(mutation))).ok).toBe(false);
  });

  it('rejects duplicate escaped keys, non-UTF-8 input and oversized profiles', () => {
    const duplicate = JSON.stringify(profile).replace('"upTo":"20.00"', '"upTo":"10","upT\\u006f":"20.00"');
    expect(parseWorkspaceProfile(bytes(duplicate))).toMatchObject({ ok: false, diagnostics: [{ code: 'duplicate-workspace-profile-property' }] });
    expect(parseWorkspaceProfile(new Uint8Array([0xff, 0xfe])).ok).toBe(false);
    expect(parseWorkspaceProfile(bytes(' '.repeat(MAX_WORKSPACE_PROFILE_BYTES + 1)))).toMatchObject({ ok: false, diagnostics: [{ code: 'workspace-profile-too-large' }] });
  });
});
