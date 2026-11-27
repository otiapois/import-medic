import type { PriceCustody } from '../audit/custody';
import { decodeCsv } from '../csv';
import { applyBomPricing, isSupplierCost } from '../bom/pricing';
import type { BomInputs, BomSheet } from '../bom/rollup';
import { landedSupplierCost } from '../analytics/catalog-impact';
import type { FormulaGuardAudit } from '../formula-guard';
import { bigCommerceProductTracking, bigCommerceValueIssues, bigCommerceWrites, readBigCommerceStock } from '../bigcommerce-price-diff/safety';
import { bigCommerceStockHeader, bigPriceHeader, bigSaleHeader } from '../bigcommerce-price-diff/source';
import { checkWooUpdate } from '../woocommerce-price-diff/safety';
import { readWooStock, wooSaleHeader } from '../woocommerce-price-diff/source';
import { currencyColumns, explicitlyWholesale, resolveMapping, suggestColumns } from './mapping';
import { chooseSupplier, type SupplierCandidate } from './multi-supplier';
import { marketValueIssues, scopeShopifyMarket } from './markets';
import type { ResolvedMapping } from './mapping';
import { createAudit, verifiedExports, type AuditSupplier } from './output';
import { prepareAutoCompareAt, prepareMappedCompareAt, preparePricing } from './pricing-rules';
import type { FxConversion, PricingRule } from './pricing-rules';
import { amountGreaterThan, currenciesAgree, priceMovement, readAmount, sameAmount, sourceCurrency } from './prices';
import type { Amount } from './prices';
import { addLine, compareAtHeader, duplicateIssues, inventoryHeader, optionValues, originalQuantity, variantKey } from './source';
import { cellValue, conflictPolicies, issue } from './types';
import type { Baseline, BatchDiffOptions, ColumnSelection, DiffIssue, DiffRow, PriceDiffResult, PricingPreview, RollbackVerification, RowResolution, SourceCell, SourceRow, SupplierContender, SupplierDiffInput, SupplierSheet, Variant, Verification } from './types';
import { isScientific } from '../xlsx';

export { parseBaseline, parseSupplier } from './source';
export { suggestColumns } from './mapping';
export { detectShopifyMarkets, type ShopifyMarket } from './markets';
export { previewTierBrackets, validatePricingRule } from './pricing-rules';
export type { FxConversion, PricingBracket, PricingRule } from './pricing-rules';
export type { Baseline, BatchDiffOptions, ConflictPolicy, SupplierContender, SupplierDiffInput, ColumnSelection, ColumnSuggestions, DiffIssue, DiffRow, PriceDiffResult, PricingPreview, RowResolution, SupplierFile, SupplierSheet } from './types';

type WorkProgress = (phase: 'comparing' | 'exporting', percent: number) => void;
type RowProgress = (done: number, total: number) => void;

function reportRows(report: WorkProgress | undefined, phase: 'comparing' | 'exporting', from: number, to: number): RowProgress | undefined {
  if (!report) return undefined;
  let last = from;
  return (done, total) => {
    const percent = from + Math.floor((to - from) * done / total);
    if (percent <= last) return;
    last = percent;
    report(phase, percent);
  };
}

interface SupplierIdentity {
  row: SourceRow;
  sku: string | null;
  handle: string | null;
  optionsKey: string | null;
  key: string | null;
  issues: DiffIssue[];
}

function variantIndices(baseline: Baseline) {
  const dimensions = new Map<string, number>();
  const skuVariants = new Map<string, Variant>();
  const optionsVariants = new Map<string, Variant>();
  for (const variant of baseline.variants) {
    const used = variant.options.reduce((count, value, index) => value !== '' ? index + 1 : count, 0);
    dimensions.set(variant.handle, Math.max(dimensions.get(variant.handle) ?? 0, used));
    if (variant.sku !== '') skuVariants.set(variant.sku, variant);
    if (!variant.woocommerce && !variant.bigcommerce) optionsVariants.set(variantKey(variant.handle, variant.options), variant);
  }
  return { dimensions, skuVariants, optionsVariants };
}

function supplierIdentities(
  supplier: SupplierSheet, mapping: ResolvedMapping, dimensions: ReadonlyMap<string, number>, resolutions: Readonly<Record<number, RowResolution>>,
): { identities: SupplierIdentity[]; issues: DiffIssue[] } {
  const skuRows = new Map<string, number[]>();
  const optionsRows = new Map<string, number[]>();
  const mapped = new Set([mapping.sku, mapping.handle, ...mapping.options, mapping.price, mapping.compareAt, mapping.inventory]);
  const identities = supplier.rows.map((row): SupplierIdentity => {
    const details = (index: number | null) => ({ row: row.line, column: index === null ? null : supplier.headers[index], value: cellValue(row, index) });
    const sku = cellValue(row, mapping.sku);
    const handle = cellValue(row, mapping.handle);
    const options = optionValues.map((_, index) => cellValue(row, mapping.options[index]) ?? '');
    const issues: DiffIssue[] = [];
    for (const index of mapped) {
      const cell = index == null ? undefined : row.cells[index];
      if (cell?.kind === 'formula' && !cell.value) {
        issues.push(issue('supplier', 'formula-without-cached-value', 'This mapped Excel formula has no cached value. Replace it with its original value before continuing.',
          { ...details(index), blocking: false }));
      }
    }
    const skipped = resolutions[row.line]?.skip === true;
    if (sku !== null && sku.trim() !== '' && mapping.sku !== null) {
      const cell = row.cells[mapping.sku];
      if (cell.kind !== 'text' || isScientific(sku)) {
        const scientific = cell.scientific || isScientific(sku);
        issues.push(issue('supplier', scientific ? 'scientific-sku' : 'non-text-sku',
          'Use the original SKU as a text cell. Numeric Excel cells and scientific notation cannot establish an exact SKU.', details(mapping.sku)));
      }
      addLine(skuRows, mapping.woocommerce || mapping.bigcommerce ? sku.toLowerCase() : sku, row.line);
    } else if (mapping.joinKey === 'sku' && !skipped) {
      const cell = mapping.sku !== null ? row.cells[mapping.sku] : undefined;
      issues.push(issue('supplier', cell?.kind === 'formula' ? 'non-text-sku' : 'missing-supplier-key',
        'This supplier row needs an exact text SKU or an explicit skip.', details(mapping.sku)));
    } else if (mapping.sku !== null && row.cells[mapping.sku]?.kind === 'formula') {
      issues.push(issue('supplier', 'non-text-sku', 'Use an original text SKU, without a formula.', details(mapping.sku)));
    }

    let optionsKey: string | null = null;
    if (mapping.handle !== null) {
      const optionCount = options.reduce((count, value, index) => value !== '' ? index + 1 : count, 0);
      const count = handle ? dimensions.get(handle) ?? Math.max(1, optionCount) : 1;
      const fieldsAreText = [mapping.handle, ...mapping.options].every((position) => position == null ||
        !row.cells[position] || row.cells[position].kind === 'text' || row.cells[position].kind === 'missing');
      const complete = handle !== null && handle.trim() !== '' && fieldsAreText && options.slice(0, count).every((value) => value.trim() !== '') &&
        options.slice(count).every((value) => value === '');
      if (complete) {
        optionsKey = variantKey(handle, options);
        addLine(optionsRows, optionsKey, row.line);
      } else if (mapping.joinKey === 'handle-options' && !skipped) {
        issues.push(issue('supplier', 'invalid-supplier-variant-key',
          'Use the exact text handle and all required option values, or skip this supplier row.', details(mapping.handle)));
      }
    }
    const key = mapping.joinKey === 'sku' ? (sku?.trim() ? sku : null) : optionsKey;
    return { row, sku, handle, optionsKey, key, issues };
  });
  return {
    identities,
    issues: [
      ...identities.flatMap((identity) => identity.issues),
      ...duplicateIssues('supplier', 'duplicate-sku', mapping.sku === null ? 'SKU' : supplier.headers[mapping.sku], skuRows),
      ...duplicateIssues('supplier', 'duplicate-variant-key', 'Handle + option values', optionsRows),
    ],
  };
}

