import { decodeCsv, parseCsv, type CsvRecord } from '../csv';
import { guardSpreadsheetCell } from '../formula-guard';
import { exactSku, literalNumber } from '../purchase-order/source';
import { mappingLabel } from '../shopify-price-diff/mapping';
import { baselinePrice, currenciesAgree } from '../shopify-price-diff/prices';
import { addLine } from '../shopify-price-diff/source';
import type { SourceCell, SourceRow } from '../shopify-price-diff/types';
import { readMinorUnits } from '../values';
import { openWorkbook } from '../xlsx';
import type { LandedCostIssue, LandedCostOptions, LandedCostSource } from './types';

const columns = {
  sku: 'SKU', quantity: 'Quantity', fob: 'FOB Unit Cost', weight: 'Unit Weight Kg', volume: 'Unit Volume CBM',
  duty: 'Duty Rate %', hsCode: 'HS Code', description: 'Description', currency: 'FOB Currency',
};
export const wholeNumber = /^\d{1,64}(?![\s\S])/;
const measured = (cell: SourceCell | undefined) => literalNumber(cell) && !cell?.currency;

export function finiteDecimal(text: string): { units: bigint; scale: number } | null {
  if (!baselinePrice.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const significant = fraction.replace(/0+$/, '');
  return { units: BigInt(whole + significant), scale: significant.length };
}

function misquoted(record: CsvRecord): boolean {
  if (!record.cells.some(value => value.includes('"'))) return false;
  // Papa has already split the cells. Check that quotes in their values were escaped in the original record.
  let cursor = 0;
  for (const [index, value] of record.cells.entries()) {
    const quoted = record.raw[cursor] === '"';
    const written = quoted ? '"' + value.replaceAll('"', '""') + '"' : value;
    if (!quoted && value.includes('"') || !record.raw.startsWith(written, cursor)) return true;
    cursor += written.length;
    if (quoted) while (record.raw[cursor] === ' ' || record.raw[cursor] === '\t') cursor++;
    if (index < record.cells.length - 1) cursor++;
  }
  return false;
}

export function inspectLandedCostSource({ bytes, name, sheetName }: LandedCostSource): {
  rows: SourceRow[]; worksheetNames: string[]; selectedWorksheet: string | null; issues: LandedCostIssue[];
} {
  const issues: LandedCostIssue[] = [];
  const worksheetNames: string[] = [];
  const empty = { rows: [], worksheetNames, selectedWorksheet: null, issues };
  if (/\.xlsx$/i.test(name)) {
    try {
      const workbook = openWorkbook(bytes);
      worksheetNames.push(...workbook.sheetNames);
      const selectedWorksheet = sheetName ?? (worksheetNames.length === 1 ? worksheetNames[0] : undefined);
      if (selectedWorksheet !== undefined && worksheetNames.includes(selectedWorksheet)) {
        return { rows: workbook.readSheets(selectedWorksheet)[0].rows, worksheetNames, selectedWorksheet, issues };
      }
      issues.push({ code: 'invalid-invoice-worksheet', message: worksheetNames.length
        ? 'Choose the exact name of a visible invoice worksheet.' : 'The workbook contains no visible invoice worksheet.' });
    } catch (error) {
      issues.push(error instanceof Error && error.message === 'external-xlsx-relationship'
        ? { code: 'external-xlsx-relationship', message: 'Save the invoice as a local values-only workbook without external references.' }
        : { code: 'invalid-xlsx', message: 'The invoice workbook cannot be read or exceeds the supported workbook limits.' });
    }
    return empty;
  }
  if (!/\.csv$/i.test(name)) {
    issues.push({ code: 'invalid-invoice-format', message: 'Provide an invoice CSV or XLSX workbook.' });
    return empty;
  }
  if (sheetName !== undefined) {
    issues.push({ code: 'invalid-invoice-worksheet', message: 'Choose a worksheet only for an XLSX invoice.' });
    return empty;
  }
  const decoded = decodeCsv(bytes);
  if (decoded.encoding === 'unknown') {
    issues.push({ code: 'invalid-invoice-encoding', message: 'The invoice cannot be decoded as a supported CSV encoding.' });
    return empty;
  }
  const records = parseCsv(decoded.text).records.filter(record => record.raw !== '' || record.parseError);
  const width = records[0]?.cells.length;
  const rows = records.map(record => {
    const syntax = record.parseError ?? (misquoted(record) ? 'A cell contains a quote outside RFC 4180 quoting.' : undefined);
    if (syntax) issues.push({ code: 'invalid-csv', message: syntax, line: record.line, value: record.raw });
    if (record.cells.length !== width) {
      issues.push({ code: 'row-width', message: 'Match the number of columns in the invoice header.', line: record.line });
    }
    return { line: record.line, cells: record.cells.map(value => ({ value, kind: 'text' as const })) };
  });
  return { ...empty, rows };
}

type InputRow = {
  line: number;
  sku: string;
  description: string;
  hsCode: string;
  quantity: bigint;
  sourceFobUnitCents: bigint;
  dutyRateBps: bigint;
  driver: { units: bigint; scale: number };
};

export function readInvoice(source: LandedCostSource, method: LandedCostOptions['method'], sourceCurrency: string | null) {
  const { rows, worksheetNames, selectedWorksheet, issues } = inspectLandedCostSource(source);
  const [header, ...records] = rows;
  const parsed: InputRow[] = [];
  const result = { rows: parsed, worksheetNames, selectedWorksheet, issues };
  if (!header) {
    if (!issues.length) issues.push({ code: 'missing-header', message: 'Include an invoice header and at least one shipment line.' });
    return result;
  }

  const required = ['sku', 'quantity', 'fob', ...(method === 'by-weight' ? ['weight'] : method === 'by-cbm' ? ['volume'] : [])];
  const labels = Array.from(header.cells, cell => mappingLabel(cell?.value ?? ''));
  const positions = new Map<string, number[]>();
  for (const [index, label] of labels.entries()) {
    if (!label || header.cells[index]?.kind !== 'text') {
      issues.push({ code: 'invalid-header', message: 'Every invoice column needs a text header.', line: header.line,
        value: header.cells[index]?.value ?? undefined });
    } else addLine(positions, label, index + 1);
  }
  for (const [label, indexes] of positions) {
    if (indexes.length > 1) issues.push({ code: 'duplicate-header', message: 'This header occurs in columns ' + indexes.join(', ') + '.',
      line: header.line, column: label });
  }
  const indexes = Object.entries(columns).map(([key, label]) => {
    const index = labels.indexOf(mappingLabel(label));
    const position = key === 'currency' && index < 0 ? labels.indexOf('currency') : index;
    if (required.includes(key) && position < 0) {
      issues.push({ code: 'missing-column', message: 'Include the ' + label + ' column for this method.', line: header.line, column: label });
    }
    return [key, position] as const;
  });
  if (labels.includes('currency') && labels.includes('fob currency')) {
    issues.push({ code: 'duplicate-currency-column', message: 'Keep one Currency or FOB Currency column.', line: header.line, column: 'FOB Currency' });
  }
  if (!records.length) issues.push({ code: 'missing-invoice-rows', message: 'Include at least one shipment line.' });
  if (indexes.some(([key, index]) => index < 0 && required.includes(key))) return result;

  const byKey = new Map(indexes);
  const skuLines = new Map<string, number[]>();
  for (const { line, cells } of records) {
    const get = (key: keyof typeof columns): SourceCell | undefined => cells[byKey.get(key)!];
    const skuCell = get('sku');
    const sku = skuCell?.value ?? '';
    const rowStart = issues.length;
    const report = (key: keyof typeof columns, code: string, message: string) =>
      issues.push({ code, message, line, column: columns[key], sku, value: get(key)?.value ?? undefined });
    if (!exactSku(skuCell) || sku !== sku.trim() || /[\x00-\x1f\x7f]/.test(sku)) {
      report('sku', 'invalid-sku', 'Use the exact SKU as text, including any leading zeroes.');
    } else {
      addLine(skuLines, sku, line);
      if (guardSpreadsheetCell(sku) !== sku) report('sku', 'unsafe-sku', 'Correct this SKU at its source so its exact text is safe in a CSV.');
    }
    if (cells.slice(header.cells.length).some(cell => cell?.kind === 'formula' || cell?.kind === 'unsupported' || cell?.value)) {
      issues.push({ code: 'row-width', message: 'Keep invoice data within its header columns.', line, sku });
    }

    const rawQuantity = get('quantity')?.value ?? '';
    const quantity = measured(get('quantity')) && wholeNumber.test(rawQuantity) ? BigInt(rawQuantity) : 0n;
    if (quantity <= 0n) report('quantity', 'invalid-quantity', 'Enter a positive whole quantity.');

    const fob = get('fob');
    const fobRaw = fob?.value ?? '';
    const sourceFobUnitCents = literalNumber(fob) && baselinePrice.test(fobRaw) ? readMinorUnits(fobRaw, 2) : undefined;
    if (sourceFobUnitCents === undefined) report('fob', 'invalid-fob-unit-cost', 'Enter a nonnegative FOB unit cost in exact cents.');
    const sourceUnit = get('currency');
    if (sourceUnit?.kind === 'formula' || sourceUnit?.kind === 'unsupported' || sourceCurrency &&
      (sourceUnit?.value && sourceUnit.value.trim().toUpperCase() !== sourceCurrency ||
        fob?.currency && !currenciesAgree([sourceCurrency, fob.currency]))) {
      report('currency', 'conflicting-source-currency', 'Use the configured FOB invoice currency on every shipment line.');
    }

    const duty = get('duty');
    const dutyRaw = duty?.value ?? '';
    const rate = dutyRaw.replace(/%$/, '');
    const dutyRateBps = dutyRaw === '' && duty?.kind !== 'formula' && duty?.kind !== 'unsupported' ? 0n
      : (measured(duty) || duty?.percentFormat) && baselinePrice.test(rate) ? readMinorUnits(rate, duty?.percentFormat ? 4 : 2) : undefined;
    if (dutyRateBps === undefined || dutyRateBps > 20_000n) {
      report('duty', 'invalid-duty-rate', 'Enter a duty rate from 0% to 200% in whole basis points.');
    }

    const driverKey = method === 'by-weight' ? 'weight' : method === 'by-cbm' ? 'volume' : null;
    const driver = driverKey ? positiveDriver(driverKey) : { units: quantity, scale: 0 };
    function positiveDriver(key: 'weight' | 'volume') {
      const cell = get(key);
      const value = measured(cell) && cell?.value ? finiteDecimal(cell.value) : null;
      if (!value || value.units <= 0n) report(key, key === 'weight' ? 'invalid-unit-weight' : 'invalid-unit-cbm',
        'Enter a positive per-unit ' + (key === 'weight' ? 'weight in kg.' : 'volume in CBM.'));
      return value;
    }
    for (const key of ['hsCode', 'description'] as const) {
      const cell = get(key);
      if (cell?.kind === 'formula' || cell?.kind === 'unsupported') report(key, 'invalid-invoice-text', 'Use a literal cell value.');
    }
    if (issues.length !== rowStart || sourceFobUnitCents === undefined || dutyRateBps === undefined || !driver) continue;
    parsed.push({ line, sku, quantity, sourceFobUnitCents, dutyRateBps, driver,
      description: get('description')?.value ?? '', hsCode: get('hsCode')?.value ?? '' });
  }
  for (const [sku, lines] of skuLines) {
    if (lines.length > 1) issues.push({ code: 'duplicate-sku', message: 'This SKU occurs on lines ' + lines.join(', ') + '.',
      line: lines[0], lines, sku, column: 'SKU' });
  }
  return result;
}
