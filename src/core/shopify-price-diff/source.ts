import { decodeCsv, parseCsv } from '../csv';
import { shopifyAliases } from '../profiles/shopify-products';
import { canonicalHeader } from '../table';
import { detectShopifyMarkets } from './markets';
import { baselinePrice } from './prices';
import { cellValue, issue } from './types';
import type { Baseline, DiffIssue, SourceRow, SourceTable, SupplierFile, Variant } from './types';
import { isScientific, readWorkbook } from './xlsx';

export const optionNames = ['Option1 Name', 'Option2 Name', 'Option3 Name'];
export const optionValues = ['Option1 Value', 'Option2 Value', 'Option3 Value'];
const optionLinks = ['Option1 Linked To', 'Option2 Linked To', 'Option3 Linked To'];
export const skuHeader = 'Variant SKU';
export const shopifyIdentityHeaders = ['Handle', 'Title', ...optionNames.flatMap((name, index) => [name, optionValues[index]]), skuHeader];
export const priceHeader = 'Variant Price';
export const compareAtHeader = 'Variant Compare At Price';
export const inventoryHeader = 'Variant Inventory Qty';
export { baselinePrice } from './prices';
export const originalQuantity = /^-?[0-9]{1,64}(?![\s\S])/;
const imageFields = new Set(['Handle', 'Image Src', 'Image Position', 'Image Alt Text']);

export const canonicalShopifyHeader = (header: string) => {
  const linked = /^option([1-3]) linked\s*to$/i.exec(header.trim());
  return linked ? optionLinks[Number(linked[1]) - 1] : canonicalHeader(header, shopifyAliases);
};

function readTable(name: string, source: SourceRow[], kind: 'baseline' | 'supplier', issues: DiffIssue[] = [], canonical?: (header: string) => string): SourceTable {
  const [head, ...rows] = source;
  const headers = Array.from(head?.cells ?? [], (cell) => cell?.value ?? '');
  const first = head?.line ?? null;
  if (!head) {
    if (!issues.length) issues.push(issue(kind, 'missing-header', 'This file or sheet has no header row.'));
    return { name, headerRow: first, headers, rows, issues };
  }
  const headerKeys = new Map<string, number[]>();
  headers.forEach((header, index) => {
    const key = (canonical?.(header) ?? header).trim().toLowerCase();
    if (!key || head.cells[index]?.kind !== 'text') {
      issues.push(issue(kind, 'invalid-header', 'Column ' + (index + 1) + ' requires a text header.', { row: first, value: header }));
    } else {
      const positions = headerKeys.get(key) ?? [];
      positions.push(index + 1);
      headerKeys.set(key, positions);
    }
  });
  for (const positions of headerKeys.values()) {
    if (positions.length < 2) continue;
    const header = headers[positions[0] - 1];
    issues.push(issue(kind, 'duplicate-header', 'Duplicate header in columns ' + positions.join(', ') + '.', { row: first, column: header, value: header }));
  }
  return { name, headerRow: first, headers, rows, issues };
}

export interface CsvReadOptions {
  retainEmptyRecords?: boolean;
  requireUtf8?: boolean;
}

export function readCsvTable(bytes: Uint8Array, name: string, kind: 'baseline' | 'supplier', canonical?: (header: string) => string,
  options?: CsvReadOptions): SourceTable {
  const decoded = decodeCsv(bytes);
  if (decoded.encoding === 'unknown') return readTable(name, [], kind, [issue(kind, 'invalid-encoding', 'The file encoding could not be decoded.')]);
  if (options?.requireUtf8 && decoded.encoding !== 'utf-8' && decoded.encoding !== 'utf-8-bom') {
    return readTable(name, [], kind, [issue(kind, 'invalid-encoding', 'Save the native import CSV as UTF-8.')]);
  }
  const { records } = parseCsv(decoded.text);
  const issues: DiffIssue[] = [];
  const rows = records.flatMap((record) => {
    if (record.parseError) issues.push(issue(kind, 'invalid-csv', record.parseError, { row: record.line, value: record.raw }));
    else if (record.cells.every((cell) => cell === '') && (!options?.retainEmptyRecords || record.raw === '')) return [];
    return [{ line: record.line, cells: record.cells.map((value) => ({ value, kind: 'text' as const })) }];
  });
  const table = readTable(name, rows, kind, issues, canonical);
  for (const row of table.rows) {
    if (row.cells.length !== table.headers.length) {
      issues.push(issue(kind, 'row-width', 'This record has ' + row.cells.length + ' cells and the header has ' + table.headers.length + '.', { row: row.line }));
    }
  }
  return table;
}

