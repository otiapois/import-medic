import { expect, it } from 'vitest';
import { analyzeCatalogImpact, createCatalogImpact } from '../../../src/core/analytics/catalog-impact';
import { serializeCsv } from '../../../src/core/csv';
import { buildMultiSupplierDiff, buildPriceDiff, parseBaseline, parseSupplier } from '../../../src/core/shopify-price-diff';
import { createSignoffHtml } from '../../../src/core/shopify-price-diff/signoff-html';
import { parseWooCommerceBaseline } from '../../../src/core/woocommerce-price-diff';

const bytes = (headers: string[], rows: string[][]) => new TextEncoder().encode(serializeCsv(headers, rows, 'shopify-products'));

it('classifies exact boundaries independently of rounded display, and keeps review and missing rows out of the distribution', () => {
  const prices = ['79.999999999', '80', '94.999999999', '95', '99.999999999', '100', '100.000000001', '105', '105.000000001', '120', '120.000000001'];
  const base = parseBaseline(bytes(['Handle', 'Title', 'Variant SKU', 'Variant Price', 'Variant Inventory Qty', 'Option1 Name', 'Option1 Value'], [
    ...prices.map((_, index) => [`p-${index}`, `Product ${index}`, `SKU-${index}`, '100', '10']),
    ['flagged', 'Flagged', 'FLAGGED', '100', '12'], ['skipped', 'Skipped', 'SKIPPED', '100', '9'],
    ['missing', 'Missing', 'MISSING', '100', '7'], ['zero', 'Zero', 'ZERO', '0', '3'], ['stock', 'Stock', 'STOCK', '100', ''],
  ].map(row => [...row, 'Title', 'Default Title'])));
  const supplier = parseSupplier(bytes(['SKU', 'Price', 'Qty'], [
    ...prices.map((price, index) => [`SKU-${index}`, price, index === 0 ? '0' : '11']),
    ['FLAGGED', '0', '35'], ['SKIPPED', '150', '0'], ['ZERO', '100', '3'], ['STOCK', '100', '520'], ['OUTSIDE', '100', '30'],
  ]), 'market.csv').sheets[0];
  const selection = { confirmed: true, inventoryColumn: 2 };
  const resolutions = { 2: { confirm: true }, 14: { skip: true }, 15: { confirm: true } };
  const result = buildPriceDiff(base, supplier, selection, resolutions);
  const summary = analyzeCatalogImpact(result.rows, result.inventoryEnabled);
  expect(summary.histogram.map(({ count }) => count)).toEqual([1, 2, 2, 2, 2, 2, 1]);
  expect(summary.priceExcluded).toEqual({ missing: 1, flagged: 1, skipped: 1, unmatched: 1, unavailable: 1 });
  expect(summary.inventory).toEqual({ totalQtyBefore: '141', totalQtyAfter: '141', netQtyDelta: '0', newlyZeroedCount: 1, unknownQtyCount: 1 });
  expect(summary.margin).toMatchObject({ count: 0, watchlistCount: 0 });
  const batch = buildMultiSupplierDiff(base, [{ supplierId: 'primary', filename: 'market.csv', sheet: supplier, selection, resolutions }]);
  expect(analyzeCatalogImpact(batch.rows, batch.inventoryEnabled)).toEqual(summary);
});

