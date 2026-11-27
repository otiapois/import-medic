import type { PriceCustody } from '../audit/custody';
import { decodeCsv, parseCsv, serializeCsv, serializeCsvRecords } from '../csv';
import { bigCommerceWrites } from '../bigcommerce-price-diff/safety';
import { bigCommerceFileLimit, bigCommerceIdentityHeaders, bigCommerceKey, bigCommerceStockHeader, bigIdHeader, bigNameHeader, bigPriceHeader, bigSaleHeader, bigTypeHeader } from '../bigcommerce-price-diff/source';
import { wooOutputHeaders, wooRegularHeader, wooSaleHeader, wooStockHeader } from '../woocommerce-price-diff/source';
import { guardSpreadsheetCell, guardSpreadsheetRow } from '../formula-guard';
import type { FormulaGuardAudit, FormulaGuardCell } from '../formula-guard';
import { compareAtHeader, inventoryHeader, optionNames, optionValues, priceHeader, shopifyIdentityHeaders, skuHeader, variantKey } from './source';
import { cellValue } from './types';
import type { Baseline, DiffIssue, DiffRow, PriceDiffResult, RollbackVerification, RowResolution, SourceRow, SupplierSheet, Verification } from './types';
import type { ResolvedMapping } from './mapping';
import type { PricingRule } from './pricing-rules';

type NativeDiffRow = Pick<DiffRow, 'status' | 'baselineRow' | 'handle' | 'bigcommerce' | 'oldPrice' | 'newPrice' |
  'oldCompareAtPrice' | 'newCompareAtPrice' | 'oldInventoryQty' | 'newInventoryQty'>;
type NativeColumns = { identity: string[]; targets: string[] };

function outputColumns(baseline: Baseline, compareAt: boolean, inventory: boolean, bigWrites: ReadonlyMap<number, ReadonlyMap<string, string>>): NativeColumns {
  if (baseline.platform === 'bigcommerce') {
    const targets = new Set<string>();
    for (const record of bigWrites.values()) for (const column of record.keys()) targets.add(column);
    const stock = bigCommerceStockHeader(baseline);
    return { identity: bigCommerceIdentityHeaders(baseline), targets: [bigPriceHeader, bigSaleHeader, ...(stock ? [stock] : [])].filter(column => targets.has(column)) };
  }
  if (baseline.platform === 'woocommerce') {
    const headers = wooOutputHeaders(compareAt, inventory);
    const price = headers.indexOf(wooRegularHeader);
    return { identity: headers.slice(0, price), targets: headers.slice(price) };
  }
  const market = baseline.market;
  const sale = market ? market.compareAtHeader : compareAtHeader;
  return {
    identity: market ? shopifyIdentityHeaders.filter(column => baseline.columns.has(column)) : shopifyIdentityHeaders,
    targets: [market?.priceHeader ?? priceHeader, ...(compareAt && sale ? [sale] : []), ...(inventory ? [inventoryHeader] : [])],
  };
}

