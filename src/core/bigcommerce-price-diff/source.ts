import { addLine, duplicateIssues, readCsvTable, type CsvReadOptions } from '../shopify-price-diff/source';
import { cellValue, issue, type Baseline, type Variant } from '../shopify-price-diff/types';
import { isScientific } from '../shopify-price-diff/xlsx';

export const bigTypeHeader = 'Item Type';
export const bigIdHeader = 'Product ID';
export const bigNameHeader = 'Product Name';
export const bigSkuHeader = 'Product Code/SKU';
export const bigPriceHeader = 'Price';
export const bigSaleHeader = 'Sale Price';
export const bigTrackingHeader = 'Track Inventory';
const legacySkuAlias = 'Product SKU';
const stockHeaders = ['Stock Level', 'Current Stock Level'];
export const bigCommerceSkuHeader = (baseline: Baseline) => baseline.columns.has(legacySkuAlias) && !baseline.columns.has(bigSkuHeader) ? legacySkuAlias : bigSkuHeader;
export const bigCommerceIdentityHeaders = (baseline: Baseline) => [bigTypeHeader, bigIdHeader, bigNameHeader, bigCommerceSkuHeader(baseline)];
export const bigCommerceStockHeader = (baseline: Baseline) => stockHeaders.find(header => baseline.columns.has(header));
export const bigCommerceKey = (type: string, id: string) => type + ':' + id;
export const bigCommerceFileLimit = 20_000_000;

const plainId = /^[0-9]{1,19}(?![\s\S])/;
const stableText = (value: string) => value !== '' && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const optionPattern = /^\[(RB|S|RT|CS)\]([^=,\[\]]+)=([^=,\[\]]+)(?![\s\S])/;
const swatchPattern = /:(?:#[a-f0-9]{6}(?:\|#[a-f0-9]{6}){0,2}|https?:\/\/[^\s]+)$/i;

function variantOptions(name: string) {
  const options = new Map<string, { type: string; name: string; value: string }>();
  for (const option of name.split(',')) {
    const fields = optionPattern.exec(option);
    if (!fields) return null;
    const [, type, label, value] = fields;
    const key = label.toLowerCase();
    if (!stableText(label) || !stableText(value) || options.has(key) || type === 'CS' && !swatchPattern.test(value)) return null;
    options.set(key, { type, name: label, value });
  }
  return [...options].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, value]) => value);
}

