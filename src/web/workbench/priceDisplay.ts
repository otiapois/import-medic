function roundedPercentParts(percent: string) {
  const negative = percent.startsWith('-');
  const [whole, fraction = ''] = (negative ? percent.slice(1) : percent).split('.');
  const thousandths = BigInt(whole + fraction.slice(0, 3).padEnd(3, '0'));
  const hundredths = (thousandths + 5n) / 10n;
  return { negative: negative && hundredths !== 0n, whole: hundredths / 100n, decimal: String(hundredths % 100n).padStart(2, '0') };
}

export function formatPriceChange(deltaPercent: string | null) {
  if (deltaPercent === null) return '—';
  const { negative, whole, decimal } = roundedPercentParts(deltaPercent);
  const visibleDecimal = decimal.replace(/0+$/, '');
  if (whole === 0n && !visibleDecimal) return '0%';
  return `${negative ? '-' : '+'}${whole}${visibleDecimal ? `.${visibleDecimal}` : ''}%`;
}

export function formatMarginPercent(percent: string | null) {
  if (percent === null) return 'Unknown';
  const { negative, whole, decimal } = roundedPercentParts(percent);
  return `${negative ? '-' : ''}${whole}.${decimal}%`;
}
