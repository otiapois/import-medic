import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeCsv, parseCsv } from '../../../src/core/csv';
import { suggestPlatforms } from '../../../src/core/worker/platform-suggestion';

describe('single-file platform suggestions', () => {
  it.each([
    ['shopify/modern-shopify-headers.csv', ['Shopify']],
    ['quickbooks/three-to-four-columns.csv', ['QuickBooks']],
    ['stripe-paypal/stripe-balance-itemized-utc.csv', ['Stripe']],
    ['stripe-paypal/paypal-memo-filter.csv', ['PayPal']],
    ['platform-suggestion/mixed-shopify-quickbooks.csv', ['Shopify', 'QuickBooks']],
  ])('reports all matching providers for %s', (fixture, expected) => {
    const bytes = readFileSync(`fixtures/${fixture}`);
    const [header] = parseCsv(decodeCsv(bytes).text).records;
    expect(suggestPlatforms(header.cells).map(({ provider }) => provider)).toEqual(expected);
  });

  it('requires a recognizable group of headers', () => {
    expect(suggestPlatforms(['Date', 'Name', 'SKU', 'Currency'])).toEqual([]);
  });
});