function diffRow(variant: Variant | undefined, identity: SupplierIdentity | undefined, mapping: ResolvedMapping | null): DiffRow {
  const baselineRow = variant?.source.line ?? null;
  const supplierRow = identity?.row.line ?? null;
  return {
    id: variant ? 'baseline-' + baselineRow : 'supplier-' + supplierRow,
    status: variant ? 'Missing in Supplier' : 'Unmatched Supplier Row',
    sku: variant?.sku ?? identity?.sku ?? null,
    handle: variant?.woocommerce ? null : variant?.handle ?? identity?.handle ?? null,
    ...(variant?.woocommerce ? { woocommerce: variant.woocommerce } : {}),
    ...(variant?.bigcommerce ? { bigcommerce: variant.bigcommerce } : {}),
    baselineRow, supplierRow,
    oldPrice: variant?.price ?? null, newPrice: variant?.price ?? null, deltaPercent: null,
    oldCompareAtPrice: variant?.compareAtPrice ?? null, newCompareAtPrice: variant?.compareAtPrice ?? null,
    supplierPrice: identity ? cellValue(identity.row, mapping?.price) : null,
    computedPrice: null,
    supplierCompareAtPrice: identity ? cellValue(identity.row, mapping?.compareAt) : null,
    priceOutput: 'omitted', compareAtOutput: 'omitted', issues: [],
    ...(mapping?.inventory != null ? {
      oldInventoryQty: variant?.inventoryQty ?? null, newInventoryQty: variant?.inventoryQty ?? null,
      supplierInventoryQty: identity ? cellValue(identity.row, mapping.inventory) : null, inventoryOutput: 'omitted',
    } : {}),
  };
}

function selectedAmount(raw: string | null, source: SourceCell | undefined): Amount | null {
  if (raw === null || source?.kind === 'formula' || source?.kind === 'unsupported') return null;
  if (source?.kind !== 'number' || !isScientific(raw)) return readAmount(raw);
  const [coefficient, exponent] = raw.trim().toLowerCase().split('e');
  const exp = Number(exponent);
  const [whole, fraction = ''] = coefficient.replace(/^[+-]/, '').split('.');
  const position = whole.length + exp;
  if (Math.abs(exp) > 64 || coefficient.length > 64) return null;
  const digits = whole + fraction;
  const value = position <= 0 ? '0.' + '0'.repeat(-position) + digits :
    position >= digits.length ? digits + '0'.repeat(position - digits.length) : digits.slice(0, position) + '.' + digits.slice(position);
  return readAmount((coefficient.startsWith('-') ? '-' : '') + value);
}

function supplierCurrencies(row: SourceRow, sheet: SupplierSheet, mapping: ResolvedMapping, positions: readonly number[], fx?: FxConversion) {
  const issues: DiffIssue[] = [];
  const currency: string[] = [];
  function check(index: number, units: readonly string[]) {
    if (!fx) currency.push(...units);
    else if (!currenciesAgree([fx.sourceCurrency, ...units])) {
      issues.push(issue('supplier', 'fx-source-currency-conflict', `This supplier cell must use ${fx.sourceCurrency} for the selected FX rate. Correct the supplier currency or skip the row.`,
        { row: row.line, column: sheet.headers[index], value: cellValue(row, index) }));
    }
  }
  for (const index of positions) {
    const cell = row.cells[index];
    const unit = cell?.value?.trim().toUpperCase();
    if (!unit && cell?.kind !== 'formula' && cell?.kind !== 'unsupported') continue;
    if (cell?.kind === 'text' && unit && /^(?:[A-Z]{3}|[$€£¥₹])$/.test(unit)) check(index, [unit]);
    else issues.push(issue('supplier', 'invalid-currency', 'Choose a supplier row with a single text currency code or symbol, or skip this row.',
      { row: row.line, column: sheet.headers[index], value: cell?.value ?? null }));
  }
  if (fx) {
    for (const index of [mapping.price, mapping.compareAt]) {
      if (index === null) continue;
      const units = sourceCurrency(cellValue(row, index));
      const styled = row.cells[index]?.currency;
      if (styled) units.push(styled);
      if (units.length) check(index, units);
    }
  }
  return { issues, currency };
}

export function previewPricingFormula(baseline: Baseline, supplier: SupplierSheet, selection: ColumnSelection): PricingPreview | null {
  baseline = scopeShopifyMarket(baseline, selection.market);
  if (baseline.issues.some(({ code }) => code === 'unknown-shopify-market')) return null;
  const { mapping, issues } = resolveMapping(baseline, supplier, suggestColumns(baseline, supplier), { ...selection, confirmed: true, fxRateConfirmed: true });
  if (!mapping || issues.some(({ blocking }) => blocking)) return null;
  const { dimensions, skuVariants, optionsVariants } = variantIndices(baseline);
  const { identities, issues: identityIssues } = supplierIdentities(supplier, mapping, dimensions, {});
  const blocked = new Set(identityIssues.flatMap(({ rows }) => rows));
  const rule = selection.pricingRule;
  const fx = rule?.fx;
  const positions = currencyColumns(supplier.headers);
  const applyPricing = preparePricing(rule);
  const applyAutoCompareAt = prepareAutoCompareAt(rule);
  for (const { row, key, sku, optionsKey } of identities) {
    const skuMatch = sku ? skuVariants.get(sku) : undefined;
    const optionsMatch = optionsKey ? optionsVariants.get(optionsKey) : undefined;
    if (skuMatch?.bigcommerce?.type === 'SKU' || (skuMatch?.bigcommerce && baseline.bigcommerceGroupedProducts?.has(skuMatch.bigcommerce.id))) continue;
    if (key === null || blocked.has(row.line) || !(mapping.joinKey === 'sku' ? skuMatch : optionsMatch) ||
      (skuMatch && optionsMatch && skuMatch !== optionsMatch)) continue;
    if (fx && supplierCurrencies(row, supplier, mapping, positions, fx).issues.length) continue;
    const supplierPrice = cellValue(row, mapping.price);
    const source = selectedAmount(supplierPrice, row.cells[mapping.price]);
    const computed = source && applyPricing(source);
    if (supplierPrice !== null && computed) {
      const compareAt = applyAutoCompareAt?.(computed);
      return { supplierRow: row.line, supplierPrice, computedPrice: computed.text,
        ...(computed.matchedTier ? { matchedTier: computed.matchedTier } : {}),
        ...(rule?.retailAdjustmentPercent === undefined ? {} : { retailAdjustmentPercent: rule.retailAdjustmentPercent }),
        ...(fx ? { fxApplied: fx } : {}), ...(compareAt ? { computedCompareAtPrice: compareAt.text } : {}) };
    }
  }
  return null;
}

