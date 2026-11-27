import { amountGreaterThan, readAmount } from '../shopify-price-diff/prices';
import { issue } from '../shopify-price-diff/types';
import type { Baseline, DiffIssue, DiffRow } from '../shopify-price-diff/types';
import { readWooStock, wooRegularHeader, wooSaleHeader, wooStockHeader, wooWritable } from './source';

export function checkWooUpdate(baseline: Baseline, row: DiffRow, stock: boolean): DiffIssue[] {
  const { woocommerce, sku, baselineRow, oldPrice, oldCompareAtPrice, newPrice } = row;
  const issues: DiffIssue[] = [];
  if (!woocommerce || !wooWritable(woocommerce.type) || sku === null || sku === '') {
    return [issue('baseline', 'unsupported-woo-update-type', 'Native updates require a simple product or variation with an exact SKU.', { row: baselineRow, column: 'Type', value: woocommerce?.type ?? null })];
  }
  const original = oldPrice ? readAmount(oldPrice) : null;
  const next = newPrice ? readAmount(newPrice) : null;
  // A blank WooCommerce Stock cell switches off inventory tracking. A variation
  // with inherited stock must keep that relationship untouched in both files.
  if (stock && (readWooStock(row.oldInventoryQty) === null || readWooStock(row.newInventoryQty) === null)) {
    issues.push(issue('baseline', 'woo-stock-not-managed', 'The update and rollback need an original numeric Stock value. Omit Stock to keep unmanaged or inherited stock untouched.',
      { row: baselineRow, column: wooStockHeader, value: row.oldInventoryQty ?? null }));
  }
  if (!original || !next) {
    issues.push(issue('baseline', 'woo-regular-price-required', 'A writable row needs the original and proposed regular prices for a verified rollback.',
      { row: baselineRow, column: wooRegularHeader, value: oldPrice }));
    return issues;
  }
  if (!baseline.columns.has(wooSaleHeader) && amountGreaterThan(original, next)) {
    issues.push(issue('baseline', 'woo-sale-price-required', 'Re-export with Sale price before reducing the regular price so WooCommerce cannot clear an unseen sale price.',
      { row: baselineRow, column: wooSaleHeader }));
    return issues;
  }
  const oldSale = oldCompareAtPrice ? readAmount(oldCompareAtPrice) : null;
  if (oldSale && !amountGreaterThan(original, oldSale)) {
    issues.push(issue('baseline', 'invalid-baseline-sale-price', 'The original Sale price must be below the original Regular price for the rollback to restore it.',
      { row: baselineRow, column: wooSaleHeader, value: oldCompareAtPrice }));
  }
  return issues;
}
