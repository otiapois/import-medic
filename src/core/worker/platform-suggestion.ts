import { quickBooksAliases } from '../profiles/quickbooks-bank';
import { shopifyAliases } from '../profiles/shopify-products';
import { stripeHeaderSignals, stripePayPalAliases } from '../profiles/stripe-paypal';
import type { HeaderAliases } from '../table';
import type { PlatformSuggestion } from './protocol';

export function suggestPlatforms(headers: readonly string[]): PlatformSuggestion[] {
  const raw = headers.map((header) => header.trim().toLowerCase());
  const canonical = (aliases: HeaderAliases) => new Set(raw.map((header) => aliases.get(header)));
  const shopify = canonical(shopifyAliases);
  const bank = canonical(quickBooksAliases);
  const payments = canonical(stripePayPalAliases);
  const suggestions: PlatformSuggestion[] = [];

  if (shopify.has('Handle') && ['Title', 'Variant SKU', 'Variant Price'].some((header) => shopify.has(header))) {
    suggestions.push({ platform: 'shopify-products', provider: 'Shopify' });
  }
  if (bank.has('Date') && bank.has('Description') && (
    bank.has('Amount') || (bank.has('Credit') && bank.has('Debit')) || (bank.has('Money In') && bank.has('Money Out'))
  )) {
    suggestions.push({ platform: 'quickbooks-bank', provider: 'QuickBooks' });
  }
  const paypal = payments.has('Balance Impact') || (raw.includes('transaction id') && raw.includes('time'));
  const stripe = raw.some((header) => stripeHeaderSignals.has(header));
  if (payments.has('Date') && payments.has('Currency') && (
    payments.has('Net') || ((paypal || stripe) && payments.has('Gross'))
  )) {
    const provider = paypal === stripe ? 'Stripe / PayPal' : paypal ? 'PayPal' : 'Stripe';
    suggestions.push({ platform: 'stripe-paypal', provider });
  }
  return suggestions;
}
