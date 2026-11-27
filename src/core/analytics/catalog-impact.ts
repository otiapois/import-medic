import type { Amount } from '../shopify-price-diff/prices';
import { readAmount } from '../shopify-price-diff/prices';
import type { DiffIssue, DiffRow } from '../shopify-price-diff/types';
import { readWooStock } from '../woocommerce-price-diff/source';
import { readBigCommerceStock } from '../bigcommerce-price-diff/safety';

const buckets = [
  ['below-negative-20', '< -20%'], ['negative-20-to-5', '-20% to -5%'], ['negative-5-to-0', '-5% to 0%'],
  ['unchanged', '0% (unchanged)'], ['positive-0-to-5', '0% to +5%'],
  ['positive-5-to-20', '+5% to +20%'], ['above-positive-20', '> +20%'],
] as const;

export interface CatalogImpactSummary {
  histogram: { key: typeof buckets[number][0]; label: string; count: number }[];
  priceExcluded: { missing: number; flagged: number; skipped: number; unmatched: number; unavailable: number };
  margin: { count: number; averagePercent: string | null; lowestPercent: string | null; highestPercent: string | null; watchlistCount: number };
  inventory: { totalQtyBefore: string; totalQtyAfter: string; netQtyDelta: string; newlyZeroedCount: number; unknownQtyCount: number } | null;
}

export interface CatalogMarginRow {
  landedCost: string;
  grossMarginPercent: string | null;
  belowOrAtCost: boolean;
}

interface Fraction { numerator: bigint; denominator: bigint }

function decimal(units: bigint, scale: number): string {
  const sign = units < 0n ? '-' : '';
  const value = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  return scale === 0 ? sign + value : sign + value.slice(0, -scale) + '.' + value.slice(-scale);
}

export function landedSupplierCost(source: Amount, rate: Amount | null): string {
  return rate ? decimal(source.units * rate.units, source.scale + rate.scale) : source.text;
}

function roundedPercent({ numerator, denominator }: Fraction, digits = 2): bigint {
  const absolute = numerator < 0n ? -numerator : numerator;
  const rounded = (absolute * 2n * 10n ** BigInt(digits + 2) + denominator) / (2n * denominator);
  return numerator < 0n ? -rounded : rounded;
}

function gcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right];
  return left < 0n ? -left : left;
}

function exactSum(values: readonly Fraction[], start: number, end: number): Fraction {
  if (end - start === 1) return values[start];
  const middle = Math.floor((start + end) / 2);
  const left = exactSum(values, start, middle);
  const right = exactSum(values, middle, end);
  const shared = gcd(left.denominator, right.denominator);
  const numerator = left.numerator * (right.denominator / shared) + right.numerator * (left.denominator / shared);
  const denominator = left.denominator * (right.denominator / shared);
  const factor = gcd(numerator, denominator);
  return { numerator: numerator / factor, denominator: denominator / factor };
}

export function meanPercent(values: readonly Fraction[], digits = 2): string {
  // Enclose the exact sum in an integer interval. Nearly all means can be
  // rounded directly from these endpoints, independent of the individual denominators.
  const scale = 1_000_000_000_000n;
  let lower = 0n;
  let upper = 0n;
  for (const { numerator, denominator } of values) {
    const scaled = numerator * scale;
    const truncated = scaled / denominator;
    const remainder = scaled % denominator;
    lower += truncated - (remainder < 0n ? 1n : 0n);
    upper += truncated + (remainder > 0n ? 1n : 0n);
  }
  const count = BigInt(values.length);
  const denominator = scale * count;
  const first = roundedPercent({ numerator: lower, denominator }, digits);
  if (first === roundedPercent({ numerator: upper, denominator }, digits)) return decimal(first, digits);
  const exact = exactSum(values, 0, values.length);
  return decimal(roundedPercent({ ...exact, denominator: exact.denominator * count }, digits), digits);
}

export function compareFractions(left: Fraction, right: Fraction): bigint {
  return left.numerator * right.denominator - right.numerator * left.denominator;
}

export function grossMarginFraction(landedCost: string, retail: Amount): Fraction | null {
  if (retail.units === 0n) return null;
  const [whole, fractional = ''] = landedCost.split('.');
  const price = retail.units * 10n ** BigInt(fractional.length);
  const cost = BigInt(whole + fractional) * 10n ** BigInt(retail.scale);
  return { numerator: price - cost, denominator: price };
}

