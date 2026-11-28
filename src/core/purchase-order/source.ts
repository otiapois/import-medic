import { currencyColumns, mappingLabel, skuAliases } from '../shopify-price-diff/mapping';
import { parseSupplier, readCsvTable } from '../shopify-price-diff/source';
import type { DiffIssue, SourceCell } from '../shopify-price-diff/types';
import { isScientific, listWorkbookSheets } from '../xlsx';
import type {
  PurchaseOrderInventoryInspection, PurchaseOrderIssue, PurchaseOrderSource, PurchaseOrderSupplierInspection,
} from './types';

const quantityHeaders = ['available', 'available (not editable)', 'on hand (current)', 'on hand', 'current qty', 'current quantity'];
const unitCostHeader = /^(unit cost|cost|supplier cost|wholesale cost)(?:\s*\(([a-z]{3}|[$€£¥₹])\)|\s+([a-z]{3}|[$€£¥₹]))?$/iu;
const storeSkuHeaders = new Set([...skuAliases].filter(label => label !== 'supplier sku'));

export const exactSku = (cell: SourceCell | undefined): cell is SourceCell & { value: string } =>
  cell?.kind === 'text' && cell.value !== null && cell.value.trim() !== '' && !cell.value.includes('\0') && !isScientific(cell.value);

