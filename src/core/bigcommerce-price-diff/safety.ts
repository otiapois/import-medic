import { amountGreaterThan, readAmount } from '../shopify-price-diff/prices';
import { baselinePrice } from '../shopify-price-diff/source';
import { cellValue, issue, type Baseline, type DiffIssue, type DiffRow, type Variant } from '../shopify-price-diff/types';
import { bigCommerceSkuHeader, bigCommerceStockHeader, bigPriceHeader, bigSaleHeader, bigTrackingHeader } from './source';

export function bigCommerceProductTracking(baseline: Baseline): ReadonlyMap<string, string> {
  return new Map(baseline.variants.flatMap(({ source, bigcommerce }) => bigcommerce?.type === 'Product'
    ? [[bigcommerce.id, (cellValue(source, baseline.columns.get(bigTrackingHeader)) ?? '').toLowerCase()]] : []));
}

export function readBigCommerceStock(value: string | null | undefined): bigint | null {
  if (!value || !/^[0-9]{1,16}(?![\s\S])/.test(value)) return null;
  const quantity = BigInt(value);
  return quantity <= 2_147_483_647n ? quantity : null;
}

export function bigCommerceWrites(row: Pick<DiffRow, 'newPrice' | 'oldPrice' | 'newCompareAtPrice' | 'oldCompareAtPrice' | 'newInventoryQty' | 'oldInventoryQty'>,
  stockHeader: string | undefined): Map<string, string> {
  const writes = new Map<string, string>();
  if (row.newPrice !== null && row.newPrice !== row.oldPrice) writes.set(bigPriceHeader, row.newPrice);
  if (row.newCompareAtPrice !== null && row.newCompareAtPrice !== row.oldCompareAtPrice) writes.set(bigSaleHeader, row.newCompareAtPrice);
  if (stockHeader && row.newInventoryQty != null && row.newInventoryQty !== row.oldInventoryQty) writes.set(stockHeader, row.newInventoryQty);
  return writes;
}

export function bigCommerceValueIssues(baseline: Baseline, variant: Variant, writes: ReadonlyMap<string, string>,
  tracking: ReadonlyMap<string, string>): DiffIssue[] {
  const { type, productId } = variant.bigcommerce!;
  const details = (column: string, value: string | null) => ({ row: variant.source.line, column, value });
  const issues: DiffIssue[] = [];
  if (!variant.sku && writes.size) {
    issues.push(issue('baseline', 'missing-bigcommerce-sku', 'A changed row requires an existing exact BigCommerce SKU.', details(bigCommerceSkuHeader(baseline), variant.sku)));
  }
  const priceWrite = writes.get(bigPriceHeader);
  const saleWrite = writes.get(bigSaleHeader);
  if (priceWrite !== undefined || saleWrite !== undefined) {
    const column = priceWrite !== undefined ? bigPriceHeader : bigSaleHeader;
    if (type === 'SKU') {
      issues.push(issue('baseline', 'bigcommerce-read-only-price', 'Legacy SKU rows cannot write Price or Sale Price.', details(column, priceWrite ?? saleWrite ?? null)));
    } else if (baseline.bigcommerceGroupedProducts?.has(productId)) {
      issues.push(issue('baseline', 'bigcommerce-grouped-price', 'A price edit on this grouped product could alter inherited variant pricing.', details(column, priceWrite ?? saleWrite ?? null)));
    } else {
      const read = (value: string | null) => value && baselinePrice.test(value) ? readAmount(value) : null;
      const oldPrice = read(variant.price);
      const nextPrice = read(priceWrite ?? variant.price);
      const oldSale = read(variant.compareAtPrice);
      const nextSale = read(saleWrite ?? variant.compareAtPrice);
      if (!oldPrice || !nextPrice || saleWrite !== undefined && (!oldSale || !nextSale)) {
        issues.push(issue('baseline', 'bigcommerce-unrestorable-value', 'Both files need plain numeric prices. The legacy importer ignores blank cells.',
          details(column, priceWrite !== undefined ? variant.price : variant.compareAtPrice)));
      } else if (priceWrite !== undefined && !baseline.columns.has(bigSaleHeader) && amountGreaterThan(oldPrice, nextPrice)) {
        issues.push(issue('baseline', 'bigcommerce-sale-price-required', 'Re-export with Sale Price before reducing Price to verify the existing sale price.',
          details(bigSaleHeader, variant.compareAtPrice)));
      } else if (variant.compareAtPrice && !oldSale || oldSale && !amountGreaterThan(oldPrice, oldSale) || nextSale && !amountGreaterThan(nextPrice, nextSale)) {
        issues.push(issue('baseline', 'bigcommerce-sale-not-below-price', 'Original and effective sale prices must be below the corresponding regular price.',
          details(bigSaleHeader, saleWrite ?? variant.compareAtPrice)));
      }
    }
  }
  const stockHeader = bigCommerceStockHeader(baseline);
  const stockWrite = stockHeader === undefined ? undefined : writes.get(stockHeader);
  if (stockHeader !== undefined && stockWrite !== undefined) {
    const mode = type === 'Product' ? 'by product' : 'by option';
    if (tracking.get(productId) !== mode) {
      issues.push(issue('baseline', 'bigcommerce-stock-tracking', 'The original product must track inventory at the matching row level.',
        details(bigTrackingHeader, tracking.get(productId) ?? null)));
    }
    if (readBigCommerceStock(variant.inventoryQty) === null || readBigCommerceStock(stockWrite) === null) {
      issues.push(issue('baseline', 'bigcommerce-unrestorable-value', 'Changing stock requires an original and proposed nonnegative whole quantity within the supported range.',
        details(stockHeader, variant.inventoryQty)));
    }
  }
  return issues;
}
