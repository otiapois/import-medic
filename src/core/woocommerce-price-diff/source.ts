import type { Baseline, DiffIssue, Variant } from '../shopify-price-diff/types';
import { addLine, baselinePrice, duplicateIssues, readCsvTable, type CsvReadOptions } from '../shopify-price-diff/source';
import { cellValue, issue } from '../shopify-price-diff/types';
import { isScientific } from '../xlsx';
import { amountGreaterThan, readAmount } from '../shopify-price-diff/prices';
import { guardSpreadsheetCell } from '../formula-guard';

export const wooRegularHeader = 'Regular price';
export const wooSaleHeader = 'Sale price';
export const wooStockHeader = 'Stock';
export const wooIdentityHeaders = ['ID', 'Type', 'SKU', 'Parent'];
const expectedHeaders = [...wooIdentityHeaders, wooRegularHeader];
const recognizedHeaders = [...expectedHeaders, wooSaleHeader, wooStockHeader, 'Name'];
const headerKeys = new Map(recognizedHeaders.map(header => [header.toLowerCase(), header]));
export const canonicalWooHeader = (value: string) => headerKeys.get(value.trim().toLowerCase()) ?? value;
export function canonicalWooImportHeader(value: string): string {
  // Native mapping folds ASCII case after PHP trim and WordPress text cleanup.
  const normalized = value.replace(/^[ \t\r\n\v]+|[ \t\r\n\v]+$/g, '').replace(/[ \t\r\n]+/g, ' ');
  return /^[a-zA-Z ]+$/.test(normalized) ? headerKeys.get(normalized.toLowerCase()) ?? value : value;
}
const plainId = /^[1-9][0-9]{0,18}(?![\s\S])/;
const maxId = 9_223_372_036_854_775_807n;
const stockQty = /^(?:'?-)?[0-9]{1,64}(?![\s\S])/;
const maxStock = 9_007_199_254_740_991n;
const stableSku = (value: string) => value === value.trim() && !/[\x00-\x1f\x7f<>]| {2,}|%[0-9a-f]{2}/i.test(value) && !isScientific(value);
const baseType = (type: string) => type.split(',')[0];
export const wooWritable = (type: string) => baseType(type) === 'simple' || baseType(type) === 'variation';

export const wooOutputHeaders = (sale: boolean, stock: boolean) =>
  [...expectedHeaders, ...(sale ? [wooSaleHeader] : []), ...(stock ? [wooStockHeader] : [])];

/** A native WooCommerce Products export, preserving identity cells and exact SKU text. */
export function parseWooCommerceBaseline(bytes: Uint8Array, name = 'WooCommerce baseline.csv', options?: CsvReadOptions): Baseline {
  const source = readCsvTable(bytes, name, 'baseline', canonicalWooHeader, options);
  const columns = new Map(source.headers.map((header, index) => [canonicalWooHeader(header), index]));
  const variants: Variant[] = [];
  const baseline: Baseline = { ...source, platform: 'woocommerce', columns, variants };
  const { issues } = baseline;
  if (!source.headers.length) return baseline;
  const missing = expectedHeaders.filter(header => !columns.has(header));
  for (const column of missing) issues.push(issue('baseline', 'missing-column', 'This WooCommerce export requires the ' + column + ' column.', { row: source.headerRow, column }));
  if (missing.length) return baseline;

  const rowsById = new Map<string, Variant>();
  const rowsBySku = new Map<string, Variant>();
  const ids = new Map<string, number[]>();
  const skus = new Map<string, number[]>();
  for (const source of baseline.rows) {
    if (source.cells.length !== baseline.headers.length) continue;
    const cell = (header: string) => cellValue(source, columns.get(header)) ?? '';
    const id = cell('ID');
    const type = cell('Type');
    const sku = cell('SKU');
    const parent = cell('Parent');
    const price = cell(wooRegularHeader);
    const compareAtPrice = cellValue(source, columns.get(wooSaleHeader));
    const inventoryQty = cellValue(source, columns.get(wooStockHeader));
    const details = (column: string, value: string | null) => ({ row: source.line, column, value });
    const variant = { source, sku, options: [], handle: id, price, compareAtPrice, inventoryQty, linkedOption: false, woocommerce: { id, type, parent } };
    variants.push(variant);
    if (!plainId.test(id) || BigInt(id) > maxId) {
      issues.push(issue('baseline', 'invalid-woo-id', 'Use the original positive decimal WooCommerce product ID.', details('ID', id)));
    } else {
      addLine(ids, id, source.line);
      rowsById.set(id, variant);
    }
    if (sku !== '') {
      if (!stableSku(sku)) issues.push(issue('baseline', isScientific(sku) ? 'scientific-sku' : 'invalid-sku', 'Use the original text SKU that WooCommerce can preserve.', details('SKU', sku)));
      addLine(skus, sku.toLowerCase(), source.line);
      rowsBySku.set(sku, variant);
    }
    const flags = type.split(',').slice(1).map(flag => flag.trim());
    if (!/^[a-z][a-z0-9_-]*(?:, ?virtual|, ?downloadable)*(?![\s\S])/.test(type) || new Set(flags).size !== flags.length) {
      issues.push(issue('baseline', 'invalid-woo-type', 'Use the original WooCommerce product type.', details('Type', type)));
    }
    if (baseType(type) !== 'variation' && parent !== '') {
      issues.push(issue('baseline', 'unexpected-woo-parent', 'Only a variation may have a Parent in this workflow.', details('Parent', parent)));
    }
    if (wooWritable(type) && price !== '' && (price !== price.trim() || !baselinePrice.test(price))) {
      issues.push(issue('baseline', 'invalid-baseline-price', 'The original regular price must be a plain nonnegative decimal.', details(wooRegularHeader, price)));
    }
    if (wooWritable(type) && compareAtPrice && (compareAtPrice !== compareAtPrice.trim() || !baselinePrice.test(compareAtPrice))) {
      issues.push(issue('baseline', 'invalid-baseline-sale-price', 'The original sale price must be blank or a plain nonnegative decimal.', details(wooSaleHeader, compareAtPrice)));
    }
  }
  issues.push(...duplicateIssues('baseline', 'duplicate-sku', 'SKU', skus));
  for (const [value, rows] of ids) if (rows.length > 1) {
    issues.push(issue('baseline', 'duplicate-woo-id', 'This WooCommerce product ID occurs on multiple rows.', { row: rows[0], rows, column: 'ID', value }));
  }
  for (const variant of variants) {
    const { type, parent } = variant.woocommerce!;
    if (baseType(type) !== 'variation') continue;
    const target = parent.startsWith('id:') ? rowsById.get(parent.slice(3)) : rowsBySku.get(parent);
    if (!target || baseType(target.woocommerce!.type) !== 'variable') {
      issues.push(issue('baseline', 'invalid-woo-parent', 'Include the unique original variable parent. Parent must be its exact SKU or id:ID.', { row: variant.source.line, column: 'Parent', value: parent }));
    }
  }
  if (!variants.length) issues.push(issue('baseline', 'missing-woo-products', 'No WooCommerce product records were found.'));
  // All-blank ID creation files can be read for comparison, but still carry a blocking file issue.
  // Existing update and rollback paths require IDs from a fresh export of the destination store.
  if (variants.length && columns.has('Name') && issues.length === variants.length &&
    issues.every(problem => problem.code === 'invalid-woo-id' && problem.value === '')) {
    const linkedParents = new Set(variants.filter(variant => baseType(variant.woocommerce!.type) === 'variation')
      .map(variant => variant.woocommerce!.parent));
    const isCreation = variants.every(variant => {
      const { type } = variant.woocommerce!;
      const name = cellValue(variant.source, columns.get('Name')) ?? '';
      if (!name.trim() || guardSpreadsheetCell(name) !== name || guardSpreadsheetCell(variant.sku) !== variant.sku) return false;
      if (type === 'variable') return linkedParents.has(variant.sku) && !variant.price && !variant.compareAtPrice;
      if (!['simple', 'variation'].includes(baseType(type)) || !baselinePrice.test(variant.price)) return false;
      const sale = variant.compareAtPrice;
      return !sale || baselinePrice.test(sale) && amountGreaterThan(readAmount(variant.price)!, readAmount(sale)!);
    });
    if (isCreation) issues.splice(0, issues.length, issue('baseline', 'woo-needs-destination-ids',
      'This WooCommerce creation CSV has blank IDs. Products and prices can be previewed. Update and Rollback require a fresh WooCommerce store export containing assigned IDs.',
      { row: source.headerRow, column: 'ID' }));
  }
  return baseline;
}

export function readWooStock(value: string | null | undefined): bigint | null {
  if (value == null || !stockQty.test(value)) return null;
  const quantity = BigInt(value.startsWith("'") ? value.slice(1) : value);
  return quantity >= -maxStock && quantity <= maxStock ? quantity : null;
}
