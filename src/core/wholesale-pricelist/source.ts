import { bigCommerceSkuHeader, bigNameHeader, parseBigCommerceBaseline } from '../bigcommerce-price-diff/source';
import { exactCostCents } from '../bom/rollup';
import { exactSku, literalNumber } from '../purchase-order/source';
import { currenciesAgree, baselinePrice, readAmount } from '../shopify-price-diff/prices';
import { currencyColumns, mappingLabel } from '../shopify-price-diff/mapping';
import { parseBaseline, parseSupplier, readCsvTable, skuHeader } from '../shopify-price-diff/source';
import { cellValue, type DiffIssue, type SourceRow, type SourceTable, type StorePlatform } from '../shopify-price-diff/types';
import { parseWooCommerceBaseline, wooWritable } from '../woocommerce-price-diff/source';
import type { WholesaleIssue } from './types';

const evidenceNames = {
  cost: ['Cost', 'Landed Cost', 'Unit Cost', 'Cost per item'],
  map: ['MAP', 'Minimum Advertised Price'],
  casePack: ['Case Pack'],
  moq: ['MOQ', 'Minimum Order Quantity'],
};
const fields = Object.keys(evidenceNames) as (keyof typeof evidenceNames)[];
export type Evidence = Partial<Record<keyof typeof evidenceNames, { value: bigint; line: number; source: 'baseline' | 'cost-sheet' }>>;
export const maxQuantity = 2_147_483_647n;

export function positiveQuantity(value: string): bigint | null {
  if (!/^\d{1,10}(?![\s\S])/.test(value)) return null;
  const quantity = BigInt(value);
  return quantity > 0n && quantity <= maxQuantity ? quantity : null;
}

function convertIssue(entry: DiffIssue, source: 'baseline' | 'cost-sheet', sku?: string): WholesaleIssue {
  return { code: entry.code, message: entry.message, source, ...(sku ? { sku } : {}),
    ...(entry.row === null ? {} : { line: entry.row }), ...(entry.rows.length ? { lines: entry.rows } : {}),
    ...(entry.column === null ? {} : { column: entry.column }) };
}

function readEvidence(table: SourceTable, source: 'baseline' | 'cost-sheet', currency: string, issues: WholesaleIssue[]) {
  const labels = table.headers.map(mappingLabel);
  const currencyIndexes = currencyColumns(table.headers);
  const indexes = fields.map(key => {
    const aliases = evidenceNames[key].map(mappingLabel);
    const positions = labels.flatMap((label, index) => aliases.includes(label) ? [index] : []);
    if (positions.length > 1) issues.push({ source, code: 'ambiguous-evidence-column', line: table.headerRow ?? undefined,
      column: evidenceNames[key][0], message: 'Keep one unambiguous ' + evidenceNames[key][0] + ' column.' });
    return [key, positions[0] ?? -1] as const;
  });
  return {
    hasEvidence: indexes.some(([, index]) => index >= 0),
    read(row: SourceRow, sku: string): Evidence {
      for (const index of currencyIndexes) {
        const cell = row.cells[index];
        const unit = cell?.value?.trim().toUpperCase();
        if (cell?.kind === 'formula' || cell?.kind === 'unsupported' || unit && !currenciesAgree([currency, unit])) {
          issues.push({ source, code: 'conflicting-currency', sku, line: row.line, column: table.headers[index],
            message: 'The row’s currency evidence must match the configured currency.' });
        }
      }
      const evidence: Evidence = {};
      for (const [key, index] of indexes) {
        const cell = row.cells[index];
        const raw = cell?.value;
        if ((raw === null || raw === '' || raw === undefined) && cell?.kind !== 'formula' && cell?.kind !== 'unsupported') continue;
        const monetary = key === 'cost' || key === 'map';
        const value = raw && literalNumber(cell) && (!cell?.currency || monetary && currenciesAgree([currency, cell.currency]))
          ? monetary ? exactCostCents(baselinePrice.test(raw) ? readAmount(raw) : null) : positiveQuantity(raw) : null;
        if (value === null || key === 'map' && value === 0n) {
          issues.push({ source, code: 'invalid-' + key, sku, line: row.line, column: table.headers[index],
            message: monetary ? 'Use a literal store-currency amount in exact cents' + (key === 'map' ? ' greater than zero.' : '.') :
              'Use a positive whole number that fits a Shopify quantity rule.' });
        } else evidence[key] = { value, line: row.line, source };
      }
      return evidence;
    },
  };
}

