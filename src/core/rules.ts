const RULE_SLUGS = {
  'encoding-repaired': 'shopify-csv-invalid-utf8',
  'invalid-encoding': 'shopify-csv-invalid-utf8',
  'line-ending-repaired': 'shopify-csv-invalid-utf8',
  'csv-parse-error': 'shopify-csv-invalid-utf8',
  'roundtrip-failed': 'shopify-csv-invalid-utf8',
  'missing-header': 'shopify-csv-missing-headers',
  'duplicate-header': 'shopify-csv-missing-headers',
  'ambiguous-header': 'quickbooks-3-column-vs-4-column',
  'header-normalized': 'shopify-csv-missing-headers',
  'row-width': 'shopify-csv-missing-headers',
  'blank-row': 'shopify-csv-missing-headers',
  'column-removed': 'quickbooks-3-column-vs-4-column',
  'manual-edit': 'shopify-csv-missing-headers',
  'missing-handle': 'shopify-csv-missing-headers',
  'missing-title': 'shopify-csv-missing-headers',
  'invalid-handle': 'shopify-csv-missing-headers',
  'handle-collision': 'shopify-csv-missing-headers',
  'noncontiguous-handle': 'shopify-csv-missing-headers',
  'handle-normalized': 'shopify-csv-missing-headers',
  'invalid-price': 'shopify-csv-variant-price-sku',
  'price-normalized': 'shopify-csv-variant-price-sku',
  'duplicate-sku': 'shopify-csv-variant-price-sku',
  'invalid-inventory-qty': 'shopify-csv-variant-price-sku',
  'inventory-qty-normalized': 'shopify-csv-variant-price-sku',
  'invalid-image-url': 'shopify-csv-missing-headers',
  'image-url-normalized': 'shopify-csv-missing-headers',
  'invalid-published': 'shopify-csv-missing-headers',
  'published-normalized': 'shopify-csv-missing-headers',
  'invalid-status': 'shopify-csv-missing-headers',
  'status-normalized': 'shopify-csv-missing-headers',
  'bank-preamble': 'quickbooks-3-column-vs-4-column',
  'bank-footer': 'quickbooks-3-column-vs-4-column',
  'layout-converted': 'quickbooks-3-column-vs-4-column',
  'credit-debit-direction': 'quickbooks-3-column-vs-4-column',
  'credit-debit-conflict': 'quickbooks-3-column-vs-4-column',
  'amount-normalized': 'quickbooks-csv-negative-parentheses',
  'invalid-amount': 'quickbooks-csv-negative-parentheses',
  'missing-amount': 'quickbooks-csv-negative-parentheses',
  'description-normalized': 'quickbooks-3-column-vs-4-column',
  'date-normalized': 'quickbooks-csv-date-format-error',
  'date-order-ambiguous': 'quickbooks-csv-date-format-error',
  'invalid-date': 'quickbooks-csv-date-format-error',
  'missing-date': 'quickbooks-csv-date-format-error',
  'invalid-currency': 'stripe-payout-csv-to-quickbooks',
  'currency-normalized': 'stripe-payout-csv-to-quickbooks',
  'multi-currency': 'stripe-payout-csv-to-quickbooks',
  'reconciliation-mismatch': 'stripe-payout-csv-to-quickbooks',
  'paypal-memo-removed': 'paypal-balance-impact-csv',
  'paypal-memo-in-export': 'paypal-balance-impact-csv',
  'invalid-balance-impact': 'paypal-balance-impact-csv',
  'balance-impact-conflict': 'paypal-balance-impact-csv',
  'balance-chain-break': 'quickbooks-3-column-vs-4-column',
  'balance-chain-unverifiable': 'quickbooks-3-column-vs-4-column',
  'freshbooks-mixed-sign': 'quickbooks-csv-negative-parentheses',
  'freshbooks-amount-scale': 'quickbooks-csv-negative-parentheses',
} as const;

export type RuleId = keyof typeof RULE_SLUGS;
export const RECOGNIZED_RULE_IDS: ReadonlySet<string> = new Set(Object.keys(RULE_SLUGS));
export const ruleDocSlug = (code: RuleId, platform: string): string => {
  const slug = RULE_SLUGS[code];
  const platformSlug = platform === 'stripe-paypal' && (slug.startsWith('quickbooks-') || slug.startsWith('shopify-'))
    ? 'stripe-payout-csv-to-quickbooks'
    : (platform === 'quickbooks-bank' || platform === 'xero-bank' || platform === 'freshbooks-expenses') &&
      (slug.startsWith('shopify-') || slug === 'stripe-payout-csv-to-quickbooks')
      ? 'quickbooks-3-column-vs-4-column'
      : slug;
  return `/fix/${platformSlug}`;
};