function prepareComparison(rule: PricingRule | undefined, woo: boolean, costColumn: string) {
  return {
    fx: rule?.fx, applyPricing: preparePricing(rule),
    costKnown: (rule !== undefined && rule.mode !== 'direct') || explicitlyWholesale(costColumn),
    costRate: rule?.fx ? readAmount(rule.fx.fxRate) : null,
    applyMappedCompareAt: prepareMappedCompareAt(rule?.fx, woo), applyAutoCompareAt: prepareAutoCompareAt(rule),
  };
}

function comparePrices(
  result: DiffRow, identity: SupplierIdentity, sheet: SupplierSheet, mapping: ResolvedMapping,
  currencyPositions: readonly number[], resolution: RowResolution | undefined, pricing: ReturnType<typeof prepareComparison>, bomComponentCost = false,
): { issues: DiffIssue[]; currency: string[] } {
  const row = identity.row;
  const { fx, applyPricing, applyMappedCompareAt, applyAutoCompareAt, costKnown, costRate } = pricing;
  const collected = supplierCurrencies(row, sheet, mapping, currencyPositions, fx);
  const { issues, currency } = collected;
  if (fx && issues.length) return collected;
  const salePrice = mapping.woocommerce || mapping.bigcommerce;
  const compareAtTarget = mapping.compareAtTarget ?? (mapping.woocommerce ? wooSaleHeader : compareAtHeader);
  const assess = (index: number | null, old: string | null, raw: string | null, override: string | undefined, compareAt: boolean): string | null => {
    const source = index === null ? undefined : row.cells[index];
    const column = index === null ? compareAtTarget : sheet.headers[index];
    const details = { row: row.line, column, value: override ?? raw };
    const autoCompareAt = index === null && applyAutoCompareAt;
    const blank = override !== undefined ? override === '' : (raw === '' || raw === null) && source?.kind !== 'formula' && source?.kind !== 'unsupported';
    if (blank && (compareAt && (override !== undefined || !autoCompareAt) ||
      !compareAt && mapping.bigcommerce && mapping.inventory !== null && override === undefined)) return old;
    const original = selectedAmount(raw, source);
    if (!compareAt && bomComponentCost && original?.units === 0n && override === undefined) {
      result.landedCost = '0.00';
      if (!fx) {
        if (original.currency) currency.push(original.currency);
        if (source?.currency) currency.push(source.currency);
      }
      return old;
    }
    const retail = autoCompareAt && result.newPrice !== null ? readAmount(result.newPrice) : null;
    if (autoCompareAt && !retail && override === undefined) return null;
    const computedRetail = !compareAt && original ? applyPricing(original) : null;
    const computed = compareAt ? (autoCompareAt ? retail && autoCompareAt(retail) : original && applyMappedCompareAt(original)) : computedRetail;
    if (!compareAt) {
      result.computedPrice = computedRetail?.text ?? null;
      if (computedRetail?.matchedTier) result.matchedTier = computedRetail.matchedTier;
      if ((costKnown || bomComponentCost) && original && original.units > 0n) result.landedCost = landedSupplierCost(original, costRate);
    }
    if (fx && computed && index !== null) result.fxApplied = fx;
    const amount = override !== undefined ? readAmount(override) : computed;
    const wrongStoreUnit = fx && amount?.currency && !currenciesAgree([fx.storeCurrency, amount.currency]);
    if (!amount || amount.units < 0n || (amount.units === 0n && !(salePrice && compareAt)) || wrongStoreUnit) {
      if (!compareAt && override === undefined && original && original.units > 0n && !computed) {
        issues.push(issue('supplier', 'invalid-computed-price', 'The pricing formula did not produce a supported positive retail price. Change the formula, enter a final positive price, or skip the row.', details));
        return null;
      }
      const explain = wrongStoreUnit ? `Enter the override in ${fx.storeCurrency} or use a plain decimal amount in that currency.` :
        autoCompareAt && override === undefined ? 'The formula did not produce a supported positive compare-at price. Edit the compare-at price or skip the row.' :
        source?.kind === 'formula' && override === undefined ? 'This price is an Excel formula. Enter a positive plain decimal or skip the row.' :
          'Enter a positive decimal amount without ambiguous grouping, or skip this row.';
      issues.push(issue('supplier', compareAt ? (salePrice ? 'invalid-sale-price' : 'invalid-compare-at-price') : 'invalid-price', explain, details));
      return null;
    }
    if (!fx) {
      if (amount.currency) currency.push(amount.currency);
      if (override !== undefined) currency.push(...sourceCurrency(raw));
      if (source?.currency) currency.push(source.currency);
    }
    const oldAmount = old ? readAmount(old) : null;
    if (!oldAmount) return amount.text;
    const movement = priceMovement(oldAmount, amount, mapping.drop, mapping.increase);
    if (!compareAt) result.deltaPercent = movement.deltaPercent;
    if (movement.guard) {
      const message = movement.guard === 'price-drop' ? 'This price drops more than the selected threshold.' :
        movement.guard === 'price-increase' ? 'This price increases more than the selected threshold.' : 'The previous price is zero. Confirm the new positive price before exporting.';
      issues.push(issue('supplier', movement.guard, message, { ...details, blocking: resolution?.confirm !== true }));
    }
    return sameAmount(oldAmount, amount) ? old : amount.text;
  };
  result.newPrice = assess(mapping.price, result.oldPrice, result.supplierPrice, resolution?.price, false);
  if (mapping.compareAt !== null || applyAutoCompareAt) {
    result.newCompareAtPrice = assess(mapping.compareAt, result.oldCompareAtPrice, result.supplierCompareAtPrice, resolution?.compareAtPrice, true);
  }
  if (mapping.woocommerce || !mapping.bigcommerce && (mapping.compareAt !== null || applyAutoCompareAt)) {
    const retail = result.newPrice && readAmount(result.newPrice);
    const compareAt = result.newCompareAtPrice && readAmount(result.newCompareAtPrice);
    if (mapping.woocommerce && retail && compareAt && !amountGreaterThan(retail, compareAt)) {
      issues.push(issue('supplier', 'woo-sale-not-below-regular', 'Sale price must be below the final regular price. Adjust the mapped sale or regular price, or skip the row.',
        { row: row.line, column: mapping.compareAt === null ? wooSaleHeader : sheet.headers[mapping.compareAt], value: result.newCompareAtPrice }));
    } else if (!mapping.woocommerce && retail && compareAt && !amountGreaterThan(compareAt, retail)) {
      issues.push(issue('supplier', 'compare-at-not-above-price', 'Compare-at price must be greater than the final variant price. Edit either price or skip the row.',
        { row: row.line, column: mapping.compareAt === null ? compareAtTarget : sheet.headers[mapping.compareAt], value: result.newCompareAtPrice }));
    }
  }
  result.status = result.newPrice !== result.oldPrice || result.newCompareAtPrice !== result.oldCompareAtPrice ? 'Updated' : 'Unchanged';
  return { issues, currency };
}

