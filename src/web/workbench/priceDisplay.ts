export function formatPriceChange(deltaPercent: string | null) {
  if (deltaPercent === null) return '—';
  const negative = deltaPercent.startsWith('-');
  const [whole, fraction = ''] = (negative ? deltaPercent.slice(1) : deltaPercent).split('.');
  const thousandths = BigInt(whole + fraction.slice(0, 3).padEnd(3, '0'));
  const hundredths = (thousandths + 5n) / 10n;
  if (hundredths === 0n) return '0%';
  const decimal = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${negative ? '-' : '+'}${hundredths / 100n}${decimal ? `.${decimal}` : ''}%`;
}
