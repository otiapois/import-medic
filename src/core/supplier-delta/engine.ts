import { sha256 } from '../audit/custody';
import { serializeCsv } from '../csv';
import { guardSpreadsheetCell } from '../formula-guard';
import { currencyColumns, mappingLabel, priceAliases, skuAliases } from '../shopify-price-diff/mapping';
import { amountDelta, currenciesAgree, readAmount, scaled, type Amount } from '../shopify-price-diff/prices';
import { parseSupplier } from '../shopify-price-diff/source';
import type { DiffIssue, SupplierSheet } from '../shopify-price-diff/types';
import { isScientific } from '../xlsx';
import { brandSignoffHtml, type SignoffBrand } from '../branding/signoff-brand';
import { renderSupplierDeltaSignOff } from './signoff';
import type { SupplierDeltaInspection, SupplierDeltaIssue, SupplierDeltaMapping, SupplierDeltaResult,
  SupplierDeltaRow, SupplierDeltaSide, SupplierDeltaSource, SupplierDeltaStatus } from './types';

export type { SupplierDeltaCustody, SupplierDeltaInspection, SupplierDeltaIssue, SupplierDeltaMapping,
  SupplierDeltaResult, SupplierDeltaRow, SupplierDeltaSide, SupplierDeltaSource, SupplierDeltaStatus } from './types';

const inventoryLabels = new Set(['inventory', 'inventory qty', 'inventory quantity', 'qty', 'quantity', 'stock', 'stock qty', 'stock quantity', 'on hand']);
const unitPattern = /^(?:[A-Z]{3}|[$????])$/;
const costWithUnit = /^(.+?)[\s_-]+\(?([A-Z]{3}|[$????])\)?$/i;
const inventoryPattern = /^\d{1,64}$/;
const utf8 = new TextEncoder();

function problem(code: string, message: string, details: Partial<SupplierDeltaIssue> = {}): SupplierDeltaIssue {
  return { code, message, row: null, rows: [], column: null, sku: null, side: null, blocking: true, ...details };
}

function fromSourceIssue({ code, message, row, rows, column, blocking }: DiffIssue): SupplierDeltaIssue {
  return problem(code, message, { row, rows, column, blocking });
}

function costLabel(header: string): { valid: boolean; currency: string | null } {
  if (priceAliases.has(mappingLabel(header)) || mappingLabel(header) === 'regular price') return { valid: true, currency: null };
  const suffix = costWithUnit.exec(header.trim());
  return suffix && (priceAliases.has(mappingLabel(suffix[1])) || mappingLabel(suffix[1]) === 'regular price')
    ? { valid: true, currency: suffix[2].toUpperCase() }
    : { valid: false, currency: null };
}

function sourceInspection(input: SupplierDeltaSource): { sheet: SupplierSheet | undefined; inspection: SupplierDeltaInspection } {
  const xlsx = /\.xlsx$/i.test(input.filename);
  const parsed = parseSupplier(input.bytes, input.filename,
    input.sheetName !== undefined ? { sheetName: input.sheetName } : xlsx ? { firstVisibleSheet: true } : undefined);
  const sheet = parsed.sheets[0];
  const headers = sheet?.headers ?? [];
  const candidate = (test: (header: string) => boolean) => headers.flatMap((header, index) => test(header) ? [index] : []);
  const skuColumns = candidate((header) => skuAliases.has(mappingLabel(header)) || mappingLabel(header) === 'product code/sku');
  const costColumns = candidate((header) => costLabel(header).valid);
  const inventoryColumns = candidate((header) => inventoryLabels.has(mappingLabel(header)));
  return {
    sheet,
    inspection: {
      sheetNames: parsed.sheetNames ?? [], selectedSheet: xlsx ? sheet?.name ?? null : null, headers,
      suggestions: { skuColumns, costColumns, inventoryColumns, mapping: {
        ...(skuColumns.length === 1 ? { skuColumn: skuColumns[0] } : {}),
        ...(costColumns.length === 1 ? { costColumn: costColumns[0] } : {}),
        inventoryColumn: inventoryColumns.length === 1 ? inventoryColumns[0] : null,
      } },
      issues: [...parsed.issues, ...sheet?.issues ?? []].map(fromSourceIssue), rowCount: sheet?.rows.length ?? 0,
    },
  };
}

export function inspectSupplierDeltaSource(input: SupplierDeltaSource): SupplierDeltaInspection {
  return sourceInspection(input).inspection;
}

interface Entry {
  line: number;
  sku: string | null;
  amount: Amount | null;
  inventory: bigint | null;
  units: string[];
  invalidInventory: boolean;
  invalidCurrency: boolean;
}