const supplierQuantity = /^[0-9]{1,64}(?![\s\S])/;

function compareInventory(
  result: DiffRow, row: SourceRow, sheet: SupplierSheet, mapping: ResolvedMapping, resolution: RowResolution | undefined,
): DiffIssue[] {
  const index = mapping.inventory;
  if (index === null) return [];
  const original = result.oldInventoryQty;
  const source = row.cells[index];
  const override = resolution?.inventoryQty;
  const value = override ?? result.supplierInventoryQty ?? null;
  const details = { row: row.line, column: sheet.headers[index], value };
  if (mapping.bigcommerce && !value && override === undefined && source?.kind !== 'formula' && source?.kind !== 'unsupported') return [];
  if (value === null || !supplierQuantity.test(value) || (mapping.woocommerce && readWooStock(value) === null) ||
    (mapping.bigcommerce && readBigCommerceStock(value) === null) ||
    (override === undefined && source?.kind !== 'text' && source?.kind !== 'number')) {
    result.newInventoryQty = null;
    return [issue('supplier', 'invalid-inventory-qty', 'Enter a nonnegative whole inventory quantity using digits, or skip this supplier row.', details)];
  }

  const next = BigInt(value);
  const previous = mapping.woocommerce ? readWooStock(original) : mapping.bigcommerce ? readBigCommerceStock(original) :
    original && originalQuantity.test(original) ? BigInt(original) : null;
  result.newInventoryQty = previous === next ? original : next.toString();
  if (previous !== null && previous > 0n && next < previous) {
    const zeroOut = next === 0n;
    const exceedsThreshold = (previous - next) * 100_000n > previous * BigInt(Math.round(mapping.inventoryDrop * 1000));
    if (zeroOut || exceedsThreshold) {
      return [issue('supplier', zeroOut ? 'inventory-zero-out' : 'inventory-drop',
        zeroOut ? 'This update sets positive inventory to zero. Confirm, edit the quantity, or skip this supplier row.'
          : 'This inventory drop exceeds the selected threshold. Confirm, edit the quantity, or skip this supplier row.',
        { ...details, blocking: resolution?.confirm !== true })];
    }
  }
  return [];
}

function attachRowIssues(rows: DiffRow[], issues: DiffIssue[]): void {
  const bySource = new Map<string, DiffIssue[]>();
  for (const entry of issues) {
    for (const row of entry.rows) {
      const key = entry.source + '-' + row;
      const rowIssues = bySource.get(key) ?? [];
      rowIssues.push(entry);
      bySource.set(key, rowIssues);
    }
  }
  for (const row of rows) {
    row.issues = [...bySource.get('baseline-' + row.baselineRow) ?? [], ...bySource.get('supplier-' + row.supplierRow) ?? []];
    if (row.issues.some((entry) => entry.blocking)) row.status = 'Blocked';
  }
}

function compareSupplier(
  baseline: Baseline, supplier: SupplierSheet, selection: ColumnSelection, resolutions: Readonly<Record<number, RowResolution>>,
  indices: ReturnType<typeof variantIndices>, onRows?: RowProgress, bom?: BomSheet,
) {
  const suggestions = suggestColumns(baseline, supplier);
  const { mapping, issues: mappingIssues } = resolveMapping(baseline, supplier, suggestions, selection);
  const issues = [...supplier.issues.map((entry) => ({ ...entry })), ...mappingIssues];
  const candidates: DiffRow[] = [];
  const currenciesByRow = new Map<number, string[]>();
  if (mapping) {
    const { dimensions, skuVariants, optionsVariants } = indices;
    const pricing = prepareComparison(selection.pricingRule, mapping.woocommerce === true || mapping.bigcommerce === true, supplier.headers[mapping.price]);
    const sourceIsCost = bom && isSupplierCost(supplier.headers[mapping.price], selection.pricingRule);
    const { identities, issues: identityIssues } = supplierIdentities(supplier, mapping, dimensions, resolutions);
    issues.push(...identityIssues);
    const suppliers = new Map<string, SupplierIdentity>();
    for (const identity of identities) {
      if (identity.key !== null && !suppliers.has(identity.key)) suppliers.set(identity.key, identity);
      if (identity.sku && identity.optionsKey) {
        const skuMatch = skuVariants.get(identity.sku);
        const optionMatch = optionsVariants.get(identity.optionsKey);
        if (skuMatch && optionMatch && skuMatch !== optionMatch) {
          issues.push(issue('supplier', 'conflicting-variant-identifiers', 'This SKU and this handle with its option values identify different baseline variants.',
            { row: identity.row.line, column: 'SKU and Handle + option values', value: identity.sku }));
        }
      }
    }

    const taken = new Set<number>();
    const total = baseline.variants.length + identities.length;
    let done = 0;
    const currencyPositions = currencyColumns(supplier.headers);
    for (const variant of baseline.variants) {
      if (onRows && done > 0 && (done & 2047) === 0) onRows(done, total);
      done++;
      const key = mapping.joinKey === 'sku' ? variant.sku : variantKey(variant.handle, variant.options);
      const match = suppliers.get(key);
      const identity = match && !taken.has(match.row.line) ? match : undefined;
      const row = diffRow(variant, identity, mapping);
      candidates.push(row);
      if (!identity) continue;
      taken.add(identity.row.line);
      const resolution = resolutions[identity.row.line];
      if (resolution?.skip) {
        row.status = 'Skipped';
        continue;
      }
      const isBomComponentCost = sourceIsCost && bom?.componentSkus.has(variant.sku);
      const evaluated = comparePrices(row, identity, supplier, mapping, currencyPositions, resolution, pricing, isBomComponentCost);
      issues.push(...evaluated.issues, ...compareInventory(row, identity.row, supplier, mapping, resolution));
      if (row.newInventoryQty !== row.oldInventoryQty) row.status = 'Updated';
      if (evaluated.currency.length) currenciesByRow.set(identity.row.line, evaluated.currency);
    }
    for (const identity of identities) {
      if (onRows && done > 0 && (done & 2047) === 0) onRows(done, total);
      done++;
      if (taken.has(identity.row.line)) continue;
      const row = diffRow(undefined, identity, mapping);
      const resolution = resolutions[identity.row.line];
      if (resolution?.skip) row.status = 'Skipped';
      else {
        issues.push(...compareInventory(row, identity.row, supplier, mapping, resolution));
        // Bundle-only parts stay unmatched in the catalog. Validate their cost without projecting a new product.
        if (identity.sku !== null && bom?.componentSkus.has(identity.sku) && !skuVariants.has(identity.sku) && sourceIsCost) {
          const { issues: currencyIssues, currency } = supplierCurrencies(identity.row, supplier, mapping, currencyPositions, pricing.fx);
          issues.push(...currencyIssues);
          const value = identity.row.cells[mapping.price];
          const amount = selectedAmount(row.supplierPrice, value);
          if (!amount || amount.units < 0n) {
            issues.push(issue('supplier', 'invalid-bom-supplier-cost', 'Enter a verified nonnegative cost for this bundle component.',
              { row: identity.row.line, column: supplier.headers[mapping.price], value: row.supplierPrice }));
          } else {
            row.landedCost = amount.units === 0n ? '0.00' : landedSupplierCost(amount, pricing.costRate);
            if (!pricing.fx) {
              if (amount.currency) currency.push(amount.currency);
              if (value?.currency) currency.push(value.currency);
            }
          }
          if (currency.length) currenciesByRow.set(identity.row.line, currency);
        }
      }
      candidates.push(row);
    }
    if (total) onRows?.(total, total);

  } else {
    for (const variant of baseline.variants) candidates.push(diffRow(variant, undefined, null));
    for (const row of supplier.rows) candidates.push(diffRow(undefined, { row, handle: null, sku: null, optionsKey: null, key: null, issues: [] }, null));
    for (const row of candidates) row.status = 'Blocked';
  }

  attachRowIssues(candidates, issues);
  return { candidates, issues, suggestions, mapping, currenciesByRow };
}

