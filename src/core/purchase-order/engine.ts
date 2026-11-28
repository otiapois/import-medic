import { sha256 } from '../audit/custody';
import { signoffBrandSchema } from '../branding/signoff-brand';
import { currenciesAgree, readAmount, resolvedCurrencyCode } from '../shopify-price-diff/prices';
import { profileText } from '../shopify-price-diff/settings-validation';
import { addLine } from '../shopify-price-diff/source';
import { parseWorkspaceProfile } from '../shopify-price-diff/workspace-profile';
import { encodeOrderCsv, formatCents, orderFilenames, renderOrderPack, supplierFilename } from './output';
import { exactSku, literalNumber, quantity, readPurchaseOrderInventory, readPurchaseOrderSupplier } from './source';
import { purchaseOrderPolicies, type PurchaseOrderIssue, type PurchaseOrderLine, type PurchaseOrderOptions, type PurchaseOrderResult,
  type PurchaseOrderSource, type PurchaseOrderSupplier, type PurchaseOrderSupplierGroup, type PurchaseOrderSummary } from './types';

export type * from './types';
export { purchaseOrderPolicies } from './types';
export { inspectPurchaseOrderInventory, inspectPurchaseOrderSupplier } from './source';

const maxExact = BigInt(Number.MAX_SAFE_INTEGER);
const validText = profileText(120);
const currencyUnit = /^(?:[A-Z]{3}|[$€£¥₹])$/u;
const utf8 = new TextEncoder();

interface Replenishment {
  sku: string;
  inventoryLine: number;
  currentQty: number;
  reorderPoint: number;
  targetStock: number;
}

interface Candidate {
  supplierIndex: number;
  line: PurchaseOrderLine;
}

function readReplenishment(source: ReturnType<typeof readPurchaseOrderInventory>, options: PurchaseOrderOptions,
  targetLocation: string | null, issues: PurchaseOrderIssue[]) {
  const settings = [['reorderPoint', 'Reorder Point'], ['targetStock', 'Target Stock']] as const;
  const defaults = settings.map(([key, column]) => {
    const raw = options[key];
    if (raw === undefined) return null;
    const value = quantity(raw);
    if (value === null) issues.push({ source: 'run', code: 'invalid-default-quantity', column, value: raw,
      message: `Use a nonnegative whole number for the default ${column}.` });
    return value;
  });
  const reorder = new Map<string, Replenishment>();
  const { sku: skuIndex, current, location, reorder: reorderIndex, target } = source.columns;
  const scope = location < 0 || targetLocation !== null;
  const matches = new Map<string, number[]>();
  const belowReorder = new Set<string>();
  if (!scope || skuIndex < 0 || current < 0) return { reorder, belowReorder: 0 };
  for (const { line, cells } of source.rows) {
    if (location >= 0 && cells[location].value !== targetLocation) continue;
    const skuCell = cells[skuIndex];
    if (!exactSku(skuCell)) {
      issues.push({ source: 'inventory', code: 'invalid-inventory-sku', line, column: source.headers[skuIndex],
        value: skuCell.value ?? '', message: 'Use an exact nonempty SKU as text. Scientific notation is ambiguous.' });
      continue;
    }
    const sku = skuCell.value;
    addLine(matches, sku, line);
    const problem = (code: string, column: string, value: string, message: string) => {
      issues.push({ source: 'inventory', line, sku, code, column, value, message });
    };
    const read = (index: number) => cells[index]?.value ?? '';
    const currentQty = quantity(read(current), true);
    const reorderRaw = read(reorderIndex);
    const reorderPoint = reorderRaw.trim() ? quantity(reorderRaw) : defaults[0];
    if (currentQty === null) problem('invalid-current-quantity', source.headers[current], read(current), 'Use a signed whole-number current inventory quantity.');
    if (reorderPoint === null) problem('invalid-reorder-point', source.headers[reorderIndex] ?? 'Reorder Point', reorderRaw,
      'Provide a nonnegative whole-number Reorder Point in the row or the run default.');
    if (currentQty === null || reorderPoint === null || currentQty > reorderPoint) continue;
    belowReorder.add(sku);
    const targetRaw = read(target);
    const targetStock = targetRaw.trim() ? quantity(targetRaw) : defaults[1];
    if (targetStock === null) {
      problem('invalid-target-stock', source.headers[target] ?? 'Target Stock', targetRaw,
        'Provide a nonnegative whole-number Target Stock in the row or the run default.');
      continue;
    }
    if (!reorder.has(sku)) reorder.set(sku, { sku, inventoryLine: line, currentQty, reorderPoint, targetStock });
  }
  for (const [sku, lines] of matches) {
    if (lines.length < 2) continue;
    reorder.delete(sku);
    issues.push({ source: 'inventory', code: 'duplicate-inventory-sku', line: lines[0], lines, sku,
      message: 'This exact SKU occurs more than once in the selected inventory scope.' });
  }
  return { reorder, belowReorder: belowReorder.size };
}