export function verifiedExports(baseline: Baseline, rows: NativeDiffRow[], mapCompareAt: boolean, mapInventory: boolean, formulaGuard: boolean,
  onReplay?: (done: number, total: number) => void, columns?: NativeColumns): {
  updateBytes: Uint8Array<ArrayBuffer> | null;
  rollbackBytes: Uint8Array<ArrayBuffer> | null;
  verification: Verification;
  rollbackVerification: RollbackVerification;
  outputLines: ReadonlySet<number>;
  blockedCells: readonly FormulaGuardCell[];
} {
  const updates = new Map(rows.filter((row) => row.status === 'Updated').map((row) => [row.baselineRow, row]));
  const woo = baseline.platform === 'woocommerce';
  const bigcommerce = baseline.platform === 'bigcommerce';
  const stock = bigCommerceStockHeader(baseline);
  const bigWrites = new Map<number, ReadonlyMap<string, string>>();
  if (bigcommerce) for (const row of updates.values()) bigWrites.set(row.baselineRow!, bigCommerceWrites(row, stock));
  const handles = new Set([...updates.values()].map((row) => row.bigcommerce?.productId ?? row.handle));
  const source = baseline.variants.filter(variant => woo ? updates.has(variant.source.line) : handles.has(variant.bigcommerce?.productId ?? variant.handle));
  const { identity, targets } = columns ?? outputColumns(baseline, mapCompareAt, mapInventory, bigWrites);
  const headers = [...identity, ...targets];
  const sourcePositions = headers.map((column) => baseline.columns.get(column));
  const priceIndex = headers.indexOf(woo ? wooRegularHeader : baseline.market?.priceHeader ?? priceHeader);
  const compareAtIndex = headers.indexOf(woo ? wooSaleHeader : baseline.market?.compareAtHeader ?? compareAtHeader);
  const inventoryIndex = headers.indexOf(woo ? wooStockHeader : inventoryHeader);
  const blockedCells: FormulaGuardCell[] = [];
  const rollbackRows = source.map(({ source: row }) => sourcePositions.map((position, index) =>
    bigcommerce && index >= identity.length && !bigWrites.get(row.line)?.has(headers[index]) ? '' : cellValue(row, position) ?? ''));
  const updateRows = rollbackRows.map((original, index) => {
    const patch = updates.get(source[index].source.line);
    const cells = [...original];
    if (bigcommerce) {
      const writes = bigWrites.get(source[index].source.line);
      for (let column = identity.length; column < headers.length; column++) cells[column] = writes?.get(headers[column]) ?? '';
    } else if (patch) {
      if (priceIndex !== -1) cells[priceIndex] = patch.newPrice!;
      if (mapCompareAt) cells[compareAtIndex] = patch.newCompareAtPrice ?? original[compareAtIndex];
      if (mapInventory) cells[inventoryIndex] = patch.newInventoryQty ?? original[inventoryIndex];
    }
    return cells;
  });
  const empty = {
    updateBytes: null, rollbackBytes: null, verification: { checked: false, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 },
    rollbackVerification: { checked: false, restoredVariants: 0 }, outputLines: new Set<number>(), blockedCells,
  };
  if (formulaGuard) {
    for (const transfer of [updateRows, rollbackRows]) {
      transfer.forEach((cells, index) => guardSpreadsheetRow(cells, headers, source[index].source.line, blockedCells));
      if (blockedCells.length) return empty;
    }
  }
  const encode = (records: string[][]) => new TextEncoder().encode(serializeCsv(headers, records, bigcommerce ? 'bigcommerce' : woo ? 'woocommerce' : 'shopify-products'));
  const updateBytes = encode(updateRows);
  const rollbackBytes = encode(rollbackRows);
  if (bigcommerce && (updateBytes.length > bigCommerceFileLimit || rollbackBytes.length > bigCommerceFileLimit)) return empty;
  const original = baseline.rows.map(({ cells }) => cells.map(({ value }) => value));
  const matrix = original.map((row) => [...row]);
  const rowIndices = new Map(baseline.rows.map(({ line }, index) => [line, index]));
  const handleIndex = headers.indexOf(bigcommerce ? bigIdHeader : woo ? 'ID' : 'Handle');
  const typeIndex = headers.indexOf(bigTypeHeader);
  const options = optionValues.map((column) => headers.indexOf(column));
  const targetPositions = new Set(targets.map(column => baseline.columns.get(column)));
  const scoped = new Map(source.map(({ bigcommerce, handle, options, source }) => [
    bigcommerce ? bigCommerceKey(bigcommerce.type, bigcommerce.id) : woo ? handle : variantKey(handle, options), source,
  ]));
  const scopedKeys = [...scoped.keys()];

  // Legacy BigCommerce imports retain stored values when a target cell is blank.
  // Replay the actual UTF-8 payload over the complete original matrix.
  function replay(bytes: Uint8Array, restoring: boolean) {
    const decoded = decodeCsv(bytes);
    const [head, ...records] = parseCsv(decoded.text).records;
    let valuesMatch = decoded.encoding === 'utf-8' && !head?.parseError && head?.cells.length === headers.length &&
      headers.every((header, index) => head.cells[index] === header) && records.length === source.length;
    let nonTargetFieldsChanged = 0;
    const brokenGroups = new Set<string>();
    const seen = new Set<string>();
    const offset = restoring ? source.length : 0;
    for (const [index, { cells, parseError }] of records.entries()) {
      if (onReplay && index > 0 && (index & 2047) === 0) onReplay(offset + index, 2 * source.length);
      if (parseError || cells.length !== headers.length) {
        valuesMatch = false;
        continue;
      }
      const handle = cells[handleIndex];
      const key = bigcommerce ? bigCommerceKey(cells[typeIndex], handle) : woo ? handle : variantKey(handle, options.map((position) => cells[position]));
      const record = scoped.get(key);
      if (!record || seen.has(key) || key !== scopedKeys[index]) {
        brokenGroups.add(handle);
        if (source[index]) brokenGroups.add(source[index].handle);
        continue;
      }
      seen.add(key);
      const row = matrix[rowIndices.get(record.line)!];
      const approved = restoring ? undefined : updates.get(record.line);
      for (const [outgoing, value] of cells.entries()) {
        const position = sourcePositions[outgoing];
        const baselineValue = cellValue(record, position) ?? '';
        const expected = bigcommerce && outgoing >= identity.length
          ? (bigWrites.get(record.line)?.has(headers[outgoing]) ? restoring ? baselineValue : bigWrites.get(record.line)!.get(headers[outgoing]) : '')
          : outgoing === priceIndex && approved ? approved.newPrice :
          outgoing === compareAtIndex && approved ? approved.newCompareAtPrice ?? baselineValue :
          outgoing === inventoryIndex && approved ? approved.newInventoryQty ?? baselineValue : baselineValue;
        if (value !== expected) valuesMatch = false;
        if (bigcommerce && outgoing >= identity.length && value === '') continue;
        if (position === undefined) {
          if (value !== '') nonTargetFieldsChanged++;
        } else {
          row[position] = value;
        }
      }
    }
    onReplay?.(offset + source.length, 2 * source.length);
    for (const [index, key] of scopedKeys.entries()) if (!seen.has(key)) brokenGroups.add(source[index].handle);
    return { valuesMatch, nonTargetFieldsChanged, brokenVariantGroups: brokenGroups.size };
  }

  const update = replay(updateBytes, false);
  let { nonTargetFieldsChanged } = update;
  for (const [row, before] of original.entries()) {
    for (const [column, value] of before.entries()) {
      if (!targetPositions.has(column) && matrix[row][column] !== value) nonTargetFieldsChanged++;
    }
  }
  const verification = { checked: true, nonTargetFieldsChanged, brokenVariantGroups: update.brokenVariantGroups };
  if (!update.valuesMatch || update.brokenVariantGroups || nonTargetFieldsChanged) return { ...empty, verification };

  const rollback = replay(rollbackBytes, true);
  const restored = rollback.valuesMatch && !rollback.brokenVariantGroups && !rollback.nonTargetFieldsChanged &&
    original.every((before, row) => before.every((value, column) => matrix[row][column] === value));
  const rollbackVerification = { checked: true, restoredVariants: restored ? scoped.size : 0 };
  if (!restored) return { ...empty, verification, rollbackVerification };
  return { updateBytes, rollbackBytes, verification, rollbackVerification, outputLines: new Set(source.map(({ source }) => source.line)), blockedCells };
}