export function readWholesaleBaseline(platform: StorePlatform, bytes: Uint8Array, currency: string, issues: WholesaleIssue[]) {
  const parse = { shopify: parseBaseline, woocommerce: parseWooCommerceBaseline, bigcommerce: parseBigCommerceBaseline }[platform];
  const baseline = parse(bytes, undefined, { retainEmptyRecords: true });
  const { columns, variants, bigcommerceGroupedProducts } = baseline;
  const skuColumn = platform === 'shopify' ? skuHeader : platform === 'woocommerce' ? 'SKU' : bigCommerceSkuHeader(baseline);
  const skuAtLine = new Map(baseline.rows.map(row => [row.line, cellValue(row, columns.get(skuColumn))]));
  issues.push(...baseline.issues.map(entry => convertIssue(entry, 'baseline', skuAtLine.get(entry.row ?? -1) ?? undefined)));

  const titleColumn = columns.get(platform === 'shopify' ? 'Title' : platform === 'woocommerce' ? 'Name' : bigNameHeader);
  const titles = new Map<string, string>();
  const bigVariantGroups = new Set(variants.flatMap(({ bigcommerce }) => bigcommerce?.type === 'SKU' ? [bigcommerce.productId] : []));
  const { read } = readEvidence(baseline, 'baseline', currency, issues);
  return variants.flatMap(variant => {
    const { sku, source, handle, woocommerce, bigcommerce } = variant;
    const title = cellValue(source, titleColumn);
    if (platform === 'shopify' && title && !titles.has(handle)) titles.set(handle, title);
    if (bigcommerce?.type === 'Product' && title) titles.set(bigcommerce.productId, title);
    if (woocommerce && !wooWritable(woocommerce.type)) {
      if (woocommerce.type.split(',')[0] !== 'variable') issues.push({ source: 'baseline', sku, line: source.line,
        code: 'unsupported-wholesale-product', message: 'Wholesale pricing supports WooCommerce simple products and variations.' });
      return [];
    }
    if (bigcommerce?.type === 'Product' && bigcommerceGroupedProducts?.has(bigcommerce.id)) {
      if (!bigVariantGroups.has(bigcommerce.id)) issues.push({ source: 'baseline', sku, line: source.line,
        code: 'missing-bigcommerce-wholesale-variants', message: 'Include the original SKU rows with explicit retail prices for this grouped product.' });
      return [];
    }
    if (!exactSku(source.cells[columns.get(skuColumn) ?? -1]) || sku !== sku.trim() || /[\x00-\x1f\x7f]/.test(sku)) {
      issues.push({ code: 'invalid-wholesale-sku', source: 'baseline', sku, line: source.line, column: skuColumn,
        message: 'Every sellable row needs an exact, nonempty text SKU.' });
    }
    const product = bigcommerce?.type === 'SKU' ? titles.get(bigcommerce.productId) : title || titles.get(handle);
    return [{ sku, product: product || sku, line: source.line, price: variant.price, evidence: read(source, sku) }];
  });
}

export function readWholesaleCosts(bytes: Uint8Array, sheetName: string | undefined, currency: string, issues: WholesaleIssue[]) {
  const workbook = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const parsed = workbook
    ? parseSupplier(bytes, 'Cost and MAP.xlsx', sheetName === undefined ? { firstVisibleSheet: true } : { sheetName })
    : { sheets: [readCsvTable(bytes, 'Cost and MAP.csv', 'supplier', mappingLabel, { retainEmptyRecords: true })], issues: [] };
  if (sheetName !== undefined && !workbook) issues.push({ source: 'cost-sheet', code: 'invalid-cost-worksheet',
    message: 'Choose a worksheet only for an XLSX cost sheet.' });
  const sheet = parsed.sheets[0];
  const records = new Map<string, { line: number; evidence: Evidence }>();
  if (!sheet) {
    issues.push(...parsed.issues.map(entry => convertIssue(entry, 'cost-sheet')));
    return { records, selectedWorksheet: null };
  }
  const skuColumns = sheet.headers.flatMap((header, index) => mappingLabel(header) === 'sku' ? [index] : []);
  const [skuIndex = -1] = skuColumns;
  const skuAtLine = new Map(sheet.rows.map(row => [row.line, row.cells[skuIndex]?.value]));
  issues.push(...sheet.issues.map(entry => convertIssue(entry, 'cost-sheet', skuAtLine.get(entry.row ?? -1) ?? undefined)));
  const { read, hasEvidence } = readEvidence(sheet, 'cost-sheet', currency, issues);
  if (skuColumns.length > 1) issues.push({ source: 'cost-sheet', code: 'ambiguous-cost-sheet-sku', line: sheet.headerRow ?? undefined,
    column: 'SKU', message: 'Keep exactly one unambiguous SKU column.' });
  else if (skuIndex < 0 || !hasEvidence) issues.push({ source: 'cost-sheet', code: 'missing-cost-sheet-columns', line: sheet.headerRow ?? undefined,
    message: 'Provide SKU and at least one of Cost, MAP, Case Pack or MOQ.' });
  else for (const row of sheet.rows) {
    const cell = row.cells[skuIndex];
    if (!exactSku(cell) || cell.value !== cell.value.trim() || /[\x00-\x1f\x7f]/.test(cell.value)) {
      issues.push({ code: 'invalid-cost-sheet-sku', source: 'cost-sheet', sku: cell?.value ?? undefined, line: row.line, column: 'SKU',
        message: 'Use the exact SKU as text, including leading zeroes.' });
      continue;
    }
    const sku = cell.value;
    const evidence = read(row, sku);
    const previous = records.get(sku);
    if (previous) issues.push({ code: 'duplicate-cost-sheet-sku', source: 'cost-sheet', sku, line: previous.line,
      lines: [previous.line, row.line], column: 'SKU', message: 'Use only one cost sheet row for this SKU.' });
    else records.set(sku, { line: row.line, evidence });
  }
  return { records, selectedWorksheet: workbook ? sheet.name : null };
}

export function mergeEvidence(baseline: Evidence, cost: Evidence | undefined, sku: string, line: number, issues: WholesaleIssue[]): Evidence {
  const result = { ...baseline, ...cost };
  for (const key of fields) {
    const from = baseline[key];
    const now = cost?.[key];
    if (from && now && from.value !== now.value) {
      issues.push({ source: 'cost-sheet', code: 'conflicting-' + key, sku, line: now.line, baselineLine: line, costLine: now.line,
        column: evidenceNames[key][0], message: 'The catalog and cost sheet disagree on ' + evidenceNames[key][0] + '.' });
    }
  }
  return result;
}