function readOffers(sources: ReturnType<typeof readPurchaseOrderSupplier>[], reorder: ReadonlyMap<string, Replenishment>,
  issues: PurchaseOrderIssue[]) {
  const candidates = new Map<string, Candidate[]>();
  const currencyEvidence = new Map<string, { supplierIndex: number; line: number; sku: string }>();
  const matched = new Set<string>();
  const rejected = new Set<string>();
  const offers = [];
  for (const [supplierIndex, source] of sources.entries()) {
    issues.push(...source.issues.map(issue => ({ ...issue, supplierIndex })));
    const { columns, headers } = source;
    if (columns.sku < 0 || columns.unitCost < 0) continue;
    const matches = new Map<string, number[]>();
    for (const { line, cells } of source.rows) {
      const skuCell = cells[columns.sku];
      if (!exactSku(skuCell)) {
        issues.push({ source: 'supplier', code: 'invalid-supplier-sku', supplierIndex, line, column: headers[columns.sku],
          value: skuCell?.value ?? '', message: 'Use the exact store SKU as text. Numeric or formula worksheet cells and scientific notation are ambiguous.' });
        continue;
      }
      const sku = skuCell.value;
      const inventory = reorder.get(sku);
      if (!inventory) continue;
      matched.add(sku);
      addLine(matches, sku, line);
      const before = issues.length;
      const problem = (code: string, index: number, value: string, message: string) => {
        issues.push({ source: 'supplier', code, supplierIndex, line, sku, column: headers[index], value, message });
      };
      const raw = (index: number) => cells[index]?.value ?? '';
      const optionalQuantity = (key: 'moq' | 'casePack' | 'leadTimeDays', fallback: number | null, title: string) => {
        const index = columns[key];
        const cell = cells[index];
        const value = raw(index);
        if ((!cell || cell.kind === 'missing' || cell.kind === 'text' || cell.kind === 'number') && value.trim() === '') return fallback;
        const parsed = literalNumber(cell) && !cell?.currency ? quantity(value) : null;
        if (parsed === null || (key === 'casePack' && parsed === 0)) {
          problem(key === 'moq' ? 'invalid-moq' : key === 'casePack' ? 'invalid-case-pack' : 'invalid-lead-time', index, value,
            `Use a literal ${key === 'casePack' ? 'positive' : 'nonnegative'} whole number for ${title}.`);
          return null;
        }
        return parsed;
      };
      const moq = optionalQuantity('moq', 0, 'MOQ');
      const casePack = optionalQuantity('casePack', 1, 'Case Pack');
      const leadTimeDays = optionalQuantity('leadTimeDays', null, 'Lead Time Days');
      const supplierSkuCell = cells[columns.supplierSku];
      const supplierSku = raw(columns.supplierSku);
      if (supplierSkuCell && supplierSkuCell.kind !== 'missing' && supplierSkuCell.kind !== 'text') {
        problem('invalid-supplier-item-sku', columns.supplierSku, supplierSku, 'Use the exact Supplier SKU as text.');
      }
      const costCell = cells[columns.unitCost];
      const rawUnitCost = raw(columns.unitCost);
      const amount = literalNumber(costCell) ? readAmount(rawUnitCost) : null;
      const scale = amount ? 10n ** BigInt(amount.scale) : 1n;
      const scaled = amount ? amount.units * 100n : -1n;
      const cents = scaled >= 0 && scaled % scale === 0n ? scaled / scale : null;
      if (cents === null || cents > maxExact) problem('invalid-unit-cost', columns.unitCost, rawUnitCost,
        'Provide a literal nonnegative Unit Cost in exact cents. Enter zero explicitly when the item is free.');
      const currencies = [source.headerCurrency, amount?.currency, costCell?.currency].filter((unit): unit is string => !!unit);
      for (const index of source.currencyIndexes) {
        const cell = cells[index];
        const unit = raw(index).trim().toUpperCase();
        if (unit === '' && (!cell || cell.kind === 'missing' || cell.kind === 'text')) continue;
        if (cell?.kind !== 'text' || !currencyUnit.test(unit)) problem('invalid-currency', index, raw(index), 'Use a literal currency code or supported currency symbol.');
        else currencies.push(unit);
      }
      if (!currenciesAgree(currencies)) problem('incomparable-currency', columns.unitCost, currencies.join(', '), 'This offer has incompatible currency evidence. No exchange rate is applied.');
      const evidence = { supplierIndex, line, inventoryLine: inventory.inventoryLine, sku, supplierSku, rawUnitCost,
        rawMoq: raw(columns.moq), rawCasePack: raw(columns.casePack), rawLeadTimeDays: raw(columns.leadTimeDays), currencies };
      if (issues.length !== before || cents === null || moq === null || casePack === null) {
        rejected.add(sku);
        offers.push(evidence);
        continue;
      }
      for (const unit of currencies) if (!currencyEvidence.has(unit)) currencyEvidence.set(unit, { supplierIndex, line, sku });
      const deficit = BigInt(inventory.targetStock) - BigInt(inventory.currentQty);
      const minimum = deficit > BigInt(moq) ? deficit : BigInt(moq);
      const pack = BigInt(casePack);
      const units = ((minimum + pack - 1n) / pack) * pack;
      const subtotal = units * cents;
      if (units > maxExact || subtotal > maxExact) {
        problem('order-line-out-of-range', columns.unitCost, rawUnitCost, 'The calculated order quantity or subtotal exceeds the exact integer range.');
        rejected.add(sku);
        offers.push(evidence);
        continue;
      }
      const order: PurchaseOrderLine = { ...inventory, sku, supplierSku, supplierLine: line, moq, casePack, leadTimeDays,
        orderQty: Number(units), unitCostCents: Number(cents), lineTotalCents: Number(subtotal),
        unitCost: formatCents(cents), lineTotal: formatCents(subtotal) };
      const previous = candidates.get(sku) ?? [];
      previous.push({ supplierIndex, line: order });
      candidates.set(sku, previous);
      offers.push({ ...evidence, orderQty: order.orderQty, unitCostCents: order.unitCostCents, lineTotalCents: order.lineTotalCents });
    }
    for (const [sku, lines] of matches) {
      if (lines.length < 2) continue;
      rejected.add(sku);
      issues.push({ source: 'supplier', code: 'duplicate-supplier-sku', line: lines[0], lines, sku, supplierIndex,
        message: 'This catalog lists more than one offer for the exact store SKU.' });
    }
  }
  const units = [...currencyEvidence.keys()];
  const comparable = currenciesAgree(units);
  if (!comparable) {
    for (const [unit, loc] of currencyEvidence) issues.push({ ...loc, source: 'supplier', code: 'incomparable-currency', value: unit,
      message: 'The scoped supplier offers do not share comparable currency evidence. No exchange rate is applied.' });
  }
  return { candidates, currency: comparable ? resolvedCurrencyCode(units) ?? units[0] ?? null : null, offers, matched, rejected };
}