function currencyIssues(currenciesByRow: ReadonlyMap<number, readonly string[]>, sameCurrencyConfirmed: boolean, baseline: Baseline): DiffIssue[] {
  if (!currenciesByRow.size) return [];
  const units = [...new Set([...currenciesByRow.values()].flat())];
  const rows = [...currenciesByRow.keys()].sort((a, b) => a - b);
  const details = { row: rows[0], rows, column: 'Currency', value: units.join(', ') };
  if (!currenciesAgree(units)) return [issue('supplier', 'currency-conflict', 'The mapped supplier prices use conflicting currencies. Resolve or skip the conflicting rows before exporting.', details)];
  const target = baseline.market ? 'selected ' + baseline.market.name + ' market' :
    (baseline.platform === 'bigcommerce' ? 'BigCommerce' : baseline.platform === 'woocommerce' ? 'WooCommerce' : 'Shopify') + ' store';
  return sameCurrencyConfirmed ? [] : [issue('supplier', 'currency-confirmation-required',
    'Confirm the supplier and ' + target + ' prices use the same currency. No exchange rates are applied.', details)];
}

function linkedOptionIssues(baseline: Baseline, candidates: readonly DiffRow[]): DiffIssue[] {
  const updated = new Set(candidates.filter(({ status }) => status === 'Updated').map(({ handle }) => handle));
  const linked = new Map<string, number[]>();
  for (const variant of baseline.variants) {
    if (variant.linkedOption && updated.has(variant.handle)) addLine(linked, variant.handle, variant.source.line);
  }
  return [...linked].map(([handle, rows]) =>
    issue('baseline', 'unsupported-linked-option', 'This affected product uses linked options, which this scoped CSV cannot safely update.',
      { row: rows[0], rows, column: 'Option LinkedTo', value: handle }));
}

function finishComparison(
  baseline: Baseline, candidates: DiffRow[], issues: DiffIssue[],
  options: { includeCompareAt: boolean; inventoryEnabled: boolean; formulaGuard: boolean; onVerify?: () => void; onWork?: WorkProgress },
) {
  let updateBytes: PriceDiffResult['updateBytes'] = null;
  let rollbackBytes: PriceDiffResult['rollbackBytes'] = null;
  let verification: Verification = { checked: false, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 };
  let rollbackVerification: RollbackVerification = { checked: false, restoredVariants: 0 };
  const formulaGuard: FormulaGuardAudit = { enabled: options.formulaGuard, neutralized: [], blocked: [] };
  const { includeCompareAt, inventoryEnabled, onVerify, onWork } = options;
  const woo = baseline.platform === 'woocommerce';
  const bigcommerce = baseline.platform === 'bigcommerce';
  const market = baseline.market;
  const stockHeader = bigcommerce ? bigCommerceStockHeader(baseline) : undefined;
  if (woo) {
    for (const row of candidates) {
      if (row.status !== 'Updated') continue;
      const unsafe = checkWooUpdate(baseline, row, inventoryEnabled);
      if (unsafe.length) {
        issues.push(...unsafe);
        row.issues.push(...unsafe);
        row.status = 'Blocked';
      }
    }
  }
  if (bigcommerce || market) {
    const affected = new Set(candidates.flatMap(({ status, handle }) => status === 'Updated' ? [handle] : []));
    const byLine = new Map(candidates.map((row) => [row.baselineRow, row]));
    const tracking = bigcommerce ? bigCommerceProductTracking(baseline) : undefined;
    for (const variant of baseline.variants) {
      const row = byLine.get(variant.source.line);
      if (!row || (tracking ? row.status !== 'Updated' : !affected.has(variant.handle))) continue;
      const nextPrice = row.status === 'Updated' ? row.newPrice : variant.price;
      const nextCompareAt = row.status === 'Updated' ? row.newCompareAtPrice : variant.compareAtPrice;
      const unsafe = tracking ? bigCommerceValueIssues(baseline, variant, bigCommerceWrites(row, stockHeader), tracking) :
        marketValueIssues(market!, variant.price, variant.compareAtPrice, nextPrice, nextCompareAt, variant.source.line);
      if (!unsafe.length) continue;
      issues.push(...unsafe);
      row.issues.push(...unsafe);
      row.status = 'Blocked';
    }
  }
  if (!woo && !bigcommerce && inventoryEnabled && !issues.some(({ blocking }) => blocking)) {
    const affected = new Set(candidates.flatMap(({ status, handle }) => status === 'Updated' ? [handle] : []));
    const rowByLine = new Map(candidates.map((row) => [row.baselineRow, row]));
    for (const variant of baseline.variants) {
      if (!affected.has(variant.handle) || !variant.inventoryQty || originalQuantity.test(variant.inventoryQty)) continue;
      const entry = issue('baseline', 'invalid-baseline-inventory-qty', 'Re-export the baseline with a whole quantity or the original blank cell. The rollback cannot safely restore this value.',
        { row: variant.source.line, column: inventoryHeader, value: variant.inventoryQty });
      issues.push(entry);
      const row = rowByLine.get(variant.source.line);
      if (row) {
        row.issues.push(entry);
        row.status = 'Blocked';
      }
    }
  }
  if (!issues.some(({ blocking }) => blocking) && candidates.some(({ status }) => status === 'Updated')) {
    onVerify?.();
    onWork?.('exporting', 75);
    const checked = verifiedExports(baseline, candidates, includeCompareAt, inventoryEnabled, formulaGuard.enabled, reportRows(onWork, 'exporting', 75, 90));
    updateBytes = checked.updateBytes;
    rollbackBytes = checked.rollbackBytes;
    verification = checked.verification;
    rollbackVerification = checked.rollbackVerification;
    formulaGuard.blocked = checked.blockedCells;
    if (checked.blockedCells.length) {
      issues.push(issue('verification', 'formula-guard-blocked', 'Spreadsheet formula protection would change cells that must stay exact in the ' + (bigcommerce ? 'BigCommerce' : woo ? 'WooCommerce' : 'Shopify') + ' exports. The audit lists the affected baseline lines and cells.'));
    } else if (!updateBytes || !rollbackBytes) {
      issues.push(issue('verification', 'verification-mismatch', 'The projected update and rollback CSVs did not prove exact scoped cells and complete baseline variant groups.'));
    }
    for (const row of candidates) {
      if (row.baselineRow === null || !checked.outputLines.has(row.baselineRow)) continue;
      if (bigcommerce) {
        const writes = row.status === 'Updated' ? bigCommerceWrites(row, stockHeader) : new Map();
        if (writes.has(bigPriceHeader)) row.priceOutput = 'value';
        if (writes.has(bigSaleHeader)) row.compareAtOutput = 'value';
        if (stockHeader && writes.has(stockHeader)) row.inventoryOutput = 'value';
        continue;
      }
      if (!market || row.newPrice !== '') row.priceOutput = 'value';
      if (includeCompareAt) row.compareAtOutput = row.newCompareAtPrice === '' ? 'empty' : 'value';
      if (inventoryEnabled) row.inventoryOutput = row.newInventoryQty === '' ? 'empty' : 'value';
    }
  }
  const status = issues.some(({ blocking }) => blocking) ? 'review' : updateBytes && rollbackBytes ? 'ready' : 'no-changes';
  return {
    status, canDownload: status === 'ready', updateBytes, rollbackBytes, verification, rollbackVerification, formulaGuard,
  } as const;
}