export function parseSupplier(bytes: Uint8Array, name: string): SupplierFile {
  if (/\.csv$/i.test(name)) return { name, sheets: [readCsvTable(bytes, name, 'supplier')], issues: [] };
  if (!/\.xlsx$/i.test(name)) {
    return { name, sheets: [], issues: [issue('supplier', 'unsupported-file', 'Choose a supplier CSV or XLSX file.')] };
  }
  try {
    const sheets = readWorkbook(bytes).map(({ name: sheet, rows }) => {
      const table = readTable(sheet, rows, 'supplier');
      for (const row of table.rows) {
        if (row.cells.slice(table.headers.length).some((cell) => cell.kind === 'formula' || cell.value !== null && cell.value !== '')) {
          table.issues.push(issue('supplier', 'row-width', 'This worksheet row includes data outside the header columns.', { row: row.line }));
        }
      }
      return table;
    });
    return { name, sheets, issues: [] };
  } catch (error) {
    const external = error instanceof Error && error.message === 'external-xlsx-relationship';
    return {
      name, sheets: [],
      issues: [external ?
        issue('supplier', 'external-xlsx-relationship', 'This workbook contains an external OOXML relationship. Save a local values-only copy.') :
        issue('supplier', 'invalid-xlsx', 'This XLSX archive is malformed, unsafe, unsupported, or exceeds the workbook limits.')],
    };
  }
}

export function variantKey(handle: string, options: readonly string[]): string {
  return JSON.stringify([handle, ...optionValues.map((_, index) => options[index] ?? '')]);
}

export function duplicateIssues(source: 'baseline' | 'supplier', code: 'duplicate-sku' | 'duplicate-variant-key', column: string, records: ReadonlyMap<string, number[]>): DiffIssue[] {
  return [...records].flatMap(([value, rows]) => rows.length < 2 ? [] : [issue(source, code,
    (code === 'duplicate-sku' ? 'This SKU' : 'This handle and option combination') + ' occurs on rows ' + rows.join(', ') + '.',
    { row: rows[0], rows, column, value })]);
}

export function addLine(lines: Map<string, number[]>, key: string, row: number): void {
  const previous = lines.get(key) ?? [];
  previous.push(row);
  lines.set(key, previous);
}

