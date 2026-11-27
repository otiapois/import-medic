import { readFileSync } from 'node:fs';
import Papa from 'papaparse';
import { expect, it } from 'vitest';
import { buildPriceDiff, parseBaseline, parseSupplier } from '../../../src/core/shopify-price-diff';
import type { PricingRule } from '../../../src/core/shopify-price-diff/pricing-rules';
import { createSignoffHtml } from '../../../src/core/shopify-price-diff/signoff-html';

const bytes = (rows: string[][]) => new TextEncoder().encode(Papa.unparse(rows, { newline: '\n' }));
const header = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Variant Compare At Price'];

it('reports exact counts and escapes hostile titles, SKUs and URL text', () => {
  const sku = '001<&"\'';
  const title = '<script src="https://example.invalid/app.js">a & b</script>';
  const baseline = parseBaseline(bytes([
    header,
    ['first', title, 'Size', 'S', sku, '10.00', '15.00'],
    ['first', '', '', 'L', '002', '20.00', '25.00'],
    ['second', 'Second', 'Title', 'Default Title', '003', '10.00', ''],
    ['third', 'Third', 'Title', 'Default Title', '004', '10.00', ''],
    ['fourth', 'Fourth', 'Title', 'Default Title', '005', '10.00', ''],
  ]));
  const supplier = parseSupplier(bytes([['SKU', 'Price'], [sku, '12.00'], ['002', '18.00'], ['003', '10.00'], ['004', '11.00'], ['005', '0']]), 'supplier.csv').sheets[0];
  const html = createSignoffHtml(baseline, buildPriceDiff(baseline, supplier, { confirmed: true }, { 5: { skip: true } }));

  expect(html).toContain('<title>Shopify Price Update — Client Sign-Off Summary</title>');
  expect(html).toContain('<dt>Updated variants</dt><dd>2</dd>');
  expect(html).toContain('<dt>Skipped / unchanged</dt><dd>1 / 1</dd>');
  expect(html).toContain('<dt>Blocked / flagged</dt><dd>1</dd>');
  expect(html).toContain('<dt>Avg price delta %</dt><dd>5.00%</dd>');
  expect(html).toContain('<dt>Rollback CSV pair</dt><dd>Unavailable for this comparison</dd>');
  expect(html).toContain('001&lt;&amp;&quot;&#39;');
  expect(html).toContain('&lt;script src=&quot;https&#58;//example.invalid/app.js&quot;&gt;a &amp; b&lt;/script&gt;');
  expect(html).not.toMatch(/<script\b|https?:\/\//i);
  expect(html).toContain('Content-Security-Policy');
  expect(html).toContain("default-src 'none'");
  expect(html).toContain("script-src 'none'");
  expect(html).toContain('@media print');
});

it('discloses the pricing rule, exact FX rate, compare-at and verified rollback', () => {
  const fixture = (name: string) => readFileSync(new URL('../../../fixtures/shopify-price-diff/' + name, import.meta.url));
  const baseline = parseBaseline(fixture('baseline-fx.csv'));
  const supplier = parseSupplier(fixture('supplier-fx.csv'), 'supplier-fx.csv').sheets[0];
  const rule: PricingRule = {
    mode: 'multiplier', multiplier: '2.2', rounding: 'ending-99',
    fx: { sourceCurrency: 'EUR', storeCurrency: 'USD', fxRate: '1.0850' },
    compareAtRule: { multiplier: '1.25' },
  };
  const result = buildPriceDiff(baseline, supplier, { confirmed: true, fxRateConfirmed: true, pricingRule: rule });
  const html = createSignoffHtml(baseline, result, rule);
  expect(result.canDownload).toBe(true);
  expect(html).toContain('Multiplier × 2.2 · .99 ending · Automatic compare-at × 1.25');
  expect(html).toContain('EUR → USD × 1.0850');
  expect(html).toContain('<td>23.99</td>');
  expect(html).toContain('— → 29.99');
  expect(html).toContain('Verified with update · 2 variant rows');
});

it('caps the table at 500 rows, prioritizes flagged variants and keeps full-batch counts', () => {
  const baselineRows = Array.from({ length: 502 }, (_, index) => {
    const id = 'sku-' + (index + 1);
    return [id, 'Catalog variant', 'Title', 'Default Title', id, '10.00', ''];
  });
  const baseline = parseBaseline(bytes([header, ...baselineRows]));
  const supplier = parseSupplier(bytes([['SKU', 'Price'], ...baselineRows.map(([id], index) => [id, index === 501 ? '0' : '11.00'])]), 'supplier.csv').sheets[0];
  const html = createSignoffHtml(baseline, buildPriceDiff(baseline, supplier, { confirmed: true }));
  expect(html).toContain('Showing 500 of 502 updated or flagged rows');
  expect(html).toContain('<dt>Updated variants</dt><dd>501</dd>');
  expect(html).toContain('<dt>Blocked / flagged</dt><dd>1</dd>');
  expect(html).toContain('<tbody><tr><td>sku-502</td>');
  expect(html.match(/<tr><td>/g)).toHaveLength(500);
  expect(html).not.toContain('<td>sku-501</td>');
});
