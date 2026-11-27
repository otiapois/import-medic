import { describe, expect, it } from 'vitest';
import { SIGNOFF_ACCENTS, brandSignoffHtml, type SignoffBrand } from '../../../src/core/branding/signoff-brand';
import { parseBigCommerceBaseline } from '../../../src/core/bigcommerce-price-diff';
import { parseCsv } from '../../../src/core/csv';
import { parseBaseline, parseSupplier, previewPricingFormula } from '../../../src/core/shopify-price-diff';
import { applySupplierRecipe, createSupplierRecipe, parseSupplierRecipe, serializeSupplierRecipe } from '../../../src/core/shopify-price-diff/recipe';
import { createWorkspaceProfile } from '../../../src/core/shopify-price-diff/workspace-profile';
import { runPriceComparison, simulatePriceScenarios, type PriceComparison } from '../../../src/core/whatif/simulator';
import { parseWooCommerceBaseline } from '../../../src/core/woocommerce-price-diff';

const bytes = (value: string) => new TextEncoder().encode(value);
const agency = { agencyName: '<script>alert(1)</script> & "Co"', preparedFor: 'Customer', contactNote: '', accentKey: 'navy' } as const;

describe('agency white-label reports', () => {
  it('round-trips a version 1 workspace with a literal agency name', () => {
    const input = { version: 1, storeName: 'Store', platform: 'shopify', storeCurrency: 'USD',
      branding: agency };
    expect(createWorkspaceProfile(input)).toEqual({ ok: true, value: input });
  });

  it('uses the four high-contrast palettes and rejects a palette with CSS syntax', () => {
    function luminance(hex: string) {
      const srgb = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
      const [r, g, b] = srgb.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    expect(Object.keys(SIGNOFF_ACCENTS)).toEqual(['forest', 'navy', 'slate', 'burgundy']);
    for (const { foreground, background } of Object.values(SIGNOFF_ACCENTS)) {
      expect((luminance(foreground) + 0.05) / (luminance(background) + 0.05)).toBeGreaterThanOrEqual(5.5);
    }
    const html = '<!doctype html><html><body><main>Existing report</main></body></html>';
    expect(brandSignoffHtml(html)).toBe(html);
    expect(() => brandSignoffHtml(html, { ...agency, accentKey: 'navy;background:url(evil)' } as unknown as SignoffBrand)).toThrow();
    expect(brandSignoffHtml(html, { ...agency, agencyName: '$& $1' })).toContain('<strong>$&amp; $1</strong>');
  });
});

function shopify(prices: string[]) {
  return parseBaseline(bytes('Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price,Price / UAE,Price / EU\n' +
    prices.map((price, index) => ['bag', index ? '' : 'Bag', 'Color', 'Option ' + (index + 1), '000' + (index + 1), '999.99', price, '444.00'].join(',')).join('\n')));
}

describe('what-if scenarios', () => {
  it('keeps existing recipe versions when the adjustment field is unset', () => {
    const selection = { joinKey: 'sku', skuColumn: 0, priceColumn: 1, confirmed: true,
      pricingRule: { mode: 'multiplier', multiplier: '2', retailAdjustmentPercent: undefined } } as const;
    expect(createSupplierRecipe('Vendor', ['SKU', 'Cost'], selection, null))
      .toMatchObject({ ok: true, value: { version: 2, pricingRule: { mode: 'multiplier', multiplier: '2' } } });
    expect(createSupplierRecipe('Vendor', ['SKU', 'Cost'], { ...selection, pricingRule: {
      ...selection.pricingRule, fx: { sourceCurrency: 'USD', storeCurrency: 'AED', fxRate: '2' },
    } }, null)).toMatchObject({ ok: true, value: { version: 3, fxRateNeedsRecheck: true } });
  });

  it('uses the exact scoped FX rule and keeps skips and final overrides beneath the scenario floor', () => {
    const baseline = shopify(['60.00', '100.00', '40.00']);
    const filename = 'costs.csv';
    const sheet = parseSupplier(bytes('SKU,Cost,Currency\n0001,10,USD\n0002,30,USD\n0003,12,USD'), filename).sheets[0];
    const comparison: Extract<PriceComparison, { kind: 'single' }> = { kind: 'single', supplier: {
      supplierId: 'primary', filename, sheet,
      selection: { market: 'UAE', joinKey: 'sku', skuColumn: 0, priceColumn: 1, confirmed: true, fxRateConfirmed: true,
        pricingRule: { mode: 'multiplier', multiplier: '2', fixedFee: '1', fx: { sourceCurrency: 'USD', storeCurrency: 'AED', fxRate: '2' } } },
      resolutions: { 3: { price: '50' }, 4: { skip: true } },
    } };
    const [current, scenario, fx] = simulatePriceScenarios(baseline, comparison, [
      { id: 'current' }, { id: 'floor', markupPercent: '5', minimumRetail: '55' }, { id: 'fx', fxBufferPercent: '3' },
    ]);
    expect(current).toMatchObject({ status: 'ready', canApply: false, totalRetailDeltaCents: '-6900' });
    expect(scenario).toMatchObject({
      status: 'ready', canApply: true, changedSkuCount: 2, marginSkuCount: 2, averageMarginPercent: '21.818182',
      negativeMarginSkuCount: 1, subFloorSkuCount: 1, totalRetailDeltaCents: '-5500', minMarginSku: '0002',
    });
    expect(fx.suppliers[0].pricingRule?.fx?.fxRate).toBe('2.06');
    const applied = runPriceComparison(baseline, {
      kind: 'single', supplier: { ...comparison.supplier, selection: { ...comparison.supplier.selection, pricingRule: scenario.suppliers[0].pricingRule } },
    });
    const [header, ...rows] = parseCsv(applied.updateCsv!).records;
    expect(header.cells.at(-1)).toBe('Price / UAE');
    expect(rows.map(({ cells }) => cells.at(-1))).toEqual(['55.00', '50', '40.00']);
    expect(applied.rollbackVerification).toMatchObject({ checked: true, restoredVariants: 3 });
    const audit = JSON.parse(applied.auditJson);
    expect(JSON.stringify(audit)).toContain('"retailAdjustmentPercent":"5"');
    const recipe = createSupplierRecipe('Vendor', sheet.headers, { ...comparison.supplier.selection, pricingRule: scenario.suppliers[0].pricingRule }, null);
    expect(recipe).toMatchObject({ ok: true, value: { version: 4, pricingRule: { retailAdjustmentPercent: '5' } } });
    if (!recipe.ok) throw new Error('Expected scenario recipe');
    const loaded = parseSupplierRecipe(bytes(serializeSupplierRecipe(recipe.value)));
    expect(loaded).toEqual(recipe);
    expect(applySupplierRecipe(recipe.value, { name: filename, sheets: [sheet], issues: [] }, 0)).toMatchObject({
      ok: true, value: { selection: { fxRateConfirmed: false, pricingRule: scenario.suppliers[0].pricingRule } },
    });
  });

  it.each([
    ['WooCommerce', parseWooCommerceBaseline(bytes('ID,Type,SKU,Parent,Regular price,Sale price\n1,simple,0001,,40,30'))],
    ['BigCommerce', parseBigCommerceBaseline(bytes('Item Type,Product ID,Product Name,Product Code/SKU,Price,Sale Price\nProduct,1,Bag,0001,40,30'))],
  ] as const)('uses mapped and retained %s sale prices and holds a regular price below the retained sale', (_, baseline) => {
    const filename = 'costs.csv';
    const sheet = parseSupplier(bytes('SKU,Cost,Sale Price\n0001,28,25'), filename).sheets[0];
    const comparison: PriceComparison = { kind: 'single', supplier: { supplierId: 'primary', filename, sheet,
      selection: { joinKey: 'sku', skuColumn: 0, priceColumn: 1, compareAtColumn: 2, confirmed: true,
        pricingRule: { mode: 'multiplier', multiplier: '1.5' } } } };
    const [result] = simulatePriceScenarios(baseline, comparison, [{ id: 'sale', rounding: 'ending-95', minimumRetail: '28' }]);
    expect(result).toMatchObject({ status: 'ready', canApply: true, changedSkuCount: 1, marginSkuCount: 1,
      averageMarginPercent: '-12.000000', minMarginSku: '0001', negativeMarginSkuCount: 1, subFloorSkuCount: 1, totalRetailDeltaCents: '-500' });
    const noSaleMapping: PriceComparison = { kind: 'single', supplier: {
      ...comparison.supplier, selection: { ...comparison.supplier.selection, compareAtColumn: null },
    } };
    const [retained, belowSale] = simulatePriceScenarios(baseline, noSaleMapping, [
      { id: 'retain', rounding: 'ending-95' }, { id: 'below-sale', markupPercent: '-40' },
    ]);
    expect(retained).toMatchObject({ status: 'ready', canApply: true, averageMarginPercent: '6.666667',
      negativeMarginSkuCount: 0, totalRetailDeltaCents: '0' });
    expect(belowSale).toMatchObject({ status: 'review', canApply: false, totalRetailDeltaCents: null, averageMarginPercent: null });
    const applied = runPriceComparison(baseline, { kind: 'single', supplier: {
      ...noSaleMapping.supplier, selection: { ...noSaleMapping.supplier.selection, pricingRule: retained.suppliers[0].pricingRule },
    } });
    expect(applied.rows[0]).toMatchObject({ oldCompareAtPrice: '30', newCompareAtPrice: '30', compareAtOutput: 'omitted' });
    expect(parseCsv(applied.updateCsv!).records[0].cells.map((column) => column.toLowerCase())).not.toContain('sale price');
  });

  it('reselects the exact post-FX cost bracket and compounds the applied pre-round retail adjustment', () => {
    const baseline = shopify(['50.00']);
    const filename = 'brackets.csv';
    const sheet = parseSupplier(bytes('SKU,Cost,Currency\n0001,10.000,USD'), filename).sheets[0];
    const comparison: Extract<PriceComparison, { kind: 'single' }> = { kind: 'single', supplier: {
      supplierId: 'primary', filename, sheet, selection: {
        market: 'UAE', joinKey: 'sku', skuColumn: 0, priceColumn: 1, confirmed: true, fxRateConfirmed: true,
        pricingRule: { mode: 'tiered-brackets', brackets: [
          { upTo: '20', mode: 'multiplier', multiplier: '2', fixedFee: '.25' },
          { upTo: null, mode: 'multiplier', multiplier: '3', fixedFee: '.33' },
        ], retailAdjustmentPercent: '5', fx: { sourceCurrency: 'USD', storeCurrency: 'AED', fxRate: '2' } },
      },
    } };
    const [current, adjusted] = simulatePriceScenarios(baseline, comparison, [
      { id: 'current' }, { id: 'combined', markupPercent: '5', fxBufferPercent: '3', rounding: 'ending-95' },
    ]);
    expect(current).toMatchObject({ status: 'ready', totalRetailDeltaCents: '-774' });
    expect(adjusted).toMatchObject({ status: 'ready', canApply: true, totalRetailDeltaCents: '1895' });
    const selection = { ...comparison.supplier.selection, pricingRule: adjusted.suppliers[0].pricingRule };
    expect(selection.pricingRule?.retailAdjustmentPercent).toBe('10.25');
    expect(previewPricingFormula(baseline, sheet, selection)).toMatchObject({ computedPrice: '68.95',
      matchedTier: expect.stringMatching(/^Tier 2/), fxApplied: { fxRate: '2.06' }, retailAdjustmentPercent: '10.25' });
  });

  it('withholds cent totals for a legacy sub-cent price, and holds unresolved scenario inputs', () => {
    const baseline = shopify(['20.001']);
    const filename = 'supplier.csv';
    const sheet = parseSupplier(bytes('SKU,Price\n0001,30.001'), filename).sheets[0];
    const comparison: PriceComparison = { kind: 'single', supplier: { supplierId: 'primary', filename, sheet,
      selection: { market: 'UAE', joinKey: 'sku', skuColumn: 0, priceColumn: 1, confirmed: true } } };
    const [current, fx, invalid] = simulatePriceScenarios(baseline, comparison, [
      { id: 'current' }, { id: 'fx', fxBufferPercent: '3' }, { id: 'markup', markupPercent: '-100' },
    ]);
    expect(current).toMatchObject({ status: 'ready', totalRetailDeltaCents: null, unknownRetailSkuCount: 1, averageMarginPercent: null });
    expect(fx).toMatchObject({ status: 'invalid', canApply: false, message: expect.stringContaining('manual FX') });
    expect(invalid).toMatchObject({ status: 'invalid', canApply: false });
    expect(() => simulatePriceScenarios(baseline, comparison, Array.from({ length: 7 }, (_, index) => ({ id: String(index) })))).toThrow(/six/);
  });
});