export function parseBaseline(bytes: Uint8Array, name = 'Shopify baseline.csv', options?: CsvReadOptions): Baseline {
  const source = readCsvTable(bytes, name, 'baseline', canonicalShopifyHeader, options);
  const columns = new Map(source.headers.map((header, index) => [canonicalShopifyHeader(header), index]));
  const issues = source.issues;
  const variants: Variant[] = [];
  const markets = detectShopifyMarkets(source.headers);
  const result: Baseline = { ...source, columns, variants, ...(markets.length ? { markets } : {}) };
  if (!source.headers.length) return result;
  const required = ['Handle', 'Title', optionNames[0], optionValues[0], skuHeader, priceHeader];
  for (const column of required) {
    if (!columns.has(column)) issues.push(issue('baseline', 'missing-column', 'This Shopify export requires the ' + column + ' column.', { row: source.headerRow, column }));
  }
  for (const index of [1, 2]) {
    if (columns.has(optionNames[index]) !== columns.has(optionValues[index])) {
      issues.push(issue('baseline', 'missing-option-column', 'Keep both the name and value headers for each option dimension.', { row: source.headerRow, column: optionValues[index] }));
    }
  }
  if (required.some((column) => !columns.has(column))) return result;

  const headerByIndex = source.headers.map(canonicalShopifyHeader);
  const groups = new Map<string, Variant[]>();
  const handleLines = new Map<string, number[]>();
  const brokenHandles = new Set<string>();
  const skuRows = new Map<string, number[]>();
  const variantRows = new Map<string, number[]>();
  const cell = (row: SourceRow, header: string) => cellValue(row, columns.get(header)) ?? '';
  let previousHandle: string | null = null;
  for (const row of source.rows) {
    if (row.cells.length !== source.headers.length) continue;
    const handle = cell(row, 'Handle');
    const title = cell(row, 'Title');
    const options = optionValues.map((header) => cell(row, header));
    const sku = cell(row, skuHeader);
    const price = cell(row, priceHeader);
    const compareAtPrice = cellValue(row, columns.get(compareAtHeader));
    const linkedOption = optionLinks.some((header) => cell(row, header) !== '');
    if (!/^[\p{L}\p{N}-]+$/u.test(handle) || !/[\p{L}\p{N}]/u.test(handle)) {
      issues.push(issue('baseline', 'invalid-handle', 'Use the exact valid handle from the Shopify export on every product record.', { row: row.line, column: 'Handle', value: handle }));
    }
    if (handle !== previousHandle && handleLines.has(handle)) brokenHandles.add(handle);
    addLine(handleLines, handle, row.line);
    previousHandle = handle;

    const imageOnly = cell(row, 'Image Src') !== '' && row.cells.every(({ value }, index) => value === '' || imageFields.has(headerByIndex[index]));
    if (imageOnly) continue;

    const inventoryQty = cellValue(row, columns.get(inventoryHeader));
    const variant = { source: row, handle, options, sku, price, compareAtPrice, inventoryQty, linkedOption };
    variants.push(variant);
    const group = groups.get(handle) ?? [];
    group.push(variant);
    groups.set(handle, group);
    if (sku !== '') {
      addLine(skuRows, sku, row.line);
      if (isScientific(sku)) issues.push(issue('baseline', 'scientific-sku', 'Use the original text SKU before continuing.', { row: row.line, column: skuHeader, value: sku }));
      else if (sku.trim() === '') issues.push(issue('baseline', 'invalid-sku', 'A SKU cannot consist solely of whitespace.', { row: row.line, column: skuHeader, value: sku }));
    }
    addLine(variantRows, variantKey(handle, options), row.line);
    if (!baselinePrice.test(price)) issues.push(issue('baseline', 'invalid-baseline-price', 'This exported variant needs a nonnegative plain decimal price.', { row: row.line, column: priceHeader, value: price }));
    if (compareAtPrice !== null && compareAtPrice !== '' && !baselinePrice.test(compareAtPrice)) {
      issues.push(issue('baseline', 'invalid-baseline-compare-at-price', 'This exported compare-at value must be blank or a nonnegative plain decimal.', { row: row.line, column: compareAtHeader, value: compareAtPrice }));
    }
    if (group.length > 1 && title !== '' && title !== cell(group[0].source, 'Title')) {
      issues.push(issue('baseline', 'conflicting-title', 'Product title conflicts with the title on its first variant.', { row: row.line, rows: [group[0].source.line, row.line], column: 'Title', value: title }));
    }
  }
  issues.push(...duplicateIssues('baseline', 'duplicate-sku', skuHeader, skuRows),
    ...duplicateIssues('baseline', 'duplicate-variant-key', 'Handle + option values', variantRows));

  for (const [handle, rows] of handleLines) {
    const group = groups.get(handle);
    if (brokenHandles.has(handle)) issues.push(issue('baseline', 'noncontiguous-handle', 'Keep all variant and image rows for this handle together.', { row: rows[0], rows, column: 'Handle', value: handle }));
    if (!group || group[0].source.line !== rows[0]) {
      issues.push(issue('baseline', 'missing-primary-variant', 'The first row of each product must contain its title and first variant.', { row: rows[0], rows, column: 'Handle', value: handle }));
      if (!group) continue;
    }
    const first = group[0].source;
    if (cell(first, 'Title').trim() === '') {
      issues.push(issue('baseline', 'missing-title', 'The first variant of this product needs the original Shopify title.', { row: first.line, column: 'Title', value: cell(first, 'Title') }));
    }
    const names = optionNames.map((header) => cell(first, header));
    const dimensions = group.reduce((count, { source: row, options }) => optionNames.reduce((highest, header, index) =>
      options[index] !== '' || cell(row, header) !== '' ? Math.max(highest, index + 1) : highest, count), 1);
    for (const { source: row, options } of group) {
      for (let index = 0; index < dimensions; index++) {
        const name = cell(row, optionNames[index]);
        if (!names[index].trim() || !options[index].trim() || (name !== '' && name !== names[index])) {
          issues.push(issue('baseline', 'invalid-variant-options', 'Every variant needs the product’s option values and the first variant must name each option dimension.', {
            row: row.line, rows: row.line === first.line ? [row.line] : [first.line, row.line], column: optionValues[index], value: options[index],
          }));
        }
      }
    }
  }
  if (!variants.length) issues.push(issue('baseline', 'missing-variants', 'No Shopify variant records were found.'));
  return result;
}