/** Legacy Bulk Edit catalog. Rule rows provide context and never enter the transfer. */
export function parseBigCommerceBaseline(bytes: Uint8Array, name = 'BigCommerce baseline.csv', options?: CsvReadOptions): Baseline {
  const source = readCsvTable(bytes, name, 'baseline', undefined, options);
  const columns = new Map(source.headers.map((header, index) => [header, index]));
  const variants: Variant[] = [];
  const grouped = new Set<string>();
  const baseline: Baseline = { ...source, platform: 'bigcommerce', columns, variants, bigcommerceGroupedProducts: grouped };
  const { issues } = baseline;
  if (!source.headers.length) return baseline;
  const skuHeader = bigCommerceSkuHeader(baseline);
  const missing = [...bigCommerceIdentityHeaders(baseline), bigPriceHeader].filter(header => !columns.has(header));
  for (const column of missing) issues.push(issue('baseline', 'missing-column', 'This legacy BigCommerce export requires the ' + column + ' column.', { row: source.headerRow, column }));
  if (missing.length) return baseline;
  if (stockHeaders.every(header => columns.has(header))) {
    issues.push(issue('baseline', 'duplicate-bigcommerce-stock', 'Keep a single original legacy stock column.', { row: source.headerRow, column: stockHeaders[0] }));
  }
  if (columns.has(bigSkuHeader) && columns.has(legacySkuAlias)) {
    issues.push(issue('baseline', 'duplicate-bigcommerce-sku-column', 'Keep a single original legacy SKU column.', { row: source.headerRow, column: bigSkuHeader }));
  }

  const stockHeader = bigCommerceStockHeader(baseline);
  const ids = new Map<string, number[]>();
  const skus = new Map<string, number[]>();
  let productId: string | undefined;
  let groupOptions: string | undefined;
  let combinations = new Set<string>();
  let sawRule = false;
  for (const row of baseline.rows) {
    if (row.cells.length !== source.headers.length) continue;
    const cell = (header: string) => cellValue(row, columns.get(header)) ?? '';
    const type = cell(bigTypeHeader);
    const id = cell(bigIdHeader);
    const name = cell(bigNameHeader);
    const sku = cell(skuHeader);
    const details = (column: string, value: string) => ({ row: row.line, column, value });
    if (type === 'Rule' && productId !== undefined && plainId.test(id) && BigInt(id) > 0n) {
      grouped.add(productId);
      sawRule = true;
      continue;
    }
    if (type !== 'Product' && type !== 'SKU') {
      issues.push(issue('baseline', 'invalid-bigcommerce-type', 'Use an original legacy Product, SKU or existing Rule row.', details(bigTypeHeader, type)));
      continue;
    }
    if (!plainId.test(id) || BigInt(id) === 0n) {
      issues.push(issue('baseline', 'invalid-bigcommerce-id', 'Keep the existing positive decimal BigCommerce row ID.', details(bigIdHeader, id)));
    } else {
      addLine(ids, bigCommerceKey(type, BigInt(id).toString()), row.line);
    }
    if (type === 'Product') {
      productId = id;
      groupOptions = undefined;
      combinations = new Set();
      sawRule = false;
      if (cell('Option Set') || cell(bigTrackingHeader).toLowerCase() === 'by option') grouped.add(id);
      if (!stableText(name)) issues.push(issue('baseline', 'invalid-bigcommerce-name', 'Keep the original BigCommerce product name.', details(bigNameHeader, name)));
    } else {
      if (productId === undefined || sawRule) {
        issues.push(issue('baseline', 'invalid-bigcommerce-group', 'Keep existing SKU rows directly below their original Product row, before any Rule rows.', details(bigIdHeader, id)));
      }
      if (productId !== undefined) grouped.add(productId);
      const options = variantOptions(name);
      const shape = options && JSON.stringify(options.map(({ type, name }) => [type, name]));
      const values = options && JSON.stringify(options.map(({ value }) => value.toLowerCase()));
      if (!shape || !values || (groupOptions !== undefined && shape !== groupOptions) || combinations.has(values)) {
        issues.push(issue('baseline', 'invalid-bigcommerce-option-name', 'Keep the original distinct native SKU option expressions and consistent option names.', details(bigNameHeader, name)));
      } else {
        groupOptions = shape;
        combinations.add(values);
      }
    }
    if (type === 'SKU' || sku !== '') {
      if (!stableText(sku) || sku.length > 255 || isScientific(sku)) {
        issues.push(issue('baseline', isScientific(sku) ? 'scientific-sku' : 'invalid-sku', 'Keep the original BigCommerce SKU as text.', details(skuHeader, sku)));
      }
      if (sku) addLine(skus, sku.toLowerCase(), row.line);
    }
    variants.push({
      source: row, handle: id, options: [], sku, price: cell(bigPriceHeader), compareAtPrice: cellValue(row, columns.get(bigSaleHeader)),
      inventoryQty: stockHeader ? cell(stockHeader) : null, linkedOption: false,
      bigcommerce: { id, name, type, productId: productId ?? id },
    });
  }
  issues.push(...duplicateIssues('baseline', 'duplicate-sku', skuHeader, skus));
  for (const rows of ids.values()) if (rows.length > 1) {
    issues.push(issue('baseline', 'duplicate-bigcommerce-id', 'This BigCommerce row ID occurs more than once for its item type.', { row: rows[0], rows, column: bigIdHeader }));
  }
  if (!variants.length) issues.push(issue('baseline', 'missing-bigcommerce-products', 'No legacy BigCommerce product records were found.'));
  return baseline;
}
