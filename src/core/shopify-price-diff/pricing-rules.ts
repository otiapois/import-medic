import { z } from 'zod';
import { amountGreaterThan, readAmount } from './prices';
import type { Amount } from './prices';

const plainDecimal = z.string().regex(/^[+-]?(?:\d{1,64}(?:\.\d{1,64})?|\.\d{1,64})(?![\s\S])/, 'Use a plain decimal with up to 64 digits on either side of the point.');
const positive = plainDecimal.refine((value) => (readAmount(value)?.units ?? 0n) > 0n, 'Enter a positive decimal.');
const nonnegative = plainDecimal.refine((value) => (readAmount(value)?.units ?? -1n) >= 0n, 'Enter a nonnegative decimal.');
export const minimumRetailSchema = positive;
export const retailRoundingSchema = z.enum(['none', 'ending-99', 'ending-95', 'nearest-whole']);
const common = { rounding: retailRoundingSchema.optional(), minimumRetail: minimumRetailSchema.optional() };

export const legacyPricingRuleSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...common, mode: z.literal('direct') }),
  z.strictObject({ ...common, mode: z.literal('multiplier'), multiplier: positive, fixedFee: nonnegative.optional() }),
  z.strictObject({ ...common, mode: z.literal('percent-markup'), markupPercent: plainDecimal }),
  z.strictObject({ ...common, mode: z.literal('target-margin'), marginPercent: nonnegative.refine((value) => {
    const amount = readAmount(value);
    return amount !== null && amount.units < 100n * 10n ** BigInt(amount.scale);
  }, 'Target margin must be at least 0% and below 100%.') }),
]);

export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter uppercase currency code.');
const fxSchema = z.strictObject({ sourceCurrency: currencyCode, storeCurrency: currencyCode, fxRate: positive });
const compareAtSchema = z.strictObject({ multiplier: positive });
const extensions = { fx: fxSchema.optional(), compareAtRule: compareAtSchema.optional() };
const [direct, multiplier, markup, margin] = legacyPricingRuleSchema.options;
export const preTierPricingRuleSchema = z.discriminatedUnion('mode', [
  direct.extend(extensions), multiplier.extend(extensions), markup.extend(extensions), margin.extend(extensions),
]);

const bracketFields = { upTo: positive.nullable(), fixedFee: nonnegative.optional() };
const bracketSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...bracketFields, mode: z.literal('multiplier'), multiplier: positive }),
  z.strictObject({ ...bracketFields, mode: z.literal('percent-markup'), markupPercent: nonnegative }),
]);
export const tieredSettingsSchema = z.strictObject({
  ...common, mode: z.literal('tiered-brackets'),
  brackets: z.array(bracketSchema).min(2, 'Enter at least two cost brackets.').max(6, 'Enter no more than six cost brackets.').superRefine((brackets, context) => {
    let previous: Amount | null = null;
    for (const [index, bracket] of brackets.entries()) {
      const final = index === brackets.length - 1;
      if ((bracket.upTo === null) !== final) {
        context.addIssue({ code: 'custom', path: [index, 'upTo'], message: 'Only the final cost bracket must be open-ended.' });
      }
      const cutoff = bracket.upTo === null ? null : readAmount(bracket.upTo);
      if (cutoff && previous && !amountGreaterThan(cutoff, previous)) {
        context.addIssue({ code: 'custom', path: [index, 'upTo'], message: 'Cost bracket thresholds must be strictly increasing.' });
      }
      previous = cutoff;
    }
  }),
});
export const tieredPricingRuleSchema = tieredSettingsSchema.extend(extensions);
export const retailAdjustmentSchema = plainDecimal.refine((value) => {
  const amount = readAmount(value);
  return amount !== null && amount.units > -100n * 10n ** BigInt(amount.scale);
}, 'Enter a percentage greater than -100.');
const adjustmentFields = { retailAdjustmentPercent: retailAdjustmentSchema.optional() };
const [fxDirect, fxMultiplier, fxMarkup, fxMargin] = preTierPricingRuleSchema.options;
export const adjustablePreTierPricingRuleSchema = z.discriminatedUnion('mode', [
  fxDirect.extend(adjustmentFields), fxMultiplier.extend(adjustmentFields),
  fxMarkup.extend(adjustmentFields), fxMargin.extend(adjustmentFields),
]);
export const adjustableTieredPricingRuleSchema = tieredPricingRuleSchema.extend(adjustmentFields);
export const pricingRuleSchema = z.discriminatedUnion('mode', [
  ...adjustablePreTierPricingRuleSchema.options,
  adjustableTieredPricingRuleSchema,
]);

