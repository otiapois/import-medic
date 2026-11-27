import { decodeCsv, parseCsv, type CsvRecord } from '../csv';
import type { SourceCell } from '../shopify-price-diff/types';
import { openWorkbook } from '../xlsx';
import type { InventoryBaselineInspection, InventoryIssue, InventorySource, InventorySupplierInspection, InventorySupplierSource } from './types';

export const currentHeader = 'On hand (current)';
export const newHeader = 'On hand (new)';
const optionValues = ['Option1 Value', 'Option2 Value', 'Option3 Value'];
const optionNames = ['Option1 Name', 'Option2 Name', 'Option3 Name'];
const identityHeaders = new Set(['Handle', 'Title', 'SKU', 'Location', ...optionValues, ...optionNames]);
const optionHeader = /^Option ([123]) (Name|Value)$/;

interface InventoryBaseline extends InventoryBaselineInspection {
  records: CsvRecord[];
  columns: Map<string, number>;
  identity: { header: string; canonical: string; position: number }[];
}

interface InventorySupplier extends InventorySupplierInspection {
  headerLine: number;
  rows: { line: number; cells: SourceCell[] }[];
}

function readCsv(source: InventoryIssue['source'], bytes: Uint8Array, issues: InventoryIssue[]) {
  const decoded = decodeCsv(bytes);
  if (decoded.encoding === 'unknown') {
    issues.push({ code: 'invalid-encoding', source, message: 'Save the CSV with a supported text encoding.' });
    return [];
  }
  const records = parseCsv(decoded.text).records.filter(({ raw }) => raw !== '');
  const [header] = records;
  if (!header) issues.push({ code: 'missing-header', source, line: 1, message: 'Provide a CSV with a header row.' });
  for (const record of records) {
    if (record.parseError) {
      issues.push({ code: 'invalid-csv', source, line: record.line, value: record.raw, message: record.parseError });
    } else if (record.cells.length !== header.cells.length) {
      issues.push({ code: 'row-width', source, line: record.line,
        message: `This record has ${record.cells.length} cells and the header has ${header.cells.length}.` });
    }
  }
  return records;
}

export function readInventoryBaseline({ filename, bytes }: InventorySource): InventoryBaseline {
  const issues: InventoryIssue[] = [];
  const columns = new Map<string, number>();
  const identity: InventoryBaseline['identity'] = [];
  if (!/\.csv$/i.test(filename)) {
    issues.push({ code: 'baseline-file-type', source: 'baseline', message: 'Choose the Shopify All states inventory CSV.' });
    return { locations: [], records: [], issues, columns, identity };
  }
  const [head, ...records] = readCsv('baseline', bytes, issues);
  if (!head || head.parseError) return { locations: [], records: [], issues, columns, identity };

  const seen = new Set<string>();
  for (const [position, header] of head.cells.entries()) {
    const canonical = header.replace(optionHeader, 'Option$1 $2');
    const key = canonical.trim().toLowerCase();
    if (key === '' || seen.has(key)) {
      issues.push({ code: key === '' ? 'missing-header' : 'duplicate-header', source: 'baseline', line: head.line,
        column: header, message: key === '' ? 'Every baseline column needs a header.' : 'Each baseline column must have an unambiguous header.' });
    } else {
      seen.add(key);
      columns.set(canonical, position);
    }
    if (identityHeaders.has(canonical)) identity.push({ header, canonical, position });
  }
  for (const column of ['Handle', 'SKU', 'Location', optionValues[0], currentHeader]) {
    if (!columns.has(column)) issues.push({ code: 'missing-baseline-column', source: 'baseline', line: head.line, column,
      message: column === currentHeader ? 'Use the Shopify All states inventory export with On hand (current).' :
        `The baseline needs the ${column} column to identify exact inventory records.` });
  }
  const locationColumn = columns.get('Location');
  const locations = new Set<string>();
  if (locationColumn !== undefined) {
    for (const record of records) {
      if (record.parseError || record.cells.length !== head.cells.length) continue;
      const location = record.cells[locationColumn];
      if (location.trim() !== '') locations.add(location);
      else issues.push({ code: 'missing-location', source: 'baseline', line: record.line, column: 'Location',
        message: 'This baseline record has no exact Shopify location.' });
    }
  }
  return { locations: [...locations], records, issues, columns, identity };
}