const plainPercent = /^-?\d+(?:\.\d+)?$/;
const auditDisplay = (value: string | null): string => guardSpreadsheetCell(value ?? '').replace(/\0/g, '\\u0000');
const auditSource = (row: SourceRow | undefined) => row?.cells ?? null;

export interface AuditSupplier {
  supplierId: string;
  label: string;
  filename: string;
  sheet: SupplierSheet;
  mapping: ResolvedMapping | null;
  resolutions: Readonly<Record<number, RowResolution>>;
  pricingRule?: PricingRule;
}

export function createAudit(
  baseline: Baseline, suppliers: readonly AuditSupplier[], rows: DiffRow[], issues: DiffIssue[],
  result: Pick<PriceDiffResult, 'status' | 'verification' | 'rollbackVerification' | 'inventoryEnabled' | 'overlapCount' | 'conflictCount' | 'conflictPolicy'>,
  exported: boolean, formulaGuard: FormulaGuardAudit, includeCompareAt: boolean, custody?: PriceCustody,
): { auditCsv: string; auditJson: string } {
  const { status, verification, rollbackVerification, inventoryEnabled, overlapCount, conflictCount, conflictPolicy } = result;
  const first = suppliers[0];
  const mapping = first?.mapping ?? null;
  const pricingRule = first?.pricingRule;
  const woo = baseline.platform === 'woocommerce';
  const bigcommerce = baseline.platform === 'bigcommerce';
  const sale = woo || bigcommerce;
  const stock = bigCommerceStockHeader(baseline);
  const bigWrites = new Map<number, ReadonlyMap<string, string>>();
  if (bigcommerce && exported) for (const row of rows) if (row.status === 'Updated') bigWrites.set(row.baselineRow!, bigCommerceWrites(row, stock));
  const layout = outputColumns(baseline, includeCompareAt, inventoryEnabled, bigWrites);
  const headers = exported ? [...layout.identity, ...layout.targets] : [];
  const columns = {
    included: headers,
    omittedBaselineHeaders: baseline.headers.filter((header, position) =>
      !headers.some((exported) => baseline.columns.get(exported) === position)),
    compareAtMapped: suppliers.some(({ mapping }) => mapping?.compareAt != null),
    ...(suppliers.some(({ mapping }) => mapping?.compareAtAutomatic) ? { compareAtAutomatic: true } : {}),
    ...(inventoryEnabled ? { inventoryMapped: true } : {}),
  };
  const baselineSource = new Map(baseline.rows.map((row) => [row.line, row]));
  const supplierSource = new Map(suppliers.map(({ supplierId, sheet, resolutions }) => [
    supplierId, { rows: new Map(sheet.rows.map((row) => [row.line, row])), resolutions },
  ]));
  const issueIndices = new Map(issues.map((entry, index) => [entry, index]));
  const sharedContenders = new Map(issues.flatMap(({ supplierContenders }, issueIndex) =>
    supplierContenders && supplierContenders.length > 40 ? [[supplierContenders, issueIndex] as const] : []));
  const rowReport = rows.map((row) => {
    const baselineRow = row.baselineRow !== null ? baselineSource.get(row.baselineRow) : undefined;
    const source = row.supplierId === undefined && suppliers.length === 1
      ? supplierSource.get(first.supplierId) : row.supplierId === undefined ? undefined : supplierSource.get(row.supplierId);
    const supplierRow = row.supplierRow !== null ? source?.rows.get(row.supplierRow) : undefined;
    if (baselineRow) baselineSource.delete(baselineRow.line);
    if (supplierRow) source?.rows.delete(supplierRow.line);
    const contenderIssueIndex = row.supplierContenders ? sharedContenders.get(row.supplierContenders) : undefined;
    return {
      ...row,
      ...(contenderIssueIndex === undefined ? {} : { supplierContenders: undefined, supplierContendersIssueIndex: contenderIssueIndex }),
      issues: row.issues.map((entry) => entry.rows.length > 1 || sharedContenders.has(entry.supplierContenders!) ? { issueIndex: issueIndices.get(entry)! } : entry),
      baselineCells: auditSource(baselineRow),
      supplierCells: auditSource(supplierRow),
      resolution: row.supplierRow !== null ? source?.resolutions[row.supplierRow] ?? null : null,
    };
  });
  const preservedBaselineRows = [...baselineSource.values()];
  const unclassifiedSupplierRows = suppliers.flatMap(({ supplierId, label }) =>
    [...supplierSource.get(supplierId)!.rows.values()].map((row) => suppliers.length > 1
      ? { ...row, supplierId, supplierSource: label, resolution: supplierSource.get(supplierId)!.resolutions[row.line] ?? null }
      : row));
  const summary = {
    status, ...(baseline.platform ? { platform: baseline.platform } : {}), ...(baseline.market ? { market: baseline.market } : {}),
    columns, mapping, pricingRule: pricingRule ?? { mode: 'direct' }, verification, rollbackVerification,
    baseline: { name: baseline.name, headerRow: baseline.headerRow, headers: baseline.headers },
    supplier: first ? { name: first.sheet.name, headerRow: first.sheet.headerRow, headers: first.sheet.headers,
      ...(first.sheet.selectedSheet === undefined ? {} : { selectedSheet: first.sheet.selectedSheet }) } : null,
    ...(suppliers.length > 1 ? {
      suppliers: suppliers.map(({ supplierId, label, filename, sheet, mapping, pricingRule }) => ({
        supplierId, label, filename, worksheet: sheet.name, headers: sheet.headers, headerRow: sheet.headerRow, mapping,
        ...(sheet.selectedSheet === undefined ? {} : { selectedSheet: sheet.selectedSheet }),
        pricingRule: pricingRule ?? { mode: 'direct' },
      })),
      overlapCount, conflictCount, conflictPolicy,
    } : {}),
  };
  const guardSummary = { enabled: formulaGuard.enabled, neutralizedCount: formulaGuard.neutralized.length, blockedCount: formulaGuard.blocked.length };
  const hasFx = suppliers.some(({ pricingRule }) => pricingRule?.fx !== undefined);
  const hasTiers = suppliers.some(({ pricingRule }) => pricingRule?.mode === 'tiered-brackets');
  const hasLandedCosts = rows.some(({ landedCost }) => landedCost !== undefined);
  const optionalHeaders = sale ? ['Old Sale Price', 'New Sale Price', 'Raw Supplier Regular Price', 'Raw Supplier Sale Price'] :
    ['Old Compare At Price', 'New Compare At Price', 'Raw Supplier Price', 'Raw Supplier Compare At Price'];
  const identityHeaders = bigcommerce ? [bigIdHeader, bigTypeHeader, bigNameHeader] : woo ? ['ID', 'Type', 'Parent'] : ['Handle'];
  const displayHeaders = ['Status', 'SKU', ...identityHeaders, ...(baseline.market ? ['Market'] : []), 'Baseline Row', 'Supplier Row',
    woo ? 'Old Regular Price' : 'Old Price', woo ? 'New Regular Price' : 'New Price', 'Delta %',
    ...optionalHeaders, 'Price Output', sale ? 'Sale Price Output' : 'Compare At Output', 'Original Baseline Cells (JSON)', 'Original Supplier Cells (JSON)', 'Computed Price',
    'Supplier Source', 'Supplier Filename', 'Supplier Worksheet', 'Supplier Contenders (JSON)',
    ...(inventoryEnabled ? (sale ? ['Old Stock', 'New Stock', 'Raw Supplier Stock', 'Stock Output'] :
      ['Old Inventory Qty', 'New Inventory Qty', 'Raw Supplier Inventory Qty', 'Inventory Output']) : []),
    ...(hasLandedCosts ? ['Landed Supplier Cost'] : []),
    ...(hasTiers ? ['Matched Tier'] : []),
    ...(hasFx ? ['FX Applied'] : []), 'Review and Resolution (JSON)'];
  const summaryRow = (label: string, details: unknown, baselineRow: number | string = '', supplierRow: number | string = '', before: unknown = null, after: unknown = null, supplierSource: string | null = null) => [
    label, '', ...identityHeaders.map(() => ''), ...(baseline.market ? [auditDisplay(baseline.market.name)] : []),
    String(baselineRow), String(supplierRow), '', '', '', '', '', '', '', 'omitted', 'omitted', JSON.stringify(before), JSON.stringify(after), '',
    auditDisplay(supplierSource), '', '', '',
    ...(inventoryEnabled ? ['', '', '', 'omitted'] : []), ...(hasLandedCosts ? [''] : []), ...(hasTiers ? [''] : []), ...(hasFx ? [''] : []), JSON.stringify(details),
  ];
  return {
    get auditJson() {
      return JSON.stringify({ ...summary, custody, formulaGuard, issues, rows: rowReport, preservedBaselineRows, unclassifiedSupplierRows }, null, rows.length > 10_000 ? 0 : 2);
    },
    get auditCsv() {
      function* records() {
        yield summaryRow('Run summary', { ...summary, issues, formulaGuard: guardSummary });
        for (const row of rowReport) yield [
          row.status, auditDisplay(row.sku),
          ...(bigcommerce ? [auditDisplay(row.bigcommerce?.id ?? null), auditDisplay(row.bigcommerce?.type ?? null), auditDisplay(row.bigcommerce?.name ?? null)] :
            woo ? [auditDisplay(row.woocommerce?.id ?? null), auditDisplay(row.woocommerce?.type ?? null), auditDisplay(row.woocommerce?.parent ?? null)] : [auditDisplay(row.handle)]),
          ...(baseline.market ? [auditDisplay(baseline.market.name)] : []),
          String(row.baselineRow ?? ''), String(row.supplierRow ?? ''),
          auditDisplay(row.oldPrice), auditDisplay(row.newPrice), row.deltaPercent && plainPercent.test(row.deltaPercent) ? row.deltaPercent : '',
          auditDisplay(row.oldCompareAtPrice), auditDisplay(row.newCompareAtPrice), auditDisplay(row.supplierPrice), auditDisplay(row.supplierCompareAtPrice),
          row.priceOutput, row.compareAtOutput, JSON.stringify(row.baselineCells), JSON.stringify(row.supplierCells),
          auditDisplay(row.computedPrice),
          auditDisplay(row.supplierSource ?? null), auditDisplay(row.supplierFilename ?? null), auditDisplay(row.supplierWorksheet ?? null),
          row.supplierContenders ? JSON.stringify(row.supplierContenders) : row.supplierContendersIssueIndex === undefined ? '' : JSON.stringify({ issueIndex: row.supplierContendersIssueIndex }),
          ...(inventoryEnabled ? [auditDisplay(row.oldInventoryQty ?? null), auditDisplay(row.newInventoryQty ?? null),
            auditDisplay(row.supplierInventoryQty ?? null), row.inventoryOutput ?? 'omitted'] : []),
          ...(hasLandedCosts ? [auditDisplay(row.landedCost ?? null)] : []),
          ...(hasTiers ? [auditDisplay(row.matchedTier ?? null)] : []),
          ...(hasFx ? [row.fxApplied ? `${row.fxApplied.sourceCurrency} -> ${row.fxApplied.storeCurrency} @ ${row.fxApplied.fxRate}` : ''] : []),
          JSON.stringify({ issues: row.issues, resolution: row.resolution }),
        ];
        for (const row of preservedBaselineRows) yield summaryRow('Preserved baseline record', null, row.line, '', row.cells);
        for (const row of unclassifiedSupplierRows) yield summaryRow('Unclassified supplier record', 'resolution' in row ? row.resolution : null,
          '', row.line, null, row.cells, 'supplierSource' in row ? row.supplierSource : null);
        for (const { row, column, before, after } of formulaGuard.blocked) yield summaryRow('Formula guard blocked cell', { column, before, after }, row);
      }
      const parts = [serializeCsv(displayHeaders, [], 'price-audit')];
      let page: string[][] = [];
      for (const record of records()) {
        page.push(record);
        if (page.length === 1024) {
          parts.push(serializeCsvRecords(page, 'price-audit'));
          page = [];
        }
      }
      if (page.length) parts.push(serializeCsvRecords(page, 'price-audit'));
      return parts.join('\r\n');
    },
  };
}