function project(input: SupplierDeltaSource, side: SupplierDeltaSide, overrides: SupplierDeltaMapping | undefined) {
  const { sheet, inspection } = sourceInspection(input);
  const { headers } = inspection;
  const issues: SupplierDeltaIssue[] = inspection.issues.map((entry) => ({ ...entry, side }));
  const entries = new Map<string, Entry[]>();
  const unidentified: Entry[] = [];
  const mapping = { ...inspection.suggestions.mapping, ...overrides };
  const { skuColumn, costColumn, inventoryColumn } = mapping;
  const available = (index: number | null | undefined): index is number =>
    typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < headers.length;
  const projection = { entries, unidentified, issues, inspection, mapping, membershipComplete: false };
  if (!sheet || !headers.length) return projection;
  for (const [column, name] of [[skuColumn, 'SKU'], [costColumn, 'Cost or price']] as const) {
    if (!available(column)) issues.push(problem('missing-column-mapping', 'Choose one available ' + name + ' column.', { column: name, side }));
  }
  if (inventoryColumn != null && !available(inventoryColumn)) {
    issues.push(problem('invalid-inventory-mapping', 'Choose an available inventory column or leave inventory unmapped.', { column: 'Inventory', side }));
  }
  const mapped = [skuColumn, costColumn, inventoryColumn].filter((index) => index != null);
  if (new Set(mapped).size !== mapped.length) {
    issues.push(problem('reused-column-mapping', 'Use distinct columns for SKU, cost, and inventory.', { side }));
    return projection;
  }
  if (!available(skuColumn) || !available(costColumn) || (inventoryColumn != null && !available(inventoryColumn))) {
    return projection;
  }
  const currencyPositions = new Set([
    ...currencyColumns(headers),
    ...headers.flatMap((header, index) => ['cost currency', 'wholesale currency'].includes(mappingLabel(header)) ? [index] : []),
  ]);
  const headerCurrency = costLabel(headers[costColumn]).currency;
  const watched = new Set([skuColumn, costColumn, ...(inventoryColumn == null ? [] : [inventoryColumn]), ...currencyPositions]);
  for (const { line, cells } of sheet.rows) {
    const skuCell = cells[skuColumn];
    const costCell = cells[costColumn];
    const rawSku = skuCell?.value ?? '';
    const sku = skuCell?.kind === 'text' && rawSku.trim() !== '' && !isScientific(rawSku) ? rawSku : null;
    const locations = { row: line, rows: [line], sku, side };
    for (const index of watched) {
      const cell = cells[index];
      if (cell?.kind === 'formula' && !cell.value) {
        issues.push(problem('formula-without-cached-value', 'This mapped Excel formula has no cached value.', { ...locations, column: headers[index], blocking: false }));
      }
    }
    if (sku === null) {
      issues.push(problem('blocked-invalid-sku', 'Use the exact original nonempty text SKU. Numeric Excel cells, formulas, and scientific notation cannot establish identity.',
        { ...locations, column: headers[skuColumn] }));
    }
    const rawCost = costCell?.value;
    const candidate = rawCost != null && (costCell.kind === 'text' || costCell.kind === 'number') && !costCell.scientific
      ? readAmount(rawCost) : null;
    const amount = candidate && candidate.units >= 0n ? candidate : null;
    if (amount === null) {
      issues.push(problem('blocked-invalid-cost', 'Use a valid nonnegative plain decimal cost or price value.', { ...locations, column: headers[costColumn] }));
    }
    const inventoryCell = inventoryColumn == null ? undefined : cells[inventoryColumn];
    const quantity = inventoryCell?.value ?? '';
    const inventory = (inventoryCell?.kind === 'text' || inventoryCell?.kind === 'number') && !inventoryCell.scientific && inventoryPattern.test(quantity)
      ? BigInt(quantity) : null;
    const invalidInventory = inventoryColumn != null && inventory === null;
    if (invalidInventory) {
      issues.push(problem('blocked-invalid-inventory', 'Use a nonnegative whole inventory quantity or leave inventory unmapped.',
        { ...locations, column: headers[inventoryColumn] }));
    }
    const units = [...new Set([amount?.currency, costCell?.currency, headerCurrency].filter((unit): unit is string => !!unit))];
    let invalidCurrency = false;
    for (const index of currencyPositions) {
      const cell = cells[index];
      const unit = cell?.value?.trim().toUpperCase() ?? '';
      if (unit === '' && cell?.kind !== 'formula' && cell?.kind !== 'unsupported') continue;
      if (cell?.kind === 'text' && unitPattern.test(unit)) units.push(unit);
      else invalidCurrency = true;
    }
    if (!currenciesAgree(units)) invalidCurrency = true;
    if (invalidCurrency) {
      issues.push(problem('blocked-currency', 'Correct the invalid or conflicting currency evidence on this row.', { ...locations, column: headers[costColumn] }));
    }
    const entry: Entry = { line, sku, amount, inventory, units, invalidInventory, invalidCurrency };
    if (sku === null) unidentified.push(entry);
    else {
      const group = entries.get(sku);
      if (group) group.push(entry);
      else entries.set(sku, [entry]);
    }
  }
  for (const [sku, group] of entries) {
    if (group.length < 2) continue;
    const lines = group.map(({ line }) => line);
    issues.push(problem('blocked-duplicate-sku', 'This exact SKU occurs more than once on this sheet.',
      { row: lines[0], rows: lines, column: headers[skuColumn], sku, side }));
  }
  projection.membershipComplete = unidentified.length === 0 && !inspection.issues.some(({ blocking }) => blocking);
  return projection;
}