it('uses exact FX costs, does not infer wholesale from a direct Price header, and includes Woo active sale prices', () => {
  const sku = 'high';
  const base = parseWooCommerceBaseline(bytes(['ID', 'Type', 'SKU', 'Parent', 'Name', 'Regular price', 'Sale price', 'Stock'], [
    ['1', 'simple', sku, '', 'Example', '20', '12', '12'], ['2', 'simple', 'zero', '', 'Example', '20', '0', "'-008"],
    ['3', 'simple', 'normal', '', 'Example', '20', '', '7'],
  ]));
  const supplier = parseSupplier(bytes(['SKU', 'Wholesale Cost', 'Qty'], [[sku, '10.00', '12'], ['zero', '10.00', '8'], ['normal', '10.00', '11']]), 's.csv').sheets[0];
  const fx = { sourceCurrency: 'EUR', storeCurrency: 'USD', fxRate: '1.20001' };
  const selection = { confirmed: true, inventoryColumn: 2, fxRateConfirmed: true,
    pricingRule: { mode: 'multiplier', multiplier: '2', fx } } as const;
  const result = buildPriceDiff(base, supplier, selection);
  expect(result.canDownload, JSON.stringify(result.issues)).toBe(true);
  const unconfirmed = buildPriceDiff(base, supplier, { ...selection, fxRateConfirmed: false });
  expect(analyzeCatalogImpact(unconfirmed.rows, unconfirmed.inventoryEnabled, unconfirmed.issues)).toMatchObject({
    margin: { count: 0, watchlistCount: 0 }, priceExcluded: { flagged: 3 }, inventory: { netQtyDelta: '0' },
  });
  const impact = createCatalogImpact(result.inventoryEnabled);
  expect(result.rows.map((row) => impact.add(row))).toEqual([
    { landedCost: '12.0001000', grossMarginPercent: '0.00', belowOrAtCost: true },
    { landedCost: '12.0001000', grossMarginPercent: null, belowOrAtCost: true },
    { landedCost: '12.0001000', grossMarginPercent: '50.00', belowOrAtCost: false },
  ]);
  expect(impact.summarize()).toMatchObject({ margin: { count: 2, averagePercent: '25.00', lowestPercent: '0.00', highestPercent: '50.00', watchlistCount: 2 },
    inventory: { totalQtyBefore: '11', totalQtyAfter: '31', netQtyDelta: '20' } });
  const report = createSignoffHtml(base, result);
  expect(report).toContain('Zero / Negative Margin Watchlist');
  const generic = parseSupplier(bytes(['SKU', 'Price'], [[sku, '22.00']]), 's.csv').sheets[0];
  expect(analyzeCatalogImpact(buildPriceDiff(base, generic, { confirmed: true }).rows, false).margin.count).toBe(0);
  const costDirect = buildPriceDiff(base, supplier, { confirmed: true }, { 2: { price: '20.00' }, 3: { price: '20.00' } });
  expect(analyzeCatalogImpact(costDirect.rows, false).margin.watchlistCount).toBe(2);
});

it('rounds exact arithmetic means at both signs of the half-hundredth boundary', () => {
  const base = parseBaseline(bytes(['Handle', 'Title', 'Variant SKU', 'Variant Price', 'Option1 Name', 'Option1 Value'], [
    ['a', 'A', 'A', '3', 'Title', 'Default Title'], ['b', 'B', 'B', '15', 'Title', 'Default Title'],
  ]));
  for (const [costs, averagePercent] of [[['2', '19.9985'], '0.01'], [['4', '10.0015'], '-0.01']] as const) {
    const supplier = parseSupplier(bytes(['SKU', 'Cost'], [['A', costs[0]], ['B', costs[1]]]), 'costs.csv').sheets[0];
    const result = buildPriceDiff(base, supplier, { confirmed: true }, { 2: { price: '3' }, 3: { price: '15' } });
    expect(analyzeCatalogImpact(result.rows, false).margin.averagePercent).toBe(averagePercent);
  }
});

it('renders hostile Shopify watchlist identities only as inert text', () => {
  const sku = '<img src=javascript:alert(1)>';
  const base = parseBaseline(bytes(['Handle', 'Title', 'Variant SKU', 'Variant Price', 'Option1 Name', 'Option1 Value'], [
    ['a', 'Example', sku, '10', 'Title', 'Default Title'],
  ]));
  const supplier = parseSupplier(bytes(['SKU', 'Cost'], [[sku, '12']]), 'costs.csv').sheets[0];
  const report = createSignoffHtml(base, buildPriceDiff(base, supplier, { confirmed: true }, { 2: { price: '11' } }));
  expect(report).toContain('&lt;img src=javascript&#58;alert(1)&gt;');
  expect(report).not.toMatch(/<img\b|javascript:/i);
});