export type PricingBracket = z.infer<typeof bracketSchema>;
export type FxConversion = z.infer<typeof fxSchema>;
export type PricingRule = z.infer<typeof pricingRuleSchema>;

export function validatePricingRule(rule: PricingRule | undefined): string | null {
  if (rule === undefined) return null;
  const parsed = pricingRuleSchema.safeParse(rule);
  return parsed.success ? null : parsed.error.issues[0].message;
}

export function hasPricingInstructions(rule: PricingRule | undefined): boolean {
  return rule !== undefined && (changesRetail(rule) || rule.compareAtRule !== undefined);
}

const changesRetail = (rule: PricingRule): boolean =>
  rule.mode !== 'direct' || rule.rounding !== undefined || rule.minimumRetail !== undefined ||
  rule.fx !== undefined || rule.retailAdjustmentPercent !== undefined;

interface Fraction {
  numerator: bigint;
  denominator: bigint;
}

const fraction = ({ units, scale }: Amount): Fraction => ({ numerator: units, denominator: 10n ** BigInt(scale) });
const add = (a: Fraction, b: Fraction): Fraction => ({
  numerator: a.numerator * b.denominator + b.numerator * a.denominator,
  denominator: a.denominator * b.denominator,
});
const multiply = (a: Fraction, b: Fraction): Fraction => ({ numerator: a.numerator * b.numerator, denominator: a.denominator * b.denominator });
const greater = (a: Fraction, b: Fraction): boolean => a.numerator * b.denominator > b.numerator * a.denominator;
const ceil = (numerator: bigint, denominator: bigint): bigint => (numerator + denominator - 1n) / denominator;
const halfUp = (numerator: bigint, denominator: bigint): bigint => (2n * numerator + denominator) / (2n * denominator);

function centsAtEnding({ numerator, denominator }: Fraction, ending: bigint): bigint {
  const remainder = numerator * 100n - ending * denominator;
  return (remainder <= 0n ? 0n : ceil(remainder, 100n * denominator)) * 100n + ending;
}

function roundedAmount(computed: Fraction, rounding: PricingRule['rounding'], currency: string | null, floor: Fraction | null = null): Amount | null {
  const { numerator, denominator } = computed;
  if (numerator <= 0n) return null;
  // An explicit floor can lift a positive subtotal that would round to zero.
  let cents: bigint;
  if (rounding === 'ending-99' || rounding === 'ending-95') {
    cents = centsAtEnding(floor && greater(floor, computed) ? floor : computed, rounding === 'ending-99' ? 99n : 95n);
  } else if (rounding === 'nearest-whole') {
    const whole = halfUp(numerator, denominator);
    const minimum = floor ? ceil(floor.numerator, floor.denominator) : 0n;
    cents = 100n * (whole < minimum ? minimum : whole);
  } else {
    cents = halfUp(100n * numerator, denominator);
    const minimum = floor ? ceil(100n * floor.numerator, floor.denominator) : 0n;
    if (cents < minimum) cents = minimum;
  }
  const whole = (cents / 100n).toString();
  if (cents <= 0n || whole.length > 64) return null;
  return { units: cents, scale: 2, text: whole + '.' + (cents % 100n).toString().padStart(2, '0'), currency };
}

export function roundRetail(amount: Amount, rounding: PricingRule['rounding']): Amount | null {
  return roundedAmount(fraction(amount), rounding, amount.currency);
}

type ComputedAmount = Amount & { matchedTier?: string };
type TieredRule = Extract<PricingRule, { mode: 'tiered-brackets' }>;

function compileBrackets(rule: TieredRule) {
  return rule.brackets.map((bracket, index) => {
    const cutoff = bracket.upTo === null ? null : fraction(readAmount(bracket.upTo)!);
    const isMultiplier = bracket.mode === 'multiplier';
    const base = fraction(readAmount(isMultiplier ? bracket.multiplier : bracket.markupPercent)!);
    const factor = isMultiplier ? base : add({ numerator: 1n, denominator: 1n },
      { numerator: base.numerator, denominator: 100n * base.denominator });
    const fee = bracket.fixedFee === undefined ? null : fraction(readAmount(bracket.fixedFee)!);
    const limit = bracket.upTo === null ? 'catch-all' : '<= ' + bracket.upTo;
    const transform = isMultiplier ? bracket.multiplier + 'x' : '+' + bracket.markupPercent + '%';
    const matchedTier = 'Tier ' + (index + 1) + ' (' + limit + '): ' + transform +
      (bracket.fixedFee === undefined ? '' : ' + ' + bracket.fixedFee);
    return { cutoff, factor, fee, matchedTier };
  });
}