function displayDelta(before: Amount, after: Amount): string {
  const exact = amountDelta(before, after);
  const [whole, fraction = ''] = exact.split('.');
  return (!exact.startsWith('-') && exact !== '0' ? '+' : '') + whole + '.' + fraction.padEnd(2, '0');
}

function displayPercent(before: bigint, after: bigint): string | null {
  if (before === 0n) return after === 0n ? '0.00' : null;
  const change = after - before;
  const absolute = change < 0n ? -change : change;
  const hundredths = (absolute * 20_000n + before) / (2n * before);
  return (change < 0n ? '-' : change > 0n ? '+' : '') + (hundredths / 100n).toString() + '.' + (hundredths % 100n).toString().padStart(2, '0');
}

function classify(previous: Entry | undefined, next: Entry | undefined, duplicate: boolean): SupplierDeltaRow {
  const before = previous?.amount ?? null;
  const after = next?.amount ?? null;
  const previousInventory = previous?.inventory ?? null;
  const newInventory = next?.inventory ?? null;
  const sku = previous?.sku ?? next?.sku ?? null;
  const units = [...previous?.units ?? [], ...next?.units ?? []];
  let status: SupplierDeltaStatus;
  let delta: string | null = null;
  let deltaPercent: string | null = null;
  if (duplicate) status = 'blocked-duplicate-sku';
  else if (sku === null) status = 'blocked-invalid-sku';
  else if (previous && !before || next && !after) status = 'blocked-invalid-cost';
  else if (previous?.invalidCurrency || next?.invalidCurrency || !currenciesAgree(units)) status = 'blocked-currency';
  else if (previous?.invalidInventory || next?.invalidInventory) status = 'blocked-invalid-inventory';
  else if (!before) status = 'added-sku';
  else if (!after) status = 'removed-sku';
  else {
    const [oldUnits, newUnits] = scaled(before, after);
    status = oldUnits === newUnits ? 'unchanged' : oldUnits < newUnits ? 'cost-increased' : 'cost-decreased';
    delta = displayDelta(before, after);
    deltaPercent = displayPercent(oldUnits, newUnits);
  }
  return { sku, status, previousRow: previous?.line ?? null, newRow: next?.line ?? null,
    previousCost: before?.text ?? null, newCost: after?.text ?? null, delta, deltaPercent,
    previousInventory: previousInventory?.toString() ?? null, newInventory: newInventory?.toString() ?? null,
    inventoryDelta: previousInventory === null || newInventory === null || duplicate ? null : (newInventory - previousInventory).toString(),
    currency: units.find((unit) => /^[A-Z]{3}$/.test(unit)) ?? units[0] ?? null };
}

function toCsv(rows: readonly SupplierDeltaRow[]): string {
  const headers = ['SKU', 'Status', 'Previous row', 'New row', 'Previous cost', 'New cost', 'Currency', 'Cost delta', 'Cost change %',
    'Previous inventory', 'New inventory', 'Inventory delta'];
  return serializeCsv(headers, rows.map((row) => [
    guardSpreadsheetCell(row.sku ?? ''), row.status, row.previousRow?.toString() ?? '', row.newRow?.toString() ?? '',
    row.previousCost ?? '', row.newCost ?? '', row.currency ?? '', row.delta ?? '', row.deltaPercent ?? '',
    row.previousInventory ?? '', row.newInventory ?? '', row.inventoryDelta ?? '',
  ]), 'supplier-delta');
}

