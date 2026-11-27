import { z } from 'zod';
import { compareFractions, grossMarginFraction, meanPercent } from '../analytics/catalog-impact';
import { buildMultiSupplierDiff, buildPriceDiff } from '../shopify-price-diff';
import { minimumRetailSchema, pricingRuleSchema, retailAdjustmentSchema, retailRoundingSchema, validatePricingRule } from '../shopify-price-diff/pricing-rules';
import type { PricingRule } from '../shopify-price-diff/pricing-rules';
import { amountGreaterThan, readAmount, type Amount } from '../shopify-price-diff/prices';
import { profileText } from '../shopify-price-diff/settings-validation';
import type { Baseline, BatchDiffOptions, DiffRow, PriceDiffResult, SupplierDiffInput } from '../shopify-price-diff/types';

export const MAX_WHAT_IF_SCENARIOS = 6;
const scenarioSchema = z.strictObject({
  id: profileText(80),
  markupPercent: retailAdjustmentSchema.optional(),
  fxBufferPercent: retailAdjustmentSchema.optional(),
  rounding: retailRoundingSchema.optional(),
  minimumRetail: minimumRetailSchema.optional(),
});

export type WhatIfScenario = z.infer<typeof scenarioSchema>;
export type PriceComparison =
  | { kind: 'single'; supplier: SupplierDiffInput }
  | { kind: 'batch'; suppliers: readonly SupplierDiffInput[]; options: BatchDiffOptions };

export interface WhatIfResult {
  id: string;
  status: PriceDiffResult['status'] | 'invalid';
  canApply: boolean;
  changedSkuCount: number;
  marginSkuCount: number;
  averageMarginPercent: string | null;
  negativeMarginSkuCount: number;
  subFloorSkuCount: number;
  unknownRetailSkuCount: number;
  totalRetailDeltaCents: string | null;
  minMarginSku: string | null;
  suppliers: { supplierId: string; pricingRule: PricingRule | undefined }[];
  message?: string;
}

type Work = (phase: 'comparing' | 'exporting', percent: number) => void;

/** The active comparison and its scenarios both enter the native builders here. */
export function runPriceComparison(baseline: Baseline, comparison: PriceComparison, work?: Work): PriceDiffResult {
  if (comparison.kind === 'batch') return buildMultiSupplierDiff(baseline, comparison.suppliers, comparison.options, undefined, work);
  const { supplier } = comparison;
  return buildPriceDiff(baseline, supplier.sheet, supplier.selection, supplier.resolutions, undefined, supplier, work);
}

function decimal(units: bigint, scale: number): string {
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  const width = digits.length - scale;
  const fraction = digits.slice(width).replace(/0+$/, '');
  return (units < 0n ? '-' : '') + digits.slice(0, width) + (fraction ? '.' + fraction : '');
}

function growAmount(amount: Amount, percentage: Amount): [units: bigint, scale: number] {
  const hundred = 100n * 10n ** BigInt(percentage.scale);
  return [amount.units * (hundred + percentage.units), amount.scale + percentage.scale + 2];
}

function adjustedRule(rule: PricingRule | undefined, input: WhatIfScenario, markup: Amount | null, buffer: Amount | null) {
  if (!markup?.units && (!buffer?.units || !rule?.fx) && input.rounding === undefined && input.minimumRetail === undefined) return rule;
  if (validatePricingRule(rule)) throw new Error('Correct the current pricing rule before applying an adjustment.');
  const next: PricingRule = rule ? { ...rule } : { mode: 'direct' };
  if (markup?.units) {
    const previous = readAmount(next.retailAdjustmentPercent ?? '0')!;
    // The accumulated adjustment must reproduce the product of both multipliers before retail rounding.
    const factor = { ...previous, units: previous.units + 100n * 10n ** BigInt(previous.scale) };
    const [units, scale] = growAmount(factor, markup);
    const adjusted = units - 100n * 10n ** BigInt(scale);
    next.retailAdjustmentPercent = decimal(adjusted, scale);
  }
  if (buffer?.units && next.fx) {
    next.fx = { ...next.fx, fxRate: decimal(...growAmount(readAmount(next.fx.fxRate)!, buffer)) };
  }
  if (input.rounding !== undefined) next.rounding = input.rounding;
  if (input.minimumRetail !== undefined) next.minimumRetail = input.minimumRetail;
  const validation = pricingRuleSchema.safeParse(next);
  if (!validation.success) throw new Error('The exact adjusted rule exceeds supported pricing limits. Use a smaller adjustment.');
  return JSON.stringify(rule) === JSON.stringify(next) ? rule : validation.data;
}

function retail(row: DiffRow, prior: boolean): Amount | null {
  const regular = prior ? row.oldPrice : row.newPrice;
  const sale = prior ? row.oldCompareAtPrice : row.newCompareAtPrice;
  const effective = (row.woocommerce || row.bigcommerce) && sale ? sale : regular;
  return effective ? readAmount(effective) : null;
}

