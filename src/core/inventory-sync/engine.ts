import { sha256 } from '../audit/custody';
import { isScientific } from '../xlsx';
import { makeInventoryPair } from './output';
import { renderInventorySignoff } from './signoff';
import { currentHeader, inventoryIdentity, readInventoryBaseline, readInventorySupplier } from './source';
import type {
  InventoryBaselineInspection, InventoryCustody, InventoryIssue, InventoryOffer, InventorySource,
  InventorySupplierInspection, InventorySupplierSource, InventorySyncOptions, InventorySyncResult, InventorySyncRow, InventoryTotals,
} from './types';

export type * from './types';

export function inspectInventoryBaseline(source: InventorySource): InventoryBaselineInspection {
  const { locations, issues } = readInventoryBaseline(source);
  return { locations, issues };
}

export function inspectInventorySupplier(source: InventorySupplierSource): InventorySupplierInspection {
  const { headers, sheetNames, issues } = readInventorySupplier(source);
  return { headers, sheetNames, issues };
}

const nonnegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0;
const exactQuantity = (value: string, supplier: boolean) => {
  if (!(supplier ? /^\d+$/ : /^[+-]?\d+$/).test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
};

function readOffers(
  parsed: ReturnType<typeof readInventorySupplier>[], suppliers: readonly InventorySupplierSource[], issues: InventoryIssue[],
) {
  const offers = new Map<string, InventoryOffer[]>();
  const conflicts = new Set<string>();
  for (const [supplierIndex, supplier] of parsed.entries()) {
    issues.push(...supplier.issues.map(issue => ({ ...issue, supplierIndex })));
    const { headers, headerLine, rows } = supplier;
    if (!headers.length) continue;
    const mapping = suppliers[supplierIndex].mapping;
    const isColumn = (position: number) => Number.isSafeInteger(position) && position >= 0 && !!headers[position]?.trim();
    if (!mapping || !isColumn(mapping.skuColumn) || !isColumn(mapping.quantityColumn) || mapping.skuColumn === mapping.quantityColumn) {
      issues.push({ code: 'supplier-mapping-required', source: 'supplier', supplierIndex, line: headerLine,
        message: 'Choose two distinct source columns explicitly for the supplier SKU and quantity.' });
      continue;
    }
    const { skuColumn, quantityColumn } = mapping;
    for (const { line, cells } of rows) {
      if (cells.slice(headers.length).some(cell => cell.kind === 'formula' || cell.value !== null && cell.value !== '')) {
        issues.push({ code: 'row-width', source: 'supplier', supplierIndex, line,
          message: 'This worksheet row includes cells beyond the selected header row.' });
      }
      const skuCell = cells[skuColumn];
      const sku = skuCell?.value ?? '';
      const scientific = isScientific(sku) || skuCell?.scientific === true;
      const validSku = skuCell?.kind === 'text' && sku.trim() !== '' && !sku.includes('\0') && !scientific;
      if (!validSku) {
        issues.push({ code: scientific ? 'scientific-sku' : 'invalid-supplier-sku', source: 'supplier', supplierIndex, line, column: headers[skuColumn],
          value: sku, message: 'Use an exact nonempty text SKU. Store spreadsheet SKU cells as text to preserve leading zeros.' });
      }
      const quantity = cells[quantityColumn];
      const rawQuantity = quantity?.value ?? '';
      const units = quantity?.kind === 'text' || (quantity?.kind === 'number' && !quantity.currency && !quantity.scientific)
        ? exactQuantity(rawQuantity, true) : null;
      if (units === null) {
        issues.push({ code: 'invalid-supplier-quantity', source: 'supplier', supplierIndex, line, sku, column: headers[quantityColumn],
          value: rawQuantity, message: 'Use a literal nonnegative whole-number quantity within the supported exact integer range.' });
      }
      if (!validSku || units === null) continue;
      const offer = { supplierIndex, line, quantity: units, rawQuantity };
      const entries = offers.get(sku);
      if (entries) entries.push(offer);
      else offers.set(sku, [offer]);
    }
  }
  for (const [sku, entries] of offers) {
    if (new Set(entries.map(({ supplierIndex }) => supplierIndex)).size !== entries.length) {
      conflicts.add(sku);
      issues.push({ code: 'duplicate-supplier-sku', source: 'supplier', sku, supplierIndex: entries[0].supplierIndex, line: entries[0].line,
        offers: entries, message: 'A supplier lists this SKU more than once. Resolve the duplicates in the source before retrying.' });
    }
    if (entries.some(({ quantity }) => quantity !== entries[0].quantity)) {
      conflicts.add(sku);
      issues.push({ code: 'supplier-quantity-conflict', source: 'supplier', sku, supplierIndex: entries[0].supplierIndex, line: entries[0].line,
        offers: entries, message: 'The supplier rows disagree on the quantity for this SKU. Resolve the source values before retrying.' });
    }
  }
  return { offers, conflicts };
}

export async function buildInventorySync(
  baseline: InventorySource, suppliers: readonly InventorySupplierSource[], options: InventorySyncOptions,
): Promise<InventorySyncResult> {
  const source = readInventoryBaseline(baseline);
  const issues = [...source.issues];
  const targetLocation = options.targetLocation === undefined && source.locations.length === 1 ? source.locations[0] :
    source.locations.find(location => location === options.targetLocation) ?? null;
  if (targetLocation === null) issues.push({ code: options.targetLocation === undefined ? 'target-location-required' : 'target-location-invalid',
    source: 'run', message: 'Choose one exact location from the Shopify inventory CSV.' });
  const { reserveUnits, zeroOutThreshold, maxCap, approveLargeDrop, brand } = options;
  const validRules = nonnegativeInteger(reserveUnits) && nonnegativeInteger(zeroOutThreshold) &&
    (maxCap === undefined || nonnegativeInteger(maxCap));
  if (!validRules) issues.push({ code: 'invalid-buffer-policy', source: 'run',
    message: 'Reserve, zero-out threshold and cap must be nonnegative whole numbers within the supported exact integer range.' });

  const validSupplierCount = suppliers.length >= 1 && suppliers.length <= 3;
  if (!validSupplierCount) issues.push({ code: 'supplier-count', source: 'run', message: 'Provide one to three supplier stock sheets.' });
  const parsedSuppliers = validSupplierCount ? suppliers.map(readInventorySupplier) : [];
  const { offers, conflicts } = readOffers(parsedSuppliers, suppliers, issues);
  const optionDepthByHandle = new Map<string, number>();
  const scoped = targetLocation === null || source.issues.length ? [] : source.records.flatMap(record => {
    const identity = inventoryIdentity(record, source.columns);
    const depth = optionDepthByHandle.get(identity.handle) ?? 0;
    if (identity.declaredDepth > depth) optionDepthByHandle.set(identity.handle, identity.declaredDepth);
    return identity.location === targetLocation ? [{ record, ...identity }] : [];
  });
  const collectDuplicates = (code: string, field: 'sku' | 'key', message: string) => {
    const seen = new Map<string, number[]>();
    for (const row of scoped) {
      const value = row[field];
      if (value.trim() === '') continue;
      const lines = seen.get(value);
      if (lines) lines.push(row.record.line);
      else seen.set(value, [row.record.line]);
    }
    const duplicateLines = new Set<number>();
    for (const [value, lines] of seen) {
      if (lines.length < 2) continue;
      lines.forEach(line => duplicateLines.add(line));
      issues.push({ code, source: 'baseline', line: lines[0], lines, value, ...(field === 'sku' ? { sku: value } : {}), message });
    }
    return duplicateLines;
  };
  const duplicateSku = collectDuplicates('duplicate-baseline-sku-location', 'sku', 'This SKU is repeated at the selected location.');
  const duplicateIdentity = collectDuplicates('duplicate-native-identity', 'key', 'This handle and option combination is repeated at the selected location.');
  const rows: InventorySyncRow[] = scoped.map(({ record, sku, handle, currentRaw, valid, optionDepth }) => {
    const baselineLine = record.line;
    const currentQty = exactQuantity(currentRaw, false);
    const entries = offers.get(sku) ?? [];
    const supplierQty = entries.length && !conflicts.has(sku) ? entries[0].quantity : null;
    const row = { sku, baselineLine, currentRaw, currentQty, supplierQty, offers: entries, proposedQty: null, bufferWithheld: null };
    if (duplicateSku.has(baselineLine) || duplicateIdentity.has(baselineLine) || conflicts.has(sku)) return { ...row, status: 'blocked' };
    if (supplierQty === null) return { ...row, proposedQty: currentQty, status: 'no-supplier-match' };
    const fullIdentity = valid && optionDepth === optionDepthByHandle.get(handle);
    if (!fullIdentity) issues.push({ code: 'invalid-native-identity', source: 'baseline', line: baselineLine, sku,
      message: 'Use the exact Shopify handle and the variant’s required option values on the matched row.' });
    if (currentQty === null) issues.push({ code: 'unverified-baseline-current', source: 'baseline', line: baselineLine, sku,
      column: currentHeader, value: currentRaw, message: 'A matched row needs a signed whole-number On hand (current) value for update and rollback.' });
    if (!fullIdentity || currentQty === null || !validRules) return { ...row, status: 'blocked' };

    const afterReserve = supplierQty <= zeroOutThreshold ? 0 : Math.max(0, supplierQty - reserveUnits);
    const proposedQty = maxCap === undefined ? afterReserve : Math.min(afterReserve, maxCap);
    const bufferWithheld = supplierQty - proposedQty;
    const largeDrop = currentQty > 0 && 5n * BigInt(proposedQty) < BigInt(currentQty);
    const needsApproval = largeDrop && approveLargeDrop !== true;
    if (needsApproval) issues.push({ code: 'large-stock-drop', source: 'baseline', line: baselineLine, sku,
      message: 'This proposal removes more than 80% of the current stock. Review the row and approve large drops for this run.' });
    return { ...row, proposedQty, bufferWithheld, largeDrop,
      status: needsApproval ? 'approval-required' : proposedQty === currentQty ? 'unchanged' : 'changed' };
  });
  let unitsAdded = 0n;
  let unitsRemoved = 0n;
  const totals: InventoryTotals = { unitsAdded: 0, unitsRemoved: 0, changedCount: 0, bufferZeroedCount: 0, outOfStockCount: 0 };
  for (const { currentQty, proposedQty, supplierQty } of rows) {
    if (currentQty === null || proposedQty === null) continue;
    const delta = BigInt(proposedQty) - BigInt(currentQty);
    if (delta > 0n) unitsAdded += delta;
    if (delta < 0n) unitsRemoved -= delta;
    if (delta !== 0n) totals.changedCount++;
    if (supplierQty !== null && supplierQty > 0 && proposedQty === 0) totals.bufferZeroedCount++;
    if (proposedQty <= 0) totals.outOfStockCount++;
  }
  const safe = BigInt(Number.MAX_SAFE_INTEGER);
  if (unitsAdded > safe || unitsRemoved > safe) {
    issues.push({ code: 'inventory-totals-out-of-range', source: 'run', value: JSON.stringify({ unitsAdded: String(unitsAdded), unitsRemoved: String(unitsRemoved) }),
      message: 'The quantity totals exceed the supported exact integer range. Split the batch before retrying.' });
  }
  totals.unitsAdded = unitsAdded > safe ? String(unitsAdded) : Number(unitsAdded);
  totals.unitsRemoved = unitsRemoved > safe ? String(unitsRemoved) : Number(unitsRemoved);
  const pair = makeInventoryPair(source, targetLocation ?? '', rows, issues);
  const status = issues.length ? 'blocked' : pair.updateCsv ? 'ready' : 'no-changes';

  const fingerprint = async ({ filename, bytes }: InventorySource) => ({ filename, byteLength: bytes.byteLength, sha256: await sha256(bytes) });
  const [baselinePrint, supplierPrints] = await Promise.all([fingerprint(baseline), Promise.all(suppliers.map(async supplier =>
    ({ ...await fingerprint(supplier), ...(supplier.sheetName === undefined ? {} : { sheetName: supplier.sheetName }) })))]);
  const custody: InventoryCustody = { baseline: baselinePrint, suppliers: supplierPrints };
  if (pair.updateCsv && pair.rollbackCsv) {
    [custody.updateCsvSha256, custody.rollbackCsvSha256] = await Promise.all([sha256(pair.updateCsv), sha256(pair.rollbackCsv)]);
  }
  const summary = { status, targetLocation, rows, totals, issues, custody, verification: pair.verification } as const;
  const signOffHtml = renderInventorySignoff({ ...summary, ...pair }, brand);
  const scopedSkus = new Set(scoped.map(({ sku }) => sku));
  const excludedOffers = targetLocation === null || source.issues.length ? null : (() => {
    const skuColumn = source.columns.get('SKU')!;
    const baselineSkus = new Set(source.records.map(({ cells }) => cells[skuColumn]));
    return [...offers].flatMap(([sku, entries]) => scopedSkus.has(sku) || conflicts.has(sku) ? [] : [{
      sku, reason: baselineSkus.has(sku) ? 'outside-selected-location' : 'absent-from-baseline', offers: entries,
    }]);
  })();
  const auditJson = JSON.stringify({
    version: 1, ...summary, locations: source.locations, excludedOffers, options: { reserveUnits, zeroOutThreshold, maxCap: maxCap ?? null,
      approveLargeDrop: approveLargeDrop === true, requestedLocation: options.targetLocation ?? null },
    mappings: suppliers.map(({ mapping }, index) => mapping ? { ...mapping, skuHeader: parsedSuppliers[index]?.headers[mapping.skuColumn] ?? null,
      quantityHeader: parsedSuppliers[index]?.headers[mapping.quantityColumn] ?? null } : null),
  }, null, 2) + '\n';
  return { ...summary, ...pair, auditJson, signOffHtml };
}
