import { currencyColumns, mappingLabel, priceAliases, skuAliases } from '../shopify-price-diff/mapping';
import { currenciesAgree, readAmount, sameAmount, type Amount } from '../shopify-price-diff/prices';
import { parseSupplier } from '../shopify-price-diff/source';
import { isScientific } from '../xlsx';
import type { CostCreepIssue, CostCreepMapping, CostCreepSource, CostCreepSourceInspection } from './types';

type SourceKind = 'period' | 'retail';
const costLabels = new Set([...priceAliases, 'regular price', 'supplier cost', 'purchase price', 'landed cost']);
const retailLabels = new Set(['price', 'retail', 'retail price', 'regular price', 'variant price', 'selling price']);
const currencyUnit = /^(?:[A-Z]{3}|[$€£¥₹])$/u;
export const currencyCode = /^[A-Z]{3}$/;
const suffix = /^(.*?)(?:[\s_-]+([A-Za-z]{3}|[$€£¥₹])|\s*\(([A-Za-z]{3}|[$€£¥₹])\))$/u;

export function problem(code: string, message: string, details: Partial<CostCreepIssue> = {}): CostCreepIssue {
  return { code, message, row: null, rows: [], column: null, sku: null, value: null,
    blocking: true, periodLabel: null, source: 'analysis', ...details };
}

function amountHeader(header: string, kind: SourceKind) {
  const labels = kind === 'period' ? costLabels : retailLabels;
  if (labels.has(mappingLabel(header))) return { suggest: true, currency: null };
  const match = suffix.exec(header.trim());
  if (!match) return { suggest: false, currency: null };
  const suggest = labels.has(mappingLabel(match[1]));
  // Parentheses declare denomination even when the chosen header uses a custom label.
  const currency = suggest || match[3] ? (match[2] ?? match[3]).toUpperCase() : null;
  return { suggest, currency };
}

function inspect(input: CostCreepSource, source: SourceKind) {
  const xlsx = /\.xlsx$/i.test(input.filename);
  const selection = xlsx ? input.sheetName !== undefined ? { sheetName: input.sheetName } : { firstVisibleSheet: true as const } : undefined;
  const parsed = parseSupplier(input.bytes, input.filename, selection);
  const sheet = parsed.sheets[0];
  const headers = sheet?.headers ?? [];
  const matching = (match: (header: string) => boolean) => {
    const positions = headers.flatMap((header, index) => match(header) ? [index] : []);
    return positions.length === 1 ? positions[0] : undefined;
  };
  const issues = [...parsed.issues, ...sheet?.issues ?? []].map(({ code, message, row, rows, column, value, blocking }) =>
    problem(code, message, { source, row, rows: rows.length || row === null ? rows : [row], column, value, blocking }));
  if (/\.csv$/i.test(input.filename) && input.sheetName !== undefined) {
    issues.push(problem('unexpected-worksheet', 'Worksheet selection applies to XLSX files only.', { source, value: input.sheetName }));
  }
  if (source === 'retail' && !/\.csv$/i.test(input.filename)) {
    issues.push(problem('unsupported-retail-file', 'Choose a store retail baseline CSV.', { source }));
  }
  const inspection: CostCreepSourceInspection = {
    sheetNames: parsed.sheetNames ?? [], selectedSheet: xlsx ? sheet?.name ?? null : null, headers,
    suggestions: {
      skuColumn: matching((header) => skuAliases.has(mappingLabel(header)) || mappingLabel(header) === 'product code/sku'),
      amountColumn: matching((header) => amountHeader(header, source).suggest),
    },
    issues, rowCount: sheet?.rows.length ?? 0,
  };
  return { inspection, sheet };
}

export function inspectCostCreepSource(input: CostCreepSource, kind: SourceKind = 'period'): CostCreepSourceInspection {
  return inspect(input, kind).inspection;
}

interface Evidence extends Pick<CostCreepIssue, 'source' | 'periodLabel' | 'column' | 'row' | 'sku'> {
  unit: string;
}

interface Entry {
  amount: Amount;
  sourceRows: { row: number; rawCost: string }[];
  evidence: Evidence[];
}