function exactCents(amount: Amount | null): bigint | null {
  if (amount === null) return null;
  const units = amount.units * 100n;
  const divisor = 10n ** BigInt(amount.scale);
  return units % divisor === 0n ? units / divisor : null;
}

const emptyMetrics = {
  changedSkuCount: 0, marginSkuCount: 0, averageMarginPercent: null, negativeMarginSkuCount: 0,
  subFloorSkuCount: 0, unknownRetailSkuCount: 0, totalRetailDeltaCents: null, minMarginSku: null,
};

function summarize(result: PriceDiffResult, suppliers: WhatIfResult['suppliers']) {
  const floors = new Map(suppliers.map(({ supplierId, pricingRule }) => [supplierId,
    pricingRule?.minimumRetail === undefined ? null : readAmount(pricingRule.minimumRetail)]));
  let changedSkuCount = 0;
  let unknownRetailSkuCount = 0;
  let delta = 0n;
  let negativeMarginSkuCount = 0;
  let subFloorSkuCount = 0;
  let minimum: { sku: string | null; margin: NonNullable<ReturnType<typeof grossMarginFraction>> } | undefined;
  const margins: NonNullable<ReturnType<typeof grossMarginFraction>>[] = [];
  for (const row of result.rows) {
    if (row.baselineRow === null || (row.status !== 'Updated' && row.status !== 'Unchanged')) continue;
    const after = retail(row, false);
    if (row.status === 'Updated') {
      changedSkuCount++;
      const beforeCents = exactCents(retail(row, true));
      const afterCents = exactCents(after);
      if (beforeCents === null || afterCents === null) unknownRetailSkuCount++;
      else delta += afterCents - beforeCents;
    }
    if (!after) continue;
    const floor = floors.get(row.supplierId ?? 'primary');
    if (floor && amountGreaterThan(floor, after)) subFloorSkuCount++;
    if (!row.landedCost) continue;
    const margin = grossMarginFraction(row.landedCost, after);
    if (!margin) continue;
    margins.push(margin);
    if (margin.numerator < 0n) negativeMarginSkuCount++;
    if (!minimum || compareFractions(margin, minimum.margin) < 0n) {
      minimum = { sku: row.sku || null, margin };
    }
  }
  return {
    changedSkuCount, marginSkuCount: margins.length, averageMarginPercent: margins.length ? meanPercent(margins, 6) : null,
    negativeMarginSkuCount, subFloorSkuCount, unknownRetailSkuCount, minMarginSku: minimum?.sku ?? null,
    totalRetailDeltaCents: unknownRetailSkuCount ? null : delta.toString(),
  };
}

/** Compare scenarios without changing the active settings, audit, or downloadable pair. */
export function simulatePriceScenarios(
  baseline: Baseline, comparison: PriceComparison, scenarios: readonly WhatIfScenario[], current?: PriceDiffResult,
): WhatIfResult[] {
  if (scenarios.length > MAX_WHAT_IF_SCENARIOS || new Set(scenarios.map(({ id }) => id)).size !== scenarios.length) {
    throw new Error('Choose up to six scenarios with distinct IDs.');
  }
  const inputs = comparison.kind === 'batch' ? comparison.suppliers : [comparison.supplier];
  return scenarios.map((input) => {
    const invalid = (message: string): WhatIfResult => ({
      ...emptyMetrics, id: input.id, status: 'invalid', canApply: false, suppliers: [], message,
    });
    const validated = scenarioSchema.safeParse(input);
    if (!validated.success) return invalid(validated.error.issues[0].message);
    const markup = input.markupPercent === undefined ? null : readAmount(input.markupPercent);
    const buffer = input.fxBufferPercent === undefined ? null : readAmount(input.fxBufferPercent);
    if (buffer?.units && !inputs.some(({ selection }) => selection?.pricingRule?.fx)) {
      return invalid('Configure and confirm a manual FX rate before previewing an FX buffer.');
    }
    let changed = false;
    let adjusted: SupplierDiffInput[];
    try {
      adjusted = inputs.map((supplier) => {
        const original = supplier.selection?.pricingRule;
        const pricingRule = adjustedRule(original, validated.data, markup, buffer);
        if (original === pricingRule) return supplier;
        changed = true;
        return { ...supplier, selection: { ...supplier.selection, pricingRule } };
      });
    } catch (error) {
      if (error instanceof Error) return invalid(error.message);
      throw error;
    }
    const suppliers = adjusted.map(({ supplierId, selection }) => ({ supplierId, pricingRule: selection?.pricingRule }));
    const result = !changed && current ? current : runPriceComparison(baseline, comparison.kind === 'batch'
      ? { ...comparison, suppliers: adjusted } : { kind: 'single', supplier: adjusted[0] });
    const blocking = result.issues.find(({ blocking }) => blocking);
    return {
      id: input.id, status: result.status, canApply: changed && result.canDownload, suppliers,
      ...(result.status === 'review' ? emptyMetrics : summarize(result, suppliers)),
      ...(blocking === undefined ? {} : { message: blocking.message }),
    };
  });
}