export async function buildPurchaseOrder(inventory: PurchaseOrderSource, suppliers: readonly PurchaseOrderSupplier[],
  options: PurchaseOrderOptions = {}): Promise<PurchaseOrderResult> {
  const policy = options.policy ?? 'lowest-landed-cost';
  const { poReference, workspaceProfile } = options;
  const source = readPurchaseOrderInventory(inventory);
  const { quantityBasis, locations } = source;
  const issues = [...source.issues];
  const targetLocation = options.targetLocation === undefined ? locations.length === 1 ? locations[0] : null :
    locations.find(location => location === options.targetLocation) ?? null;
  if (targetLocation === null && (locations.length > 1 || options.targetLocation !== undefined)) {
    issues.push({ source: 'run', code: options.targetLocation === undefined ? 'target-location-required' : 'target-location-invalid',
      value: options.targetLocation, message: 'Choose one exact location from the inventory CSV.' });
  }
  if (!purchaseOrderPolicies.includes(policy)) issues.push({ source: 'run', code: 'invalid-supplier-policy', message: 'Choose a supported supplier policy.' });
  if (poReference !== undefined && !validText.safeParse(poReference).success) {
    issues.push({ source: 'run', code: 'invalid-po-reference', message: 'Use a nonblank PO reference up to 120 characters without control or direction override characters.' });
  }
  const profile = workspaceProfile && parseWorkspaceProfile(workspaceProfile.bytes);
  if (profile && !profile.ok) issues.push(...profile.diagnostics.map(({ code, message }) => ({ source: 'run' as const, code, message })));
  const branding = profile?.ok ? profile.value.branding : options.branding;
  if (options.branding !== undefined && !signoffBrandSchema.safeParse(options.branding).success) {
    issues.push({ source: 'run', code: 'invalid-branding', message: 'Use valid Workspace Profile branding settings.' });
  }
  const supplierCountValid = suppliers.length >= 1 && suppliers.length <= 3;
  if (!supplierCountValid) issues.push({ source: 'run', code: 'supplier-count', message: 'Provide one to three supplier catalogs.' });
  const labels = new Set<string>();
  for (const [supplierIndex, { label }] of suppliers.entries()) {
    if (!validText.safeParse(label).success || labels.has(label)) issues.push({ source: 'supplier', code: 'invalid-supplier-label', supplierIndex,
      value: label, message: 'Use distinct nonblank supplier labels up to 120 characters without control or direction override characters.' });
    labels.add(label);
  }
  const parsed = supplierCountValid ? suppliers.map(readPurchaseOrderSupplier) : [];
  const { reorder, belowReorder } = readReplenishment(source, options, targetLocation, issues);
  const { candidates, currency, offers, matched, rejected } = readOffers(parsed, reorder, issues);
  const groupsByIndex = new Map<number, PurchaseOrderLine[]>();
  for (const [sku, { inventoryLine }] of reorder) {
    if (!matched.has(sku)) {
      issues.push({ source: 'inventory', code: 'missing-supplier-offer', line: inventoryLine, sku,
        message: 'No supplier offer matches this exact SKU at or below its reorder point.' });
    }
    const options = candidates.get(sku);
    if (!options || rejected.has(sku)) continue;
    let chosen = options[0];
    if (policy !== 'prefer-first') {
      const lower = options.reduce((least, entry) => Math.min(least, entry.line.lineTotalCents), chosen.line.lineTotalCents);
      const tied = options.filter(entry => entry.line.lineTotalCents === lower);
      if (tied.length > 1) {
        issues.push({ source: 'inventory', code: 'supplier-cost-tie', line: inventoryLine, sku,
          offers: tied.map(({ supplierIndex, line }) => ({ supplierIndex, line: line.supplierLine })),
          message: 'Two or more suppliers have the same lowest order subtotal after MOQ and case-pack rounding.' });
        continue;
      }
      chosen = tied[0];
    }
    if (chosen.line.orderQty === 0) continue;
    const lines = groupsByIndex.get(chosen.supplierIndex) ?? [];
    lines.push(chosen.line);
    groupsByIndex.set(chosen.supplierIndex, lines);
  }

  const groups: PurchaseOrderSupplierGroup[] = [];
  let unitsOrdered = 0n;
  let totalCents = 0n;
  for (const [supplierIndex, lines] of [...groupsByIndex].sort(([left], [right]) => left - right)) {
    const units = lines.reduce((total, line) => total + BigInt(line.orderQty), 0n);
    const subtotal = lines.reduce((total, line) => total + BigInt(line.lineTotalCents), 0n);
    unitsOrdered += units;
    totalCents += subtotal;
    if (units <= maxExact && subtotal <= maxExact) groups.push({ supplierIndex, label: suppliers[supplierIndex].label,
      lines, unitsOrdered: Number(units), totalCents: Number(subtotal), totalSpend: formatCents(subtotal) });
  }
  if (unitsOrdered > maxExact || totalCents > maxExact) issues.push({ source: 'run', code: 'order-total-out-of-range',
    message: 'The combined order quantity or subtotal exceeds the exact integer range.' });

  const fingerprint = async ({ filename, bytes }: PurchaseOrderSource) => ({ filename, byteLength: bytes.byteLength, sha256: await sha256(bytes) });
  const [inventoryCustody, supplierCustody, profileCustody] = await Promise.all([fingerprint(inventory), Promise.all(suppliers.map(async (supplier, index) => ({
    ...await fingerprint(supplier), label: supplier.label, requestedSheet: supplier.sheetName ?? null, selectedSheet: parsed[index]?.selectedSheet ?? null,
  }))), workspaceProfile && fingerprint(workspaceProfile)]);
  const sourceCustody = { inventory: inventoryCustody, suppliers: supplierCustody, ...(profileCustody && { workspaceProfile: profileCustody }) };
  const settings = { policy, poReference: poReference ?? null, reorderPoint: options.reorderPoint ?? null, targetStock: options.targetStock ?? null };
  const blocked = (): PurchaseOrderResult => {
    const summary = { belowReorder, unitsOrdered: 0, supplierCount: 0, totalCents: 0, totalSpend: '0.00' };
    const result = { status: 'blocked' as const, targetLocation, quantityBasis, currency, summary, issues, groups: [] };
    const content = JSON.stringify({ version: 1, ...result, settings, offers, custody: sourceCustody }, null, 2) + '\n';
    return { ...result, auditJson: { filename: orderFilenames.audit, content }, supplierCsvs: [], summaryCsv: null, packHtml: null };
  };
  if (issues.length) return blocked();

  const summary: PurchaseOrderSummary = { belowReorder, unitsOrdered: Number(unitsOrdered), supplierCount: groups.length,
    totalCents: Number(totalCents), totalSpend: formatCents(totalCents) };
  const result = { status: 'ready' as const, targetLocation, quantityBasis, currency, summary, issues, groups };
  const reserved = new Set([orderFilenames.summary]);
  const csv = encodeOrderCsv(groups, { targetLocation, currency, poReference }, label => supplierFilename(label, reserved));
  if (!csv) {
    issues.push({ source: 'run', code: 'order-csv-replay-failed', message: 'The generated purchase order CSVs failed exact local replay.' });
    return blocked();
  }
  const { supplierCsvs, summaryCsv } = csv;
  const fingerprintText = ({ filename, content }: { filename: string; content: string }) => fingerprint({ filename, bytes: utf8.encode(content) });
  const csvCustody = await Promise.all([...supplierCsvs, summaryCsv].map(fingerprintText));
  const packHtml = { filename: orderFilenames.html, content: renderOrderPack(result, { poReference, branding }, sourceCustody, csvCustody) };
  const custody = { ...sourceCustody, outputs: [...csvCustody, await fingerprintText(packHtml)] };
  const content = JSON.stringify({ version: 1, ...result, settings, offers, custody }, null, 2) + '\n';
  return { ...result, ...csv, packHtml, auditJson: { filename: orderFilenames.audit, content } };
}