export function quantity(raw: string, signed = false): number | null {
  const text = raw.trim();
  if (!(signed ? /^[+-]?\d+$/ : /^\d+$/).test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed || 0 : null;
}

export const literalNumber = (cell: SourceCell | undefined) => cell?.kind === 'text' || (cell?.kind === 'number' && !cell.scientific);

function sourceIssue({ row, rows, column, value, code, message }: DiffIssue, source: PurchaseOrderIssue['source']): PurchaseOrderIssue {
  return { source, code, message, ...(row !== null ? { line: row } : {}), ...(rows.length ? { lines: rows } : {}),
    ...(column !== null ? { column } : {}), ...(value !== null ? { value } : {}) };
}

function selectColumn(headers: string[], matches: (label: string) => boolean, column: string, required: boolean,
  source: PurchaseOrderIssue['source'], line: number | null, issues: PurchaseOrderIssue[]): number {
  const positions = headers.flatMap((header, index) => matches(mappingLabel(header)) ? [index] : []);
  if (positions.length === 1) return positions[0];
  if (line !== null && (required || positions.length > 1)) {
    issues.push({ source, line, column, code: positions.length ? 'ambiguous-column' : 'missing-column',
      message: positions.length ? `Keep one unambiguous ${column} column.` : `Provide the ${column} column.` });
  }
  return -1;
}

export function readPurchaseOrderInventory({ filename, bytes }: PurchaseOrderSource) {
  const issues: PurchaseOrderIssue[] = [];
  const empty = { issues, locations: [], quantityBasis: null, rows: [], headers: [],
    columns: { sku: -1, current: -1, location: -1, reorder: -1, target: -1 } };
  if (!/\.csv$/i.test(filename)) {
    issues.push({ source: 'inventory', code: 'inventory-file-type', message: 'Choose a store inventory CSV.' });
    return empty;
  }
  const parsed = readCsvTable(bytes, filename, 'baseline', mappingLabel, { retainEmptyRecords: true });
  issues.push(...parsed.issues.map(issue => sourceIssue(issue, 'inventory')));
  const { headers, headerRow } = parsed;
  const aliases = headers.map(mappingLabel);
  const currentLabel = quantityHeaders.find(label => aliases.includes(label));
  const select = (column: string, matches: (label: string) => boolean, required = false) =>
    selectColumn(headers, matches, column, required, 'inventory', headerRow, issues);
  const columns = {
    sku: select('SKU', label => storeSkuHeaders.has(label), true),
    current: select('Available or On hand (current)', label => label === currentLabel, true),
    location: select('Location', label => label === 'location'),
    reorder: select('Reorder Point', label => label === 'reorder point'),
    target: select('Target Stock', label => label === 'target stock'),
  };
  const rows = parsed.rows.filter(row => row.cells.length === headers.length);
  const locations = new Set<string>();
  if (columns.location >= 0) {
    for (const { line, cells } of rows) {
      const location = cells[columns.location].value;
      if (location?.trim()) locations.add(location);
      else issues.push({ source: 'inventory', code: 'missing-location', line, column: headers[columns.location],
        message: 'This inventory row has no exact location.' });
    }
  }
  return { rows, headers, columns, issues, locations: [...locations], quantityBasis: headers[columns.current] ?? null };
}

export function readPurchaseOrderSupplier({ filename, bytes, sheetName }: PurchaseOrderSource & { sheetName?: string }) {
  const issues: PurchaseOrderIssue[] = [];
  const empty = { sheetNames: [] as string[], selectedSheet: null, issues, rows: [], headers: [],
    columns: { sku: -1, unitCost: -1, moq: -1, casePack: -1, leadTimeDays: -1, supplierSku: -1 },
    currencyIndexes: [] as number[], headerCurrency: null };
  const workbook = /\.xlsx$/i.test(filename);
  if (workbook && sheetName === undefined) {
    try {
      const sheetNames = listWorkbookSheets(bytes);
      issues.push({ source: 'supplier', code: 'supplier-worksheet-required', message: 'Choose the exact name of a visible supplier worksheet.' });
      return { ...empty, sheetNames };
    } catch (error) {
      const external = error instanceof Error && error.message === 'external-xlsx-relationship';
      issues.push({ source: 'supplier', code: external ? 'external-xlsx-relationship' : 'invalid-xlsx',
        message: external ? 'Save a local values-only workbook without external relationships.' : 'Choose a well-formed, supported XLSX supplier workbook.' });
      return empty;
    }
  }
  if (!workbook && sheetName !== undefined) {
    issues.push({ source: 'supplier', code: 'supplier-worksheet-invalid', message: 'Only supplier XLSX files accept a worksheet selection.' });
    return empty;
  }
  const parsed = parseSupplier(bytes, filename, sheetName === undefined ? undefined : { sheetName });
  const sheet = parsed.sheets[0];
  issues.push(...[...parsed.issues, ...(sheet?.issues ?? [])].map(issue => sourceIssue(issue, 'supplier')));
  const sheetNames = parsed.sheetNames ?? [];
  if (!sheet) return { ...empty, sheetNames };
  const { headers, headerRow, rows } = sheet;
  const select = (column: string, matches: (label: string) => boolean, required = false) =>
    selectColumn(headers, matches, column, required, 'supplier', headerRow, issues);
  const columns = {
    sku: select('SKU', label => storeSkuHeaders.has(label), true),
    unitCost: select('Unit Cost', label => unitCostHeader.test(label), true),
    moq: select('MOQ', label => label === 'moq'),
    casePack: select('Case Pack', label => label === 'case pack'),
    leadTimeDays: select('Lead Time Days', label => label === 'lead time days'),
    supplierSku: select('Supplier SKU', label => label === 'supplier sku'),
  };
  const unit = unitCostHeader.exec(mappingLabel(headers[columns.unitCost] ?? ''));
  const currencyIndexes = [...new Set([...currencyColumns(headers),
    ...headers.flatMap((header, index) => ['cost currency', 'wholesale currency'].includes(mappingLabel(header)) ? [index] : [])])];
  return { headers, rows, columns, issues, sheetNames, selectedSheet: sheet.selectedSheet ?? null, currencyIndexes,
    headerCurrency: (unit?.[2] ?? unit?.[3])?.toUpperCase() ?? null };
}

export function inspectPurchaseOrderInventory(source: PurchaseOrderSource): PurchaseOrderInventoryInspection {
  const { locations, quantityBasis, issues } = readPurchaseOrderInventory(source);
  return { locations, quantityBasis, issues };
}

export function inspectPurchaseOrderSupplier(source: PurchaseOrderSource & { sheetName?: string }): PurchaseOrderSupplierInspection {
  const { sheetNames, selectedSheet, issues } = readPurchaseOrderSupplier(source);
  return { sheetNames, selectedSheet, issues };
}