export function buildPriceDiff(
  baseline: Baseline, supplier: SupplierSheet, selection: ColumnSelection = {}, resolutions: Readonly<Record<number, RowResolution>> = {},
  onVerify?: () => void, source?: Pick<SupplierDiffInput, 'supplierId' | 'label' | 'filename'>, onWork?: WorkProgress, bom?: BomInputs,
): PriceDiffResult {
  baseline = scopeShopifyMarket(baseline, selection.market);
  const indices = variantIndices(baseline);
  onWork?.('comparing', 15);
  const { candidates, issues, suggestions, mapping, currenciesByRow } = compareSupplier(baseline, supplier, selection, resolutions, indices, reportRows(onWork, 'comparing', 15, 65), bom?.sheet);
  issues.unshift(...baseline.issues);
  const input = describeSupplier({ supplierId: source?.supplierId ?? 'primary', label: source?.label, filename: source?.filename ?? supplier.name,
    sheet: supplier, selection, resolutions }, mapping);
  const currencyReview = currencyIssues(currenciesByRow, mapping?.sameCurrencyConfirmed === true, baseline);
  if (source) {
    for (const entry of currencyReview) {
      entry.supplierId = input.supplierId;
      entry.supplierSource = input.label;
    }
  }
  issues.push(...currencyReview, ...(bom ? [] : linkedOptionIssues(baseline, candidates)));
  attachRowIssues(candidates, issues);
  for (const row of candidates) {
    const bomCost = row.sku !== null && bom?.sheet.componentSkus.has(row.sku);
    if (row.supplierRow !== null && (row.baselineRow !== null || mapping?.inventory != null || bomCost || source && row.status !== 'Blocked')) attachSupplier(row, input);
  }
  return completeResult(baseline, [input], candidates, issues, suggestions, {
    inventoryEnabled: mapping?.inventory != null, overlapCount: 0, conflictCount: 0, conflictPolicy: 'block-conflicts',
  }, onVerify, selection.formulaGuard === true, onWork, bom);
}

function describeSupplier(input: SupplierDiffInput, mapping: ResolvedMapping | null): AuditSupplier {
  return {
    ...input, label: input.label?.trim() || input.filename, mapping, resolutions: input.resolutions ?? {}, pricingRule: input.selection?.pricingRule,
  };
}

function attachSupplier(row: DiffRow, supplier: AuditSupplier): void {
  row.supplierId = supplier.supplierId;
  row.supplierSource = supplier.label;
  row.supplierFilename = supplier.filename;
  row.supplierWorksheet = supplier.sheet.name;
}

function completeResult(
  baseline: Baseline, suppliers: readonly AuditSupplier[], rows: DiffRow[], issues: DiffIssue[], suggestions: PriceDiffResult['suggestions'],
  batch: Pick<PriceDiffResult, 'inventoryEnabled' | 'overlapCount' | 'conflictCount' | 'conflictPolicy'>,
  onVerify: (() => void) | undefined, formulaGuardEnabled: boolean, onWork?: WorkProgress, bomInput?: BomInputs,
): PriceDiffResult {
  const bom = bomInput ? applyBomPricing(baseline, suppliers, rows, bomInput, selectedAmount, reviewGuardCodes) : undefined;
  if (bom) {
    issues.push(...bom.issues);
    const linked = linkedOptionIssues(baseline, rows);
    issues.push(...linked);
    const linkedByLine = new Map(linked.flatMap((entry) => entry.rows.map((line) => [line, entry] as const)));
    for (const row of rows) {
      const entry = row.baselineRow === null ? undefined : linkedByLine.get(row.baselineRow);
      if (entry) {
        row.issues.push(entry);
        row.status = 'Blocked';
      }
    }
  }
  if (baseline.market) for (const row of rows) row.market = baseline.market;
  const includeCompareAt = suppliers.some(({ mapping }) => mapping?.compareAt != null || mapping?.compareAtAutomatic === true);
  const output = finishComparison(baseline, rows, issues, { includeCompareAt, inventoryEnabled: batch.inventoryEnabled, formulaGuard: formulaGuardEnabled, onVerify, onWork });
  const { updateBytes, rollbackBytes, formulaGuard } = output;
  const audit = (custody?: PriceCustody) => createAudit(baseline, suppliers, rows, issues, { ...output, ...batch }, updateBytes !== null, formulaGuard, includeCompareAt, custody, bom);
  return {
    ...output, ...batch, rows, issues, suggestions, ...(bom ? { bom } : {}), ...(baseline.market ? { market: baseline.market } : {}),
    supplierPricing: suppliers.map(({ supplierId, label, filename, pricingRule }) => ({ supplierId, label, filename, pricingRule })),
    get updateCsv() { return updateBytes && decodeCsv(updateBytes).text; },
    get rollbackCsv() { return rollbackBytes && decodeCsv(rollbackBytes).text; },
    get auditCsv() { return audit().auditCsv; },
    get auditJson() { return audit().auditJson; },
    serializeAuditJson(custody) { return audit(custody).auditJson; },
  };
}

