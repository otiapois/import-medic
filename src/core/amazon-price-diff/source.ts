import { decodeCsv, parseCsv, type CsvDelimiter, type CsvRecord } from '../csv';
import { guardSpreadsheetCell } from '../formula-guard';
import { baselinePrice, readAmount } from '../shopify-price-diff/prices';
import { originalQuantity } from '../shopify-price-diff/source';
import type { ImportInspectionIssue } from '../verify-import/inspector';
import { isScientific } from '../xlsx';

export const amazonFields = ['price', 'quantity'] as const;
export type AmazonField = typeof amazonFields[number];
export type AmazonSource = ImportInspectionIssue['source'];
export const amazonFileExtension = /\.(?:csv|tsv|txt)$/i;
export const minPrice = 'minimum-seller-allowed-price';
export const maxPrice = 'maximum-seller-allowed-price';
export const skuHeader = 'sku';
const scopedHeaders = new Set<string>([skuHeader, ...amazonFields]);
const requiredHeaders = [...scopedHeaders];
const nativeHeaders = new Set([...requiredHeaders, minPrice, maxPrice, 'fulfillment-channel', 'handling-time']);

export interface AmazonRow extends CsvRecord { sku: string }
export interface AmazonTable {
  headers: string[];
  headerLine: number;
  positions: Map<string, number>;
  rows: Map<string, AmazonRow>;
  delimiter: CsvDelimiter | null;
  issues: ImportInspectionIssue[];
}

export function readAmazonValue(field: AmazonField, raw: string): bigint | null {
  if (field === 'quantity') return originalQuantity.test(raw) && !raw.startsWith('-') ? BigInt(raw) : null;
  if (!baselinePrice.test(raw) || /\.\d{3}/.test(raw)) return null;
  const value = readAmount(raw);
  if (!value || value.units <= 0n) return null;
  return value.units * 10n ** BigInt(2 - value.scale);
}

export function amazonCell(table: AmazonTable, row: AmazonRow, field: string): string {
  const position = table.positions.get(field);
  return position === undefined ? '' : row.cells[position];
}

export function amazonFulfilled(table: AmazonTable, row: AmazonRow): boolean {
  const marker = amazonCell(table, row, 'fulfillment-channel').trim().toUpperCase();
  return /^(?:AMAZON(?:[\s_/-]+[A-Z0-9]+)*|AFN|FBA|FULFILL(?:ED|MENT)[\s_/-]+BY[\s_/-]+AMAZON)$/u.test(marker);
}

export function readAmazonTable(bytes: Uint8Array, source: AmazonSource): AmazonTable {
  const { text, encoding } = decodeCsv(bytes);
  const table: AmazonTable = { headers: [], headerLine: 1, positions: new Map(), rows: new Map(), delimiter: null, issues: [] };
  const { issues, positions, rows } = table;
  const report = (code: string, message: string, line: number, column?: string) => {
    issues.push({ source, code, message, line, ...(column === undefined ? {} : { column }) });
  };
  if (encoding === 'unknown') {
    report('amazon-invalid-encoding', 'The file encoding could not be decoded as supported delimited text.', 1);
    return table;
  }

  // Amazon field names occupy one physical header line. Use Papa to probe the
  // two supported delimiters before measuring physical lines in the whole file.
  const first = /^[\r\n]*([^\r\n]+)/.exec(text)?.[1] ?? '';
  const validDialects = ([',', '\t'] as const).filter(delimiter => {
    const headers = parseCsv(first, delimiter).records[0]?.cells ?? [];
    return headers.includes(skuHeader) && headers.some(header => amazonFields.some(field => field === header));
  });
  if (validDialects.length !== 1) {
    const line = (text.slice(0, text.indexOf(first)).match(/\r\n|\r|\n/g)?.length ?? 0) + 1;
    report('amazon-invalid-headers', 'Use comma- or tab-delimited text with the exact sku header and at least one of price or quantity.', line);
    return table;
  }
  const [delimiter] = validDialects;
  table.delimiter = delimiter;
  const [header, ...records] = parseCsv(text, delimiter).records.filter(record => record.raw !== '');
  table.headers = header.cells;
  table.headerLine = header.line;
  if (header.parseError) report('amazon-invalid-csv', header.parseError, header.line);
  const seenHeaders = new Set<string>();
  for (const [index, column] of header.cells.entries()) {
    const key = column.trim().toLowerCase();
    if (!key || column !== column.trim() || /[\t\r\n,]/u.test(column) || guardSpreadsheetCell(column) !== column ||
      (nativeHeaders.has(key) && column !== key)) {
      report('amazon-invalid-headers', 'Use an unambiguous text header and exact Amazon field names.', header.line, column);
    } else if (seenHeaders.has(key)) {
      report('amazon-duplicate-header', 'Resolve duplicate field names before using this file.', header.line, column);
    } else if (source !== 'baseline' && !scopedHeaders.has(column)) {
      report('amazon-forbidden-column', 'A scoped file may write price and quantity only. Remove this column.', header.line, column);
    } else {
      positions.set(column, index);
    }
    seenHeaders.add(key);
  }
  const skuIndex = positions.get(skuHeader);
  if (skuIndex === undefined) return table;
  const duplicates = new Set<number>();
  for (const record of records) {
    if (record.parseError) {
      report('amazon-invalid-csv', record.parseError, record.line);
      continue;
    }
    if (record.cells.length !== header.cells.length) {
      report('amazon-row-width', 'This record has a different number of fields from its header.', record.line);
      continue;
    }
    const sku = record.cells[skuIndex];
    if (!sku.trim() || /[\x00-\x1f\x7f]/u.test(sku) || guardSpreadsheetCell(sku) !== sku) {
      report('amazon-invalid-sku', 'Use the original nonempty text SKU without control characters or spreadsheet formula content.', record.line, skuHeader);
      continue;
    }
    if (isScientific(sku)) {
      report('amazon-scientific-sku', 'Use the original text SKU before continuing. Scientific notation can hide a changed identity.', record.line, skuHeader);
      continue;
    }
    const existing = rows.get(sku);
    if (existing) {
      if (!duplicates.has(existing.line)) report('amazon-duplicate-sku', 'This exact SKU occurs on more than one source row.', existing.line, skuHeader);
      report('amazon-duplicate-sku', 'This exact SKU occurs on more than one source row.', record.line, skuHeader);
      duplicates.add(existing.line);
    } else {
      rows.set(sku, { ...record, sku });
    }
  }
  if (!records.length) report('amazon-empty-source', 'The file has no SKU records.', header.line);
  return table;
}
