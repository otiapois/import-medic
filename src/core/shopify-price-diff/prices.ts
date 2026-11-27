interface Decimal {
  units: bigint;
  scale: number;
  text: string;
}

export interface Amount extends Decimal {
  currency: string | null;
}

export const baselinePrice = /^\d{1,64}(?:\.\d{1,64})?(?![\s\S])/;

function decimal(value: string): Decimal {
  const [whole, fraction = ''] = value.replace(/^[+-]/, '').split('.');
  const integer = (whole || '0').replace(/^0+(?=\d)/, '');
  const negative = value.startsWith('-');
  const text = (negative ? '-' : '') + integer + (fraction ? '.' + fraction : '');
  return { units: BigInt((negative ? '-' : '') + integer + fraction), scale: fraction.length, text };
}

const money = '([A-Z]{3}|[$€£¥₹])';
const amount = '([+-]?(?:[0-9]{1,64}(?:\\.[0-9]{1,64}|,[0-9]{1,2})?|\\.[0-9]{1,64}))';
const decorated = new RegExp('^(?:' + money + '\\s*)?' + amount + '(?:\\s*' + money + ')?$', 'i');
const startsWithCurrency = new RegExp('^' + money + '\\s*[+-]?[0-9.]', 'i');
const endsWithCurrency = new RegExp('[0-9]\\s*' + money + '$', 'i');

export function sourceCurrency(value: string | null): string[] {
  if (value === null || value.length > 150) return [];
  const text = value.trim();
  return [startsWithCurrency.exec(text)?.[1], endsWithCurrency.exec(text)?.[1]]
    .flatMap((unit) => unit === undefined ? [] : [unit.toUpperCase()]);
}

export function readAmount(raw: string): Amount | null {
  if (raw.length > 150) return null;
  const matched = decorated.exec(raw.trim());
  if (!matched || (matched[1] && matched[3])) return null;
  const currency = (matched[1] ?? matched[3])?.toUpperCase() ?? null;
  if (currency && /^[+-]?[0-9]{1,3}\.[0-9]{3}$/.test(matched[2])) return null;
  return { ...decimal(matched[2].replace(',', '.')), currency };
}

export function scaled(left: Decimal, right: Decimal): [bigint, bigint] {
  const digits = Math.max(left.scale, right.scale);
  return [left.units * 10n ** BigInt(digits - left.scale), right.units * 10n ** BigInt(digits - right.scale)];
}

export function sameAmount(left: Decimal, right: Decimal): boolean {
  const [a, b] = scaled(left, right);
  return a === b;
}

export function amountGreaterThan(left: Decimal, right: Decimal): boolean {
  const [a, b] = scaled(left, right);
  return a > b;
}

export function amountDelta(before: Decimal, after: Decimal): string {
  const [oldUnits, newUnits] = scaled(before, after);
  const scale = Math.max(before.scale, after.scale);
  const change = newUnits - oldUnits;
  const digits = (change < 0n ? -change : change).toString().padStart(scale + 1, '0');
  const integer = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return (change < 0n ? '-' : '') + integer + (fraction ? '.' + fraction : '');
}

export function priceMovement(old: Decimal, next: Decimal, drop: number, increase: number): {
  deltaPercent: string | null;
  guard: 'price-drop' | 'price-increase' | 'price-increase-from-zero' | null;
} {
  const [oldUnits, nextUnits] = scaled(old, next);
  if (oldUnits === 0n) return { deltaPercent: null, guard: nextUnits > 0n ? 'price-increase-from-zero' : null };
  const change = nextUnits - oldUnits;
  // Display to six places. The guard compares exact scaled integers.
  const abs = change < 0n ? -change : change;
  const precision = 1_000_000n;
  const display = (abs * 100n * precision * 2n + oldUnits) / (oldUnits * 2n);
  const fraction = (display % precision).toString().padStart(6, '0').replace(/0+$/, '');
  const deltaPercent = (change < 0n && display !== 0n ? '-' : '') + (display / precision).toString() + (fraction ? '.' + fraction : '');
  const threshold = decimal((change < 0n ? drop : increase).toFixed(3));
  const exceeds = abs * 100n * 10n ** BigInt(threshold.scale) > oldUnits * threshold.units;
  return { deltaPercent, guard: exceeds ? (change < 0n ? 'price-drop' : 'price-increase') : null };
}

const symbols: Record<string, readonly string[]> = {
  '$': ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'MXN', 'ARS', 'CLP', 'COP', 'TWD'],
  '€': ['EUR'],
  '£': ['GBP'],
  '¥': ['JPY', 'CNY'],
  '₹': ['INR'],
};

export function currenciesAgree(units: readonly string[]): boolean {
  const first = units[0];
  if (first === undefined) return true;
  const candidates = symbols[first] ?? [first];
  return candidates.some((code) => units.every((unit) => (symbols[unit] ?? [unit]).includes(code)));
}