export function inventoryIdentity(record: CsvRecord, columns: ReadonlyMap<string, number>) {
  const read = (column: string) => record.cells[columns.get(column) ?? -1] ?? '';
  const handle = read('Handle');
  const location = read('Location');
  const sku = read('SKU');
  const options = optionValues.map(read);
  const names = optionNames.map(read);
  const optionDepth = options.reduce((depth, value, index) => value.trim() ? index + 1 : depth, 0);
  const declaredDepth = names.reduce((depth, name, index) => name.trim() ? Math.max(depth, index + 1) : depth, optionDepth);
  const valid = /^[\p{L}\p{N}-]+$/u.test(handle) && /[\p{L}\p{N}]/u.test(handle) &&
    optionDepth > 0 && optionDepth === declaredDepth &&
    options.every((value, index) => index < optionDepth ? value.trim() !== '' : value === '');
  return { sku, handle, location, valid, optionDepth, declaredDepth, key: JSON.stringify([handle, ...options, location]), currentRaw: read(currentHeader) };
}

export function readInventorySupplier({ filename, bytes, sheetName }: InventorySupplierSource): InventorySupplier {
  const issues: InventoryIssue[] = [];
  const empty: InventorySupplier = { headers: [], sheetNames: [], issues, rows: [], headerLine: 1 };
  if (/\.csv$/i.test(filename)) {
    if (sheetName !== undefined) {
      issues.push({ code: 'supplier-worksheet-invalid', source: 'supplier', message: 'Only XLSX suppliers accept a worksheet selection.' });
      return empty;
    }
    const [header, ...records] = readCsv('supplier', bytes, issues);
    if (!header || header.parseError) return empty;
    const rows = records.filter(record => !record.parseError && record.cells.length === header.cells.length)
      .map(({ line, cells }) => ({ line, cells: cells.map(value => ({ value, kind: 'text' as const })) }));
    return { ...empty, headers: header.cells, headerLine: header.line, rows };
  }
  if (!/\.xlsx$/i.test(filename)) {
    issues.push({ code: 'supplier-file-type', source: 'supplier', message: 'Choose a CSV or XLSX supplier file.' });
    return empty;
  }
  try {
    const workbook = openWorkbook(bytes);
    const { sheetNames } = workbook;
    if (sheetName === undefined || !sheetNames.includes(sheetName)) {
      issues.push({ code: sheetName === undefined ? 'supplier-worksheet-required' : 'supplier-worksheet-invalid', source: 'supplier',
        message: 'Choose the exact name of a visible supplier worksheet.' });
      return { ...empty, sheetNames };
    }
    const { rows: [header, ...rows] } = workbook.readSheets(sheetName)[0];
    if (header === undefined) {
      issues.push({ code: 'missing-header', source: 'supplier', line: 1, message: 'The selected worksheet needs a header row.' });
      return { ...empty, sheetNames };
    }
    const headers = Array.from(header.cells, cell => cell?.kind === 'text' || cell?.kind === 'number' ? cell.value ?? '' : '');
    return { headers, sheetNames, issues, rows, headerLine: header.line };
  } catch (error) {
    const external = error instanceof Error && error.message === 'external-xlsx-relationship';
    issues.push({ code: external ? 'external-xlsx-relationship' : 'invalid-xlsx', source: 'supplier',
      message: external ? 'This workbook contains an external relationship. Save a local copy with literal values.' :
        'Choose a well-formed, supported XLSX supplier workbook.' });
    return empty;
  }
}
