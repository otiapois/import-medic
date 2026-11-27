import { amountGreaterThan, baselinePrice, readAmount } from './prices';
import { cellValue, issue, type Baseline, type DiffIssue } from './types';

export interface ShopifyMarket {
  name: string;
  priceHeader: string;
  compareAtHeader?: string;
}

const marketPricePrefix = 'Price / ';
const compareAtPrefix = 'Compare At Price / ';

export function detectShopifyMarkets(headers: readonly string[]): ShopifyMarket[] {
  const exported = new Set(headers);
  return headers.flatMap((priceHeader) => {
    if (!priceHeader.startsWith(marketPricePrefix)) return [];
    const name = priceHeader.slice(marketPricePrefix.length);
    if (!name || name !== name.trim() || /[\x00-\x1f\x7f]/.test(name)) return [];
    const compareAtHeader = compareAtPrefix + name;
    return [{ name, priceHeader, ...(exported.has(compareAtHeader) ? { compareAtHeader } : {}) }];
  });
}

export function scopeShopifyMarket(baseline: Baseline, name: string | undefined): Baseline {
  if (name === undefined) return baseline;
  const market = baseline.markets?.find((entry) => entry.name === name);
  if (!market) return { ...baseline, issues: [...baseline.issues,
    issue('mapping', 'unknown-shopify-market', 'Choose the base store or an exact market name from this Shopify export.', { value: name })] };
  const price = baseline.columns.get(market.priceHeader);
  const compareAt = market.compareAtHeader === undefined ? undefined : baseline.columns.get(market.compareAtHeader);
  return { ...baseline, market, variants: baseline.variants.map(variant => ({
    ...variant,
    price: cellValue(variant.source, price) ?? '',
    compareAtPrice: cellValue(variant.source, compareAt),
  })) };
}

export function marketValueIssues(market: ShopifyMarket, originalPrice: string | null, originalCompareAt: string | null,
  nextPrice: string | null, nextCompareAt: string | null, line: number): DiffIssue[] {
  const details = (column: string, value: string | null) => ({ row: line, column, value });
  const plainAmount = (raw: string | null) => raw && baselinePrice.test(raw) ? readAmount(raw) : null;
  const original = plainAmount(originalPrice);
  const retail = plainAmount(nextPrice);
  const oldCompare = plainAmount(originalCompareAt);
  const compare = plainAmount(nextCompareAt);
  const issues: DiffIssue[] = [];
  if (originalPrice && !original || nextPrice && !retail) {
    issues.push(issue('baseline', 'invalid-market-price', 'Keep a plain nonnegative decimal or the existing inherited price.', details(market.priceHeader, originalPrice)));
  } else if (originalPrice !== nextPrice && (!original || !retail)) {
    issues.push(issue('baseline', 'market-inherited-price', 'Changing between inherited and fixed pricing has no verified CSV rollback in this workflow.', details(market.priceHeader, originalPrice)));
  }
  const saleColumn = market.compareAtHeader ?? compareAtPrefix + market.name;
  if (originalCompareAt && !oldCompare || nextCompareAt && !compare) {
    issues.push(issue('baseline', 'invalid-market-compare-at', 'Keep a plain nonnegative decimal or the existing inherited compare-at value.',
      details(saleColumn, originalCompareAt)));
  } else if (originalCompareAt !== nextCompareAt && (!oldCompare || !compare)) {
    issues.push(issue('baseline', 'market-inherited-compare-at', 'Changing between inherited and fixed compare-at pricing has no verified CSV rollback in this workflow.',
      details(saleColumn, originalCompareAt)));
  } else if ((oldCompare && (!original || !amountGreaterThan(oldCompare, original))) ||
    (compare && (!retail || !amountGreaterThan(compare, retail)))) {
    issues.push(issue('baseline', 'compare-at-not-above-price', 'Original and effective fixed compare-at prices must exceed their fixed market prices.',
      details(saleColumn, nextCompareAt)));
  }
  return issues;
}
