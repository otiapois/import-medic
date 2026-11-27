import { wooSaleHeader, wooStockHeader } from '../woocommerce-price-diff/source';
import { bigCommerceSkuHeader, bigCommerceStockHeader, bigSaleHeader } from '../bigcommerce-price-diff/source';
import type { Baseline, ColumnSelection, ColumnSuggestions, DiffIssue, SupplierSheet } from './types';
import { issue } from './types';
import { hasPricingInstructions, validatePricingRule } from './pricing-rules';
import { compareAtHeader, inventoryHeader } from './source';

export const skuAliases = new Set(['sku', 'variant sku', 'supplier sku', 'product sku', 'item sku', 'sku code', 'stock keeping unit']);
const handleAliases = new Set(['handle', 'url handle', 'product handle', 'shopify handle']);
const costAliases = new Set(['cost', 'unit cost', 'wholesale cost', 'wholesale price']);
export const priceAliases = new Set(['price', 'new price', 'variant price', 'new variant price', 'supplier price', 'unit price', 'retail price', 'selling price', 'sale price', ...costAliases]);
const compareAtAliases = new Set(['compare at price', 'variant compare at price', 'new compare at price', 'msrp', 'rrp']);

export const defaultDropPercent = 50;
export const defaultIncreasePercent = 200;
export const defaultInventoryDropPercent = 80;
export const validThreshold = (value: number, maximum: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= maximum && Number(value.toFixed(3)) === value;

export const mappingLabel = (text: string): string => text.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
export const explicitlyWholesale = (header: string): boolean => costAliases.has(mappingLabel(header));
export const currencyColumns = (headers: readonly string[]) => headers.flatMap((name, index) =>
  ['currency', 'currency code', 'price currency'].includes(mappingLabel(name)) ? [index] : []);

export function suggestColumns(baseline: Baseline, sheet: SupplierSheet): ColumnSuggestions {
  const woo = baseline.platform === 'woocommerce';
  const bigcommerce = baseline.platform === 'bigcommerce';
  const productPricing = woo || bigcommerce;
  const labels = sheet.headers.map(mappingLabel);
  const matching = (test: (label: string) => boolean) => labels.flatMap((label, index) => test(label) ? [index] : []);
  const skuColumns = matching((label) => skuAliases.has(label) || bigcommerce && label === 'product code/sku');
  const handleColumns = productPricing ? [] : matching((label) => handleAliases.has(label));
  const optionColumns = [1, 2, 3].map((dimension) => productPricing ? [] : matching((label) =>
    label === 'option' + dimension + ' value' || label === 'option ' + dimension + ' value' || label === 'option' + dimension || label === 'option ' + dimension));
  const priceColumns = matching((label) => productPricing ? label === 'regular price' || (label !== 'sale price' && priceAliases.has(label)) : priceAliases.has(label));
  const compareAtColumns = matching((label) => productPricing ? label === 'sale price' : compareAtAliases.has(label));
  const hasSku = skuColumns.length > 0 && baseline.columns.has(woo ? 'SKU' : bigcommerce ? bigCommerceSkuHeader(baseline) : 'Variant SKU');
  const hasOptions = handleColumns.length > 0 && optionColumns[0].length > 0;
  const requiresConfirmation = (hasSku && hasOptions) || skuColumns.length > 1 ||
    (hasOptions && (handleColumns.length > 1 || optionColumns.some((options) => options.length > 1))) ||
    priceColumns.length > 1 || compareAtColumns.length > 1 ||
    (priceColumns.length === 1 && costAliases.has(labels[priceColumns[0]]));
  return {
    skuColumns, handleColumns, optionColumns, priceColumns, compareAtColumns, requiresConfirmation,
    selection: {
      joinKey: hasSku || !hasOptions ? 'sku' : 'handle-options',
      skuColumn: skuColumns[0],
      handleColumn: handleColumns[0],
      optionColumns: optionColumns.map((columns) => columns[0] ?? null),
      priceColumn: priceColumns[0],
      compareAtColumn: null,
    },
  };
}

export interface ResolvedMapping {
  joinKey: 'sku' | 'handle-options';
  sku: number | null;
  handle: number | null;
  options: readonly (number | null)[];
  price: number;
  compareAt: number | null;
  inventory: number | null;
  inventoryDrop: number;
  compareAtAutomatic?: true;
  drop: number;
  increase: number;
  sameCurrencyConfirmed: boolean;
  fxRateConfirmed?: boolean;
  woocommerce?: true;
  bigcommerce?: true;
  compareAtTarget?: string;
}

export function resolveMapping(
  baseline: Baseline, sheet: SupplierSheet, suggestions: ColumnSuggestions, supplied: ColumnSelection,
): { mapping: ResolvedMapping | null; issues: DiffIssue[] } {
  const selection = { ...suggestions.selection, ...supplied };
  const issues: DiffIssue[] = [];
  const woo = baseline.platform === 'woocommerce';
  const bigcommerce = baseline.platform === 'bigcommerce';
  if (woo && (selection.joinKey !== 'sku' || selection.pricingRule?.compareAtRule !== undefined)) {
    issues.push(issue('mapping', 'unsupported-woo-mapping', 'Choose a SKU join and optionally map the supplier Sale price column for WooCommerce.'));
    return { mapping: null, issues };
  }
  if (bigcommerce && (selection.joinKey !== 'sku' || selection.pricingRule?.compareAtRule !== undefined)) {
    issues.push(issue('mapping', 'unsupported-bigcommerce-mapping', 'Use an exact SKU join and optionally map an explicit supplier Sale Price for BigCommerce.'));
    return { mapping: null, issues };
  }
  if (baseline.market && selection.inventoryColumn != null) {
    issues.push(issue('mapping', 'market-inventory-out-of-scope', 'Remove the mapped inventory column to update only this Shopify market.'));
    return { mapping: null, issues };
  }
  const pricingError = validatePricingRule(selection.pricingRule);
  if (pricingError) {
    issues.push(issue('mapping', 'invalid-pricing-rule', pricingError, { column: 'Pricing formula' }));
    return { mapping: null, issues };
  }
  const fx = selection.pricingRule?.fx;
  if (fx && selection.fxRateConfirmed !== true) {
    issues.push(issue('mapping', 'fx-rate-confirmation-required', 'Verify and confirm the manual FX rate for this supplier batch before exporting.', { column: 'FX rate' }));
  }
  const pricingActive = hasPricingInstructions(selection.pricingRule);
  if (selection.confirmed === false || ((suggestions.requiresConfirmation || pricingActive) && selection.confirmed !== true)) {
    issues.push(issue('mapping', 'mapping-confirmation-required', pricingActive
      ? 'Confirm the supplier columns and pricing formula before exporting.'
      : 'Confirm the supplier join key and price column before exporting.'));
  }

  const { joinKey, priceColumn, compareAtColumn, inventoryColumn, skuColumn, handleColumn } = selection;
  const options = selection.optionColumns ?? [];
  const valid = (index: number | null | undefined): index is number =>
    index !== null && index !== undefined && Number.isInteger(index) && index >= 0 && index < sheet.headers.length;
  const selectedColumns = [priceColumn, compareAtColumn, inventoryColumn, ...(joinKey === 'sku' ? [skuColumn] : [handleColumn, ...options])];
  const used = selectedColumns.filter((index) => index !== undefined && index !== null);
  if (!valid(priceColumn) || (compareAtColumn != null && !valid(compareAtColumn)) || (inventoryColumn != null && !valid(inventoryColumn)) ||
    (joinKey === 'sku' && !valid(skuColumn)) ||
    (joinKey === 'handle-options' && (!valid(handleColumn) || !valid(options[0]) || options.length > 3 ||
      options.some((index) => index !== null && !valid(index)) || (options[1] == null && options[2] != null))) ||
    used.length !== new Set(used).size) {
    issues.push(issue('mapping', 'invalid-column-selection', 'Choose distinct supplier columns for the join key, price, and any mapped compare-at price or inventory quantity.'));
    return { mapping: null, issues };
  }
  if (!joinKey) return { mapping: null, issues };

  const compareAt = compareAtColumn ?? null;
  const autoCompareAt = selection.pricingRule?.compareAtRule !== undefined;
  if (compareAt !== null && autoCompareAt) {
    issues.push(issue('mapping', 'conflicting-compare-at-rules', 'Choose either a mapped supplier compare-at column or an automatic compare-at rule.'));
    return { mapping: null, issues };
  }
  const compareAtTarget = woo ? wooSaleHeader : bigcommerce ? bigSaleHeader : baseline.market?.compareAtHeader ?? compareAtHeader;
  if ((compareAt !== null || autoCompareAt) && (!baseline.columns.has(compareAtTarget) || baseline.market && !baseline.market.compareAtHeader)) {
    issues.push(issue('mapping', 'missing-baseline-compare-at', bigcommerce ? 'Re-export the baseline with Sale Price to preserve its original values in the rollback.'
      : woo ? 'Re-export the baseline with Sale price to preserve its original values in the rollback.'
      : 'Re-export the baseline with the compare-at column before updating this field. This protects existing compare-at cells on every sibling variant.'));
  }
  const inventory = inventoryColumn ?? null;
  const inventoryTarget = bigcommerce ? bigCommerceStockHeader(baseline) : woo ? wooStockHeader : inventoryHeader;
  if (inventory !== null && (inventoryTarget === undefined || !baseline.columns.has(inventoryTarget))) {
    issues.push(issue('mapping', 'missing-baseline-inventory-qty', bigcommerce ? 'Re-export with the original Stock Level and Track Inventory columns.'
      : woo ? 'Re-export the baseline with Stock to preserve its original values in the rollback.'
      : 'Re-export the baseline with its inventory quantity column before mapping stock. The rollback needs each original quantity.'));
  }
  const inventoryDrop = selection.inventoryDropThresholdPercent ?? defaultInventoryDropPercent;
  if (inventory !== null && !validThreshold(inventoryDrop, 100)) {
    issues.push(issue('mapping', 'invalid-inventory-threshold', 'Enter an inventory drop threshold from 0 to 100, with up to three decimal places.'));
    return { mapping: null, issues };
  }
  const drop = selection.dropThresholdPercent ?? defaultDropPercent;
  const increase = selection.increaseThresholdPercent ?? defaultIncreasePercent;
  if (!validThreshold(drop, 100) || !validThreshold(increase, 100_000)) {
    issues.push(issue('mapping', 'invalid-threshold', 'Enter a drop threshold from 0 to 100 and an increase threshold from 0 to 100,000, with up to three decimal places.'));
    return { mapping: null, issues };
  }

  // For duplicate detection, also check an independently identifiable key even
  // when the user selected the other join strategy.
  const alternateSku = suggestions.skuColumns.length === 1 ? suggestions.skuColumns[0] : null;
  const alternateOptions = suggestions.optionColumns.map((columns) => columns.length === 1 ? columns[0] : null);
  const alternateHandle = suggestions.handleColumns.length === 1 && alternateOptions[0] !== null &&
    !suggestions.optionColumns.some((columns) => columns.length > 1) ? suggestions.handleColumns[0] : null;
  return {
    issues,
    mapping: {
      joinKey, price: priceColumn, compareAt, inventory, inventoryDrop, drop, increase, sameCurrencyConfirmed: selection.sameCurrencyConfirmed === true,
      ...(woo ? { woocommerce: true } : {}), ...(bigcommerce ? { bigcommerce: true, compareAtTarget } : {}),
      ...(baseline.market ? { compareAtTarget } : {}),
      ...(autoCompareAt ? { compareAtAutomatic: true } : {}),
      ...(fx ? { fxRateConfirmed: selection.fxRateConfirmed === true } : {}),
      sku: joinKey === 'sku' ? skuColumn! : alternateSku,
      handle: joinKey === 'handle-options' ? handleColumn! : alternateHandle,
      options: joinKey === 'handle-options' ? options : alternateOptions,
    },
  };
}