export async function buildSupplierDelta(previous: SupplierDeltaSource, next: SupplierDeltaSource,
  mappings?: { previous?: SupplierDeltaMapping; next?: SupplierDeltaMapping }, branding?: SignoffBrand): Promise<SupplierDeltaResult> {
  const hashes = Promise.all([sha256(previous.bytes), sha256(next.bytes)]);
  const prior = project(previous, 'previous', mappings?.previous);
  const current = project(next, 'next', mappings?.next);
  const issues: SupplierDeltaIssue[] = [...prior.issues, ...current.issues];
  const evidence = new Set<string>();
  for (const group of [prior.entries, current.entries]) {
    for (const entries of group.values()) {
      for (const entry of entries) for (const unit of entry.units) evidence.add(unit);
    }
  }
  if (!currenciesAgree([...evidence])) {
    issues.push(problem('currency-conflict', 'The mapped sources must use a single comparable currency. Exchange rates are unavailable in Supplier Delta.'));
  }
  const rows: SupplierDeltaRow[] = [];
  const counts: SupplierDeltaResult['counts'] = { 'cost-increased': 0, 'cost-decreased': 0, unchanged: 0, 'added-sku': 0, 'removed-sku': 0,
    'blocked-duplicate-sku': 0, 'blocked-invalid-cost': 0, 'blocked-invalid-sku': 0, 'blocked-invalid-inventory': 0, 'blocked-currency': 0 };
  let maxHike: bigint | null = null;
  let maxHikePercent: string | null = null;
  for (const sku of new Set([...prior.entries.keys(), ...current.entries.keys()])) {
    const before = prior.entries.get(sku) ?? [];
    const after = current.entries.get(sku) ?? [];
    const row = classify(before[0], after[0], before.length > 1 || after.length > 1);
    if ((row.status === 'added-sku' && !prior.membershipComplete) || (row.status === 'removed-sku' && !current.membershipComplete)) continue;
    if (row.status === 'cost-increased' && row.deltaPercent !== null) {
      const units = BigInt(row.deltaPercent.replace('.', ''));
      if (maxHike === null || units > maxHike) {
        maxHike = units;
        maxHikePercent = row.deltaPercent.slice(1);
      }
    }
    rows.push(row);
    counts[row.status]++;
  }
  for (const row of [...prior.unidentified.map((entry) => classify(entry, undefined, false)),
    ...current.unidentified.map((entry) => classify(undefined, entry, false))]) {
    rows.push(row);
    counts[row.status]++;
  }
  const [previousSha256, newSha256] = await hashes;
  const custody: SupplierDeltaResult['custody'] = { previousSha256, newSha256 };
  const status = issues.some(({ blocking }) => blocking) ? 'blocked' : 'ready';
  const details = (input: SupplierDeltaSource, projection: typeof prior) => ({
    filename: input.filename, bytes: input.bytes.byteLength, selectedSheet: projection.inspection.selectedSheet,
    headers: projection.inspection.headers, mapping: projection.mapping,
  });
  const sources = { previous: details(previous, prior), next: details(next, current) };
  let deltaCsv: string | null = null;
  let signOffHtml: string | null = null;
  if (status === 'ready') {
    deltaCsv = toCsv(rows);
    custody.deltaCsvSha256 = await sha256(utf8.encode(deltaCsv));
    signOffHtml = renderSupplierDeltaSignOff(sources, rows, counts, maxHikePercent, custody, branding);
    custody.signOffHtmlSha256 = await sha256(utf8.encode(signOffHtml));
  }
  const auditJson = JSON.stringify({ version: 1, status, sources, counts, maxHikePercent, rows, issues, custody }, null, rows.length > 10_000 ? 0 : 2) + '\n';
  return { status, rows, issues, counts, maxHikePercent, deltaCsv, auditJson, signOffHtml, custody };
}

export async function brandSupplierDeltaReports(result: SupplierDeltaResult, branding?: SignoffBrand) {
  const { signOffHtml, auditJson, custody } = result;
  if (branding === undefined || signOffHtml === null) return { signOffHtml, auditJson, signOffHtmlSha256: custody.signOffHtmlSha256 };
  const html = brandSignoffHtml(signOffHtml, branding);
  const signOffHtmlSha256 = await sha256(utf8.encode(html));
  const audit = JSON.parse(auditJson) as { custody: SupplierDeltaResult['custody'] };
  audit.custody.signOffHtmlSha256 = signOffHtmlSha256;
  return { signOffHtml: html, auditJson: JSON.stringify(audit, null, result.rows.length > 10_000 ? 0 : 2) + '\n', signOffHtmlSha256 };
}