export function projectSource(input: CostCreepSource & { mapping?: CostCreepMapping }, source: SourceKind,
  periodLabel: string | null, declared: string | undefined) {
  const { inspection, sheet } = inspect(input, source);
  const { headers } = inspection;
  const issues = inspection.issues.map((issue) => ({ ...issue, periodLabel }));
  const requestedMapping = {
    skuColumn: input.mapping?.skuColumn ?? inspection.suggestions.skuColumn,
    amountColumn: input.mapping?.amountColumn ?? inspection.suggestions.amountColumn,
  };
  const resolve = (column: number | string | undefined) => typeof column === 'string'
    ? headers.findIndex((header) => header === column)
    : column;
  const skuColumn = resolve(requestedMapping.skuColumn);
  const amountColumn = resolve(requestedMapping.amountColumn);
  const mapping = { skuColumn, amountColumn };
  const entries = new Map<string, Entry>();
  const conflicting = new Set<string>();
  const evidence = new Map<string, Evidence>();
  const projection = { inspection, issues, mapping, requestedMapping, entries, evidence };
  if (!sheet || !headers.length) return projection;
  const available = (index: number | undefined): index is number =>
    index !== undefined && Number.isInteger(index) && index >= 0 && index < headers.length;
  const mappingIssue = (key: keyof CostCreepMapping) => ({ source, periodLabel, row: sheet.headerRow,
    rows: sheet.headerRow === null ? [] : [sheet.headerRow], value: requestedMapping[key]?.toString() ?? null });
  if (!available(skuColumn)) issues.push(problem('missing-sku-column', 'Choose one literal SKU column.', mappingIssue('skuColumn')));
  if (!available(amountColumn)) issues.push(problem('missing-amount-column', source === 'period'
    ? 'Choose one literal supplier cost column.' : 'Choose one literal store retail price column.', mappingIssue('amountColumn')));
  if (!available(skuColumn) || !available(amountColumn)) return projection;
  if (skuColumn === amountColumn) {
    issues.push(problem('reused-column-mapping', 'Choose different columns for SKU and amount.', { source, periodLabel }));
    return projection;
  }

  const location = (column: string, row: number | null, sku: string | null) => ({ source, periodLabel, column, row, sku });
  const priceHeader = headers[amountColumn];
  const headerCurrency = amountHeader(priceHeader, source).currency;
  const currencyPositions = headers.flatMap((header, index) =>
    (source === 'period' ? ['cost currency', 'wholesale currency'] : ['retail currency', 'store currency'])
      .includes(mappingLabel(header)) ? [index] : []);
  const currencyIndexes = [...new Set([...currencyColumns(headers), ...currencyPositions])];
  const sheetEvidence: Evidence[] = [];
  if (declared && currencyCode.test(declared)) sheetEvidence.push({ unit: declared, ...location('Currency declaration', null, null) });
  if (headerCurrency) sheetEvidence.push({ unit: headerCurrency, ...location(priceHeader, sheet.headerRow, null) });
  for (const item of sheetEvidence) evidence.set(item.unit, item);

  for (const { line, cells } of sheet.rows) {
    const skuCell = cells[skuColumn];
    const amountCell = cells[amountColumn];
    const rawSku = skuCell?.value ?? '';
    const sku = skuCell?.kind === 'text' && rawSku.trim() !== '' && !isScientific(rawSku) ? rawSku : null;
    if (sku === null) {
      issues.push(problem('invalid-sku', 'Use the exact original SKU as nonempty text. Numeric and formula worksheet cells and scientific notation are ambiguous.',
        { ...location(headers[skuColumn], line, null), rows: [line], value: rawSku }));
    }
    const rawCost = amountCell?.value ?? '';
    const amount = (amountCell?.kind === 'text' || amountCell?.kind === 'number') && !amountCell.scientific
      ? readAmount(rawCost) : null;
    if (amount === null || amount.units < 0n) {
      issues.push(problem('invalid-amount', 'Use a nonnegative plain amount accepted by the local price parser.',
        { ...location(priceHeader, line, sku), rows: [line], value: rawCost }));
    }

    const rowEvidence: Evidence[] = [];
    for (const unit of [amount?.currency, amountCell?.currency]) {
      if (unit) rowEvidence.push({ unit, ...location(priceHeader, line, sku) });
    }
    for (const index of currencyIndexes) {
      const cell = cells[index];
      const unit = cell?.value?.trim().toUpperCase() ?? '';
      if (!unit && cell?.kind !== 'formula' && cell?.kind !== 'unsupported') continue;
      if (cell?.kind === 'text' && currencyUnit.test(unit)) {
        rowEvidence.push({ unit, ...location(headers[index], line, sku) });
      } else {
        issues.push(problem('invalid-currency', 'Use a plain currency code or supported symbol in this column.',
          { ...location(headers[index], line, sku), rows: [line], value: cell?.value ?? null }));
      }
    }
    for (const item of rowEvidence) if (!evidence.has(item.unit)) evidence.set(item.unit, item);
    if (!currenciesAgree([...sheetEvidence, ...rowEvidence].map(({ unit }) => unit))) {
      issues.push(problem('currency-conflict', 'This row has conflicting currency evidence.',
        { ...location(priceHeader, line, sku), rows: [line], value: rawCost }));
    }

    if (sku === null || amount === null || amount.units < 0n) continue;
    const existing = entries.get(sku);
    const raw = { row: line, rawCost };
    if (!existing) {
      entries.set(sku, { amount, sourceRows: [raw], evidence: rowEvidence });
    } else {
      if (!sameAmount(existing.amount, amount) ||
          !currenciesAgree([...existing.evidence, ...rowEvidence].map(({ unit }) => unit))) conflicting.add(sku);
      existing.sourceRows.push(raw);
      for (const item of rowEvidence) {
        if (!existing.evidence.some(({ unit }) => unit === item.unit)) existing.evidence.push(item);
      }
    }
  }

  for (const sku of conflicting) {
    const rows = entries.get(sku)!.sourceRows.map(({ row }) => row);
    issues.push(problem('conflicting-duplicate-sku', 'This exact SKU has conflicting amounts or currency on rows ' + rows.join(', ') + '.',
      { ...location(headers[skuColumn], rows[0], sku), rows }));
  }
  return projection;
}