const conflictMessages: Record<string, string> = {
  'supplier-conflict': 'Supplier rows disagree or contain invalid values. Review each source and choose an applicable policy or edit or skip a source row.',
  'supplier-conflict-confirmation-required': 'Confirm the selected supplier conflict policy for this batch before exporting.',
  'incomparable-supplier-prices': 'The overlapping supplier prices use different currencies. Correct the currency or choose a confirmed sheet-order policy.',
};
const reviewGuardCodes = new Set(['price-drop', 'price-increase', 'price-increase-from-zero', 'inventory-drop', 'inventory-zero-out']);

export function buildMultiSupplierDiff(
  baseline: Baseline, inputs: readonly SupplierDiffInput[], options: BatchDiffOptions = {}, onVerify?: () => void, onWork?: WorkProgress, bom?: BomInputs,
): PriceDiffResult {
  baseline = scopeShopifyMarket(baseline, options.market);
  const indices = variantIndices(baseline);
  onWork?.('comparing', 15);
  const issues = [...baseline.issues];
  if (inputs.some(({ selection }) => selection?.market !== undefined && selection.market !== options.market)) {
    issues.push(issue('mapping', 'mixed-shopify-market', 'Use one exact Shopify pricing scope for the whole supplier batch.'));
  }
  const rows: DiffRow[] = [];
  const suppliers: AuditSupplier[] = [];
  const sourceIds = new Set(inputs.map(({ supplierId }) => supplierId));
  if (inputs.length < 1 || inputs.length > 3 || sourceIds.size !== inputs.length || sourceIds.has('')) {
    issues.push(issue('mapping', 'invalid-supplier-batch', 'Choose one to three distinct supplier files for this batch.'));
  }
  const policy = options.conflictPolicy ?? 'block-conflicts';
  const conflictPolicy = conflictPolicies.includes(policy) ? policy : 'block-conflicts';
  if (conflictPolicy !== policy) issues.push(issue('mapping', 'invalid-conflict-policy', 'Choose a supported supplier conflict policy.'));
  const groups = new Map<string, SupplierCandidate[]>();
  const skippedMatches = new Map<number, DiffRow>();
  const retainedIssues = new Set<DiffIssue>();
  const currencyBySupplier = new Map<string, Map<number, string[]>>();
  let suggestions = suggestColumns(baseline, inputs[0]?.sheet ?? { name: '', headerRow: null, headers: [], rows: [], issues: [] });

  const validInputs = inputs.length <= 3 && sourceIds.size === inputs.length ? inputs : [];
  for (const [index, input] of validInputs.entries()) {
    const start = 15 + Math.floor(40 * index / validInputs.length);
    const end = 15 + Math.floor(40 * (index + 1) / validInputs.length);
    const compared = compareSupplier(baseline, input.sheet, input.selection ?? {}, input.resolutions ?? {}, indices, reportRows(onWork, 'comparing', start, end), bom?.sheet);
    const { mapping } = compared;
    const supplier = describeSupplier(input, mapping);
    if (suppliers.length === 0) suggestions = compared.suggestions;
    suppliers.push(supplier);
    const comparisonIssues = new Set(compared.candidates.flatMap(({ issues }) => issues));
    for (const entry of compared.issues) {
      entry.supplierId = supplier.supplierId;
      entry.supplierSource = supplier.label;
      if (!comparisonIssues.has(entry) || !reviewGuardCodes.has(entry.code)) retainedIssues.add(entry);
    }
    const locations = new Map(input.sheet.rows.map(row => [row.line, row]));
    const currencyPositions = currencyColumns(input.sheet.headers);
    currencyBySupplier.set(supplier.supplierId, new Map());
    for (const row of compared.candidates) {
      if (row.supplierRow === null) continue;
      attachSupplier(row, supplier);
      if (row.baselineRow === null) row.id = `supplier-${supplier.supplierId}-${row.supplierRow}`;
      if (row.status === 'Skipped' || !mapping) {
        if (row.status === 'Skipped' && row.baselineRow !== null && !skippedMatches.has(row.baselineRow)) {
          skippedMatches.set(row.baselineRow, row);
          continue;
        }
        if (row.baselineRow !== null) {
          row.id = `supplier-${supplier.supplierId}-${row.supplierRow}`;
          row.baselineRow = null;
        }
        rows.push(row);
        continue;
      }
      const rowLocation = locations.get(row.supplierRow)!;
      const evidence: SupplierContender = {
        supplierId: supplier.supplierId, label: supplier.label, filename: supplier.filename, worksheet: input.sheet.name, row: row.supplierRow,
        priceColumn: input.sheet.headers[mapping.price], price: row.supplierPrice,
        inventoryColumn: mapping.inventory === null ? null : input.sheet.headers[mapping.inventory], inventoryQty: row.supplierInventoryQty ?? null,
        compareAtColumn: mapping.compareAt === null ? null : input.sheet.headers[mapping.compareAt], compareAtPrice: row.supplierCompareAtPrice,
      };
      const resolution = supplier.resolutions[row.supplierRow];
      const currencyReview = supplierCurrencies(rowLocation, input.sheet, mapping, currencyPositions);
      const { currency } = currencyReview;
      currency.push(...sourceCurrency(evidence.price));
      const styledCurrency = rowLocation.cells[mapping.price]?.currency;
      if (styledCurrency) currency.push(styledCurrency);
      const fx = input.selection?.pricingRule?.fx;
      if (fx) currency.push(fx.sourceCurrency);
      const key = row.baselineRow !== null ? `baseline:${row.baselineRow}` : row.sku ? `sku:${row.sku}` : row.id;
      const candidates = groups.get(key) ?? [];
      candidates.push({
        row, evidence, currency,
        amount: selectedAmount(evidence.price, rowLocation.cells[mapping.price]) ??
          (!fx && resolution?.price !== undefined ? readAmount(resolution.price) : null),
        outputCurrency: fx?.storeCurrency,
        ...(row.sku !== null && bom?.sheet.componentSkus.has(row.sku)
          ? { bomCost: isSupplierCost(input.sheet.headers[mapping.price], input.selection?.pricingRule) ? row.landedCost ?? null : null }
          : {}),
        invalid: row.issues.some(({ code, blocking }) => blocking && !reviewGuardCodes.has(code)),
      });
      groups.set(key, candidates);
    }
    for (const [line, units] of compared.currenciesByRow) currencyBySupplier.get(supplier.supplierId)!.set(line, units);
  }

  const inventoryEnabled = suppliers.some(({ mapping }) => mapping?.inventory != null);
  const byBaseline = new Map(baseline.variants.map((variant) => [variant.source.line, variant]));
  const joined = new Map<number, DiffRow>();
  const chosenCurrency = new Map<string, Map<number, string[]>>();
  let overlapCount = 0;
  let conflictCount = 0;
  let groupIndex = 0;
  const reportGroups = reportRows(onWork, 'comparing', 55, 70);
  for (const candidates of groups.values()) {
    if (reportGroups && groupIndex > 0 && (groupIndex & 2047) === 0) reportGroups(groupIndex, groups.size);
    groupIndex++;
    const matchedLine = candidates[0].row.baselineRow;
    const baselineVariant = matchedLine === null ? undefined : byBaseline.get(matchedLine);
    if (inventoryEnabled) {
      for (const { row } of candidates) {
        if (row.inventoryOutput !== undefined) continue;
        row.oldInventoryQty = baselineVariant?.inventoryQty ?? null;
        row.newInventoryQty = row.oldInventoryQty;
        row.supplierInventoryQty = null;
        row.inventoryOutput = 'omitted';
      }
    }
    // Duplicate rows within a sheet retain their own blocking diagnostics. A
    // policy can only choose between files and cannot clear these diagnostics.
    const overlaps = new Set(candidates.map(({ evidence }) => evidence.supplierId)).size > 1;
    const contenders = overlaps ? candidates.map(({ evidence }) => evidence) : undefined;
    const selection = overlaps ? chooseSupplier(candidates, conflictPolicy, options.conflictPolicyConfirmed === true) : { winner: candidates[0], conflict: false };
    if (overlaps) overlapCount++;
    if (selection.conflict) conflictCount++;
    if (selection.winner) {
      const { row, evidence } = selection.winner;
      if (contenders) row.supplierContenders = contenders;
      for (const entry of row.issues) retainedIssues.add(entry);
      const units = currencyBySupplier.get(evidence.supplierId)?.get(evidence.row);
      if (units) {
        const byLine = chosenCurrency.get(evidence.supplierId) ?? new Map<number, string[]>();
        byLine.set(evidence.row, units);
        chosenCurrency.set(evidence.supplierId, byLine);
      }
      if (matchedLine === null) rows.push(row);
      else joined.set(matchedLine, row);
      if (!overlaps) rows.push(...candidates.slice(1).map(({ row }) => row));
      continue;
    }
    const { code } = selection;
    const conflict = issue('supplier', code!, conflictMessages[code!], {
      column: 'Supplier conflict policy', value: baselineVariant?.sku ?? candidates[0].row.sku, supplierContenders: contenders,
    });
    retainedIssues.add(conflict);
    const row = diffRow(baselineVariant, undefined, null);
    row.id = matchedLine === null ? `conflict-${candidates[0].row.id}` : row.id;
    row.sku = baselineVariant?.sku ?? candidates[0].row.sku;
    row.status = 'Blocked';
    row.supplierContenders = contenders;
    row.issues = [conflict];
    if (matchedLine === null) rows.push(row);
    else joined.set(matchedLine, row);
    for (const candidate of candidates) {
      if (!candidate.invalid) continue;
      const invalid = candidate.row;
      invalid.id = `supplier-${candidate.evidence.supplierId}-${candidate.evidence.row}`;
      invalid.supplierContenders = contenders;
      invalid.issues = invalid.issues.filter(({ code }) => !reviewGuardCodes.has(code));
      rows.push(invalid);
    }
  }
  if (groups.size) reportGroups?.(groups.size, groups.size);

  for (const supplier of suppliers) {
    const units = chosenCurrency.get(supplier.supplierId) ?? new Map();
    for (const entry of currencyIssues(units, supplier.mapping?.sameCurrencyConfirmed === true, baseline)) {
      entry.supplierId = supplier.supplierId;
      entry.supplierSource = supplier.label;
      for (const row of joined.values()) {
        if (row.supplierId !== supplier.supplierId || row.supplierRow === null || !units.has(row.supplierRow)) continue;
        row.issues.push(entry);
        row.status = 'Blocked';
      }
      retainedIssues.add(entry);
    }
  }
  const outputCurrencies = new Set<string>();
  for (const supplier of suppliers) {
    const fx = supplier.pricingRule?.fx;
    if (fx && [...joined.values()].some((row) => row.supplierId === supplier.supplierId)) outputCurrencies.add(fx.storeCurrency);
    for (const units of chosenCurrency.get(supplier.supplierId)?.values() ?? []) for (const unit of units) outputCurrencies.add(unit);
  }
  if (!currenciesAgree([...outputCurrencies])) {
    retainedIssues.add(issue('mapping', 'currency-conflict', 'Winning supplier rows do not agree on a common store currency. Correct the input currencies before exporting.'));
  }
  const baselineRows = baseline.variants.map((variant) => {
    const line = variant.source.line;
    const winner = joined.get(line);
    const skipped = skippedMatches.get(line);
    if (winner && skipped) {
      skipped.id = `supplier-${skipped.supplierId}-${skipped.supplierRow}`;
      skipped.baselineRow = null;
      rows.push(skipped);
    }
    const row = winner ?? skipped ?? diffRow(variant, undefined, null);
    if (inventoryEnabled && row.inventoryOutput === undefined) {
      row.oldInventoryQty = variant.inventoryQty;
      row.newInventoryQty = variant.inventoryQty;
      row.supplierInventoryQty = null;
      row.inventoryOutput = 'omitted';
    }
    return row;
  });
  const completeRows = [...baselineRows, ...rows];
  const baselineIssues = [...baseline.issues, ...(bom ? [] : linkedOptionIssues(baseline, baselineRows))];
  issues.push(...baselineIssues.slice(baseline.issues.length), ...retainedIssues);
  const perBaseline = new Map<number, DiffIssue[]>();
  for (const entry of baselineIssues) {
    for (const line of entry.rows) {
      const entries = perBaseline.get(line) ?? [];
      entries.push(entry);
      perBaseline.set(line, entries);
    }
  }
  for (const row of baselineRows) {
    const attached = perBaseline.get(row.baselineRow!);
    if (attached) row.issues.unshift(...attached);
    if (row.issues.some(({ blocking }) => blocking)) row.status = 'Blocked';
  }
  return completeResult(baseline, suppliers, completeRows, issues, suggestions, { inventoryEnabled, overlapCount, conflictCount, conflictPolicy },
    onVerify, inputs.some(({ selection }) => selection?.formulaGuard === true), onWork, bom);
}