/** Prepare once per comparison, using a schema-validated rule. */
export function preparePricing(rule: PricingRule | undefined): (source: Amount) => ComputedAmount | null {
  if (rule === undefined || !changesRetail(rule)) return (source) => source.units > 0n ? source : null;
  const floor = rule.minimumRetail === undefined ? null : fraction(readAmount(rule.minimumRetail)!);
  const rate = rule.fx ? fraction(readAmount(rule.fx.fxRate)!) : null;
  const adjustment = rule.retailAdjustmentPercent === undefined ? null : fraction(readAmount(rule.retailAdjustmentPercent)!);
  const adjustmentFactor = adjustment && { numerator: 100n * adjustment.denominator + adjustment.numerator, denominator: 100n * adjustment.denominator };
  const finish = (subtotal: Fraction, currency: string | null) =>
    roundedAmount(adjustmentFactor ? multiply(subtotal, adjustmentFactor) : subtotal, rule.rounding, rate ? null : currency, floor);
  if (rule.mode === 'tiered-brackets') {
    const brackets = compileBrackets(rule);
    return (source) => {
      if (source.units <= 0n) return null;
      const cost = rate ? multiply(fraction(source), rate) : fraction(source);
      const { factor, fee, matchedTier } = brackets.find(({ cutoff }) => !cutoff || !greater(cost, cutoff))!;
      const multiplied = multiply(cost, factor);
      const computed = finish(fee ? add(multiplied, fee) : multiplied, source.currency);
      return computed && { ...computed, matchedTier };
    };
  }
  let factor: Fraction = { numerator: 1n, denominator: 1n };
  let fee: Fraction | null = null;
  if (rule.mode === 'multiplier') {
    factor = fraction(readAmount(rule.multiplier)!);
    if (rule.fixedFee !== undefined) fee = fraction(readAmount(rule.fixedFee)!);
  } else if (rule.mode === 'percent-markup' || rule.mode === 'target-margin') {
    const { numerator, denominator } = fraction(readAmount(rule.mode === 'percent-markup' ? rule.markupPercent : rule.marginPercent)!);
    const hundred = 100n * denominator;
    factor = rule.mode === 'percent-markup'
      ? { numerator: hundred + numerator, denominator: hundred }
      : { numerator: hundred, denominator: hundred - numerator };
  }

  // The FX factor and pricing factor can be combined without rounding between them.
  if (rate) factor = multiply(rate, factor);
  return (source) => {
    if (source.units <= 0n) return null;
    const multiplied = multiply(fraction(source), factor);
    const computed = fee === null ? multiplied : add(multiplied, fee);
    return finish(computed, source.currency);
  };
}

/** Illustrative examples use post-FX costs in the store currency. */
export function previewTierBrackets(rule: PricingRule | undefined): { matchedTier: string; sampleCost: string; computedPrice: string | null }[] {
  if (rule?.mode !== 'tiered-brackets' || validatePricingRule(rule)) return [];
  const apply = preparePricing({ ...rule, fx: undefined });
  return compileBrackets(rule).map(({ matchedTier }, index) => {
    const cutoff = rule.brackets[index].upTo;
    const previous = cutoff === null ? readAmount(rule.brackets[index - 1].upTo!)! : null;
    const sample = previous ? add(fraction(previous), { numerator: 1n, denominator: 100n }) : null;
    const scale = previous ? previous.scale + 2 : 0;
    const digits = sample?.numerator.toString().padStart(scale + 1, '0');
    const sampleCost = digits ? digits.slice(0, -scale) + '.' + digits.slice(-scale).replace(/0+$/, '').padEnd(2, '0') : cutoff!;
    const amount = readAmount(sampleCost);
    return { matchedTier, sampleCost, computedPrice: amount ? apply(amount)?.text ?? null : null };
  });
}

export function prepareMappedCompareAt(fx: FxConversion | undefined, allowZero = false): (source: Amount) => Amount | null {
  if (!fx) return (source) => source;
  const rate = fraction(readAmount(fx.fxRate)!);
  return (source) => allowZero && source.units === 0n
    ? { units: 0n, scale: 2, text: '0.00', currency: null }
    : roundedAmount(multiply(fraction(source), rate), 'none', null);
}

export function prepareAutoCompareAt(rule: PricingRule | undefined): ((retail: Amount) => Amount | null) | undefined {
  if (!rule?.compareAtRule) return undefined;
  const factor = fraction(readAmount(rule.compareAtRule.multiplier)!);
  return (retail) => roundedAmount(multiply(fraction(retail), factor), rule.rounding, null);
}
