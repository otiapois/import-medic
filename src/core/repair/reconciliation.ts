import type { FeeConvention } from '../types';

// Call only with validated decimal strings. Align fractional precision without rounding.
export function expectedPaymentNet(gross: string, fee: string, net: string, convention: FeeConvention): string | undefined {
  const amounts = [gross, fee, net].map((value) => value.split('.'));
  const scale = Math.max(2, ...amounts.map(([, fraction]) => fraction?.length ?? 0));
  const [grossUnits, feeUnits, netUnits] = amounts.map(([whole, fraction = '']) => BigInt(whole + fraction.padEnd(scale, '0')));
  const expected = convention === 'deduction' ? grossUnits - feeUnits : grossUnits + feeUnits;
  if (expected === netUnits) return undefined;
  const magnitude = (expected < 0n ? -expected : expected).toString().padStart(scale + 1, '0');
  return (expected < 0n ? '-' : '') + magnitude.slice(0, -scale) + '.' + magnitude.slice(-scale);
}