function movementBucket(before: Amount, after: Amount): number | null {
  const previous = before.units * 10n ** BigInt(after.scale);
  const next = after.units * 10n ** BigInt(before.scale);
  const change = (next - previous) * 100n;
  if (previous <= 0n) return null;
  if (change === 0n) return 3;
  if (change < -20n * previous) return 0;
  if (change < -5n * previous) return 1;
  if (change < 0n) return 2;
  if (change <= 5n * previous) return 4;
  if (change <= 20n * previous) return 5;
  return 6;
}

const readQuantity = (raw: string | null | undefined): bigint | null =>
  raw != null && /^-?\d{1,64}(?![\s\S])/.test(raw) ? BigInt(raw) : null;

export function createCatalogImpact(inventoryEnabled: boolean, issues: readonly DiffIssue[] = []) {
  const heldMappings = new Set(issues.flatMap(({ source, blocking, supplierId }) => source === 'mapping' && blocking ? [supplierId] : []));
  const histogram = buckets.map(([key, label]) => ({ key, label, count: 0 }));
  const priceExcluded = { missing: 0, flagged: 0, skipped: 0, unmatched: 0, unavailable: 0 };
  const margins: Fraction[] = [];
  let lowest: Fraction | undefined;
  let highest: Fraction | undefined;
  let watchlistCount = 0;
  let oldQty = 0n;
  let newQty = 0n;
  let newlyZeroedCount = 0;
  let unknownQtyCount = 0;

  function add(row: DiffRow): CatalogMarginRow | undefined {
    const proposed = row.status === 'Updated' || row.status === 'Unchanged';
    const admitted = proposed && !heldMappings.has(undefined) && !heldMappings.has(row.supplierId);
    if (inventoryEnabled && row.baselineRow !== null && row.id === `baseline-${row.baselineRow}`) {
      const quantity = row.woocommerce ? readWooStock : row.bigcommerce ? readBigCommerceStock : readQuantity;
      const before = quantity(row.oldInventoryQty);
      const after = admitted ? quantity(row.newInventoryQty) : before;
      if (before === null || after === null) unknownQtyCount++;
      else {
        oldQty += before;
        newQty += after;
        if (before > 0n && after === 0n) newlyZeroedCount++;
      }
    }
    if (!admitted) {
      if (row.status === 'Blocked' || proposed) priceExcluded.flagged++;
      else if (row.status === 'Skipped') priceExcluded.skipped++;
      else if (row.status === 'Missing in Supplier') priceExcluded.missing++;
      else priceExcluded.unmatched++;
      return undefined;
    }

    const before = row.oldPrice ? readAmount(row.oldPrice) : null;
    const after = row.newPrice ? readAmount(row.newPrice) : null;
    const bucket = before && after ? movementBucket(before, after) : null;
    if (bucket === null) priceExcluded.unavailable++;
    else histogram[bucket].count++;

    if (!row.landedCost || !after) return undefined;
    const sale = (row.woocommerce || row.bigcommerce) && row.newCompareAtPrice ? readAmount(row.newCompareAtPrice) : null;
    const retail = sale && sale.units >= 0n ? sale : after;
    const margin = grossMarginFraction(row.landedCost, retail);
    const belowOrAtCost = margin === null || margin.numerator <= 0n;
    if (belowOrAtCost) watchlistCount++;
    if (margin === null) return { landedCost: row.landedCost, grossMarginPercent: null, belowOrAtCost };
    if (!lowest || compareFractions(margin, lowest) < 0n) lowest = margin;
    if (!highest || compareFractions(margin, highest) > 0n) highest = margin;
    margins.push(margin);
    return { landedCost: row.landedCost, grossMarginPercent: decimal(roundedPercent(margin), 2), belowOrAtCost };
  }

  function summarize(): CatalogImpactSummary {
    return {
      histogram, priceExcluded,
      margin: {
        count: margins.length, averagePercent: margins.length ? meanPercent(margins) : null,
        lowestPercent: lowest ? decimal(roundedPercent(lowest), 2) : null,
        highestPercent: highest ? decimal(roundedPercent(highest), 2) : null, watchlistCount,
      },
      inventory: inventoryEnabled ? {
        totalQtyBefore: oldQty.toString(), totalQtyAfter: newQty.toString(), netQtyDelta: (newQty - oldQty).toString(), newlyZeroedCount, unknownQtyCount,
      } : null,
    };
  }
  return { add, summarize };
}

export function analyzeCatalogImpact(rows: readonly DiffRow[], inventoryEnabled: boolean, issues?: readonly DiffIssue[]): CatalogImpactSummary {
  const impact = createCatalogImpact(inventoryEnabled, issues);
  for (const row of rows) impact.add(row);
  return impact.summarize();
}
