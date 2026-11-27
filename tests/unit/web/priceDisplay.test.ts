import { describe, expect, it } from 'vitest';
import { formatMarginPercent, formatPriceChange } from '../../../src/web/workbench/priceDisplay';

describe('price diff Change display', () => {
  it.each([
    [null, '—'],
    ['13.043478', '+13.04%'],
    ['-10', '-10%'],
    ['1.2', '+1.2%'],
    ['-1.005', '-1.01%'],
    ['-0.004999', '0%'],
    ['9.999999', '+10%'],
    ['9999999999999999999999.984899', '+9999999999999999999999.98%'],
  ])('displays %s as %s', (delta, label) => {
    expect(formatPriceChange(delta)).toBe(label);
  });
});

describe('projected margin display', () => {
  it.each([
    [null, 'Unknown'],
    ['50.000000', '50.00%'],
    ['41.767284', '41.77%'],
    ['-1.005000', '-1.01%'],
    ['-0.000001', '0.00%'],
    ['9999999999999999999999.984899', '9999999999999999999999.98%'],
  ])('displays %s as %s', (percent, label) => {
    expect(formatMarginPercent(percent)).toBe(label);
  });
});
