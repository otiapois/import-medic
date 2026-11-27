import { amountGreaterThan, readAmount, scaled, type Amount } from '../shopify-price-diff/prices';
import type { CostCreepObservation } from './types';

export function displayPercent(numerator: bigint, denominator: bigint): string {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const hundredths = (absolute * 20_000n + denominator) / (2n * denominator);
  return (negative && hundredths !== 0n ? '-' : '') + (hundredths / 100n) + '.' +
    (hundredths % 100n).toString().padStart(2, '0');
}

export function costRange(amounts: readonly Amount[]): { minimum: Amount; maximum: Amount } {
  let minimum = amounts[0];
  let maximum = minimum;
  for (const amount of amounts.slice(1)) {
    if (amountGreaterThan(minimum, amount)) minimum = amount;
    if (amountGreaterThan(amount, maximum)) maximum = amount;
  }
  return { minimum, maximum };
}

/** Line segments and isolated points in a 160 by 48 viewBox. Missing periods break each path. */
export function costCreepSparkline(observations: readonly (CostCreepObservation | null)[]): { x: number; y: number }[][] {
  const amounts = observations.map((item) => item === null ? null : readAmount(item.cost));
  const observed = amounts.filter((item): item is Amount => item !== null);
  if (!observed.length) return [];
  const { minimum, maximum } = costRange(observed);
  const segments: { x: number; y: number }[][] = [];
  let segment: { x: number; y: number }[] | undefined;
  amounts.forEach((amount, index) => {
    if (amount === null) {
      segment = undefined;
      return;
    }
    if (!segment) segments.push(segment = []);
    const scale = Math.max(maximum.scale, minimum.scale, amount.scale);
    const units = (value: Amount) => value.units * 10n ** BigInt(scale - value.scale);
    const low = units(minimum);
    const range = units(maximum) - low;
    const elevation = range === 0n ? 18 : Number(((units(amount) - low) * 360n) / range) / 10;
    segment.push({ x: 6 + 148 * index / Math.max(1, observations.length - 1), y: 42 - elevation });
  });
  return segments;
}

export function relativeChange(first: Amount, latest: Amount) {
  const [before, after] = scaled(first, latest);
  return before === 0n ? null : { numerator: after - before, denominator: before };
}
