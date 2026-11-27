import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyManualCellEdits, repairCsv } from '../../../src/core';
import { parseCsv, serializeCsv } from '../../../src/core/csv';
import { createBookkeeperSignoffHtml } from '../../../src/core/repair/bookkeeper-signoff';
import { repairAudit } from '../../../src/core/worker/repair-views';

const source = (headers: string[], rows: string[][]) => new TextEncoder().encode(serializeCsv(headers, rows, 'stripe-paypal'));
const stripeHeader = ['created_utc', 'description', 'gross', 'fee', 'net', 'currency', 'balance_transaction_id'];
const paypalHeader = ['Date', 'Name', 'Gross', 'Fee', 'Net', 'Currency', 'Transaction ID', 'Balance Impact'];
const accountingHeader = ['Date', 'Description', 'Gross', 'Fee', 'Net', 'Currency', 'Reference ID'];
const outputs = ['accounting', 'quickbooks-3col'] as const;
const stripe = (gross: string, fee: string, net: string, currency = 'USD') => ['2026-11-24T00:30:00Z', 'Stripe transaction', gross, fee, net, currency, 'txn_1'];
const paypal = (gross: string, fee: string, net: string, currency = 'USD') => ['2026-11-24', 'PayPal transaction', gross, fee, net, currency, 'P-1', net.startsWith('-') ? 'Debit' : 'Credit'];
const generatedAt = new Date('2026-11-27T05:00:00Z');

type AccountingGolden = {
  name: string;
  provider: 'stripe' | 'paypal';
  currency?: string;
  input: [gross: string, fee: string, net: string];
  normalized?: AccountingGolden['input'];
  expectedNet?: string;
};
const golden = JSON.parse(readFileSync(new URL('../../../fixtures/stripe-paypal/m9-accounting-golden.json', import.meta.url), 'utf8')) as AccountingGolden[];

it('covers at least 26 distinct named provider and amount fixtures', () => {
  expect(new Set(golden.map(({ name }) => name)).size).toBe(golden.length);
  const distinctInputs = golden.map(({ provider, currency = 'USD', input }) => JSON.stringify([provider, currency, input]));
  expect(new Set(distinctInputs).size).toBe(golden.length);
  expect(golden.length).toBeGreaterThanOrEqual(26);
});

describe.each(outputs)('%s accounting hardening', (stripePayPalOutput) => {
  const options = { stripePayPalOutput };
  it.each(golden)('$name', ({ provider, input, currency, normalized = input, expectedNet }) => {
    const headers = provider === 'stripe' ? stripeHeader : paypalHeader;
    const line = (provider === 'stripe' ? stripe : paypal)(...input, currency);
    const feeConvention = provider === 'stripe' ? 'deduction' : 'signed-movement';
    const result = repairCsv(source(headers, [line]), 'payment.csv', 'stripe-paypal', options);
    expect(result.stripePayPalFeeConvention).toBe(feeConvention);
    expect(result.rows[0].before).toEqual(line);
    const review = result.issues.filter(({ autoFixed }) => !autoFixed);
    if (expectedNet !== undefined) {
      expect(result.canDownload).toBe(false);
      expect(result.repairedCsv).toBe('');
      expect(review).toEqual([expect.objectContaining({
        row: 2, column: 'Net', code: 'reconciliation-mismatch', editable: true, fixedValue: undefined,
        reconciliation: { gross: input[0], fee: input[1], net: input[2], expectedNet, feeConvention },
      })]);
      expect(result.bookkeeperAmounts[0].amounts).toEqual({});
      return;
    }
    expect(result.canDownload).toBe(true);
    expect(review).toEqual([]);
    expect(parseCsv(result.repairedCsv).records[1].cells).toEqual(stripePayPalOutput === 'accounting'
      ? ['2026-11-24', line[1], ...normalized, line[5], line[6]] : ['11/24/2026', line[1], normalized[2]]);
    expect(result.roundtripCheck).toEqual({ checked: true, needsManualReviewCount: 0, autoFixableRemaining: 0 });
  });
});

it('finds a zero-Net discrepancy independently of the bank nonzero rule', () => {
  const result = repairCsv(source(stripeHeader, [stripe('1.01', '1.00', '-0.00')]), 'payment.csv', 'stripe-paypal', { stripePayPalOutput: 'quickbooks-3col' });
  expect(result.canDownload).toBe(false);
  expect(result.issues.filter(({ autoFixed }) => !autoFixed).map(({ code }) => code)).toEqual(['invalid-amount', 'reconciliation-mismatch']);
  expect(result.issues.find(({ code }) => code === 'reconciliation-mismatch')?.reconciliation).toEqual({
    gross: '1.01', fee: '1.00', net: '-0.00', expectedNet: '0.01', feeConvention: 'deduction',
  });
});

it.each([
  [stripeHeader, stripe('40.00', '-2.32', '37.68'), 'signed-movement'],
  [paypalHeader, paypal('40.00', '2.32', '37.68'), 'deduction'],
] as const)('preserves the known provider convention against an explicit conflicting choice', (headers, row, stripePayPalFeeConvention) => {
  const result = repairCsv(source([...headers], [row]), 'payment.csv', 'stripe-paypal', { stripePayPalFeeConvention });
  expect(result.canDownload).toBe(false);
  expect(result.stripePayPalFeeConvention).not.toBe(stripePayPalFeeConvention);
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'reconciliation-mismatch', row: 2 }));
});

it('holds the PayPal file when a later row switches convention and applies an explicit audited correction', () => {
  const input = source(paypalHeader, [paypal('40.00', '-2.32', '37.68'), paypal('-40.00', '2.32', '-42.32')]);
  const result = repairCsv(input, 'payment.csv', 'stripe-paypal');
  expect(result.issues.filter(({ code }) => code === 'reconciliation-mismatch').map(({ row }) => row)).toEqual([3]);
  const edited = applyManualCellEdits(input, 'payment.csv', 'stripe-paypal', {}, [{ row: 3, column: 'Net', value: '-37.68' }]);
  expect(edited.canDownload).toBe(true);
  expect(edited.rows[1].before[4]).toBe('-42.32');
  expect(edited.rows[1].after[4]).toBe('-37.68');
  expect(edited.changes).toContainEqual(expect.objectContaining({ row: 3, code: 'manual-edit', before: '-42.32', after: '-37.68' }));
  const canonical = repairCsv(new TextEncoder().encode(edited.repairedCsv), 'accounting.csv', 'stripe-paypal', { stripePayPalFeeConvention: 'signed-movement' });
  expect(canonical.repairedCsv).toBe(edited.repairedCsv);
});

it.each([
  ['Gross with no Fee header', ['Date', 'Description', 'Gross', 'Net', 'Currency'], ['2026-11-24', 'Unbalanced', '12.00', '10.00', 'USD'], 'missing-header', 1, 'Fee'],
  ['Fee with no Gross header', ['Date', 'Description', 'Fee', 'Net', 'Currency'], ['2026-11-24', 'Unbalanced', '2.00', '10.00', 'USD'], 'missing-header', 1, 'Gross'],
  ['blank Gross', accountingHeader, ['2026-11-24', 'Unbalanced', '', '2.00', '10.00', 'USD', 'A1'], 'missing-amount', 2, 'Gross'],
  ['ambiguous Fee', accountingHeader, ['2026-11-24', 'Unbalanced', '1010.00', '1,000', '10.00', 'USD', 'A1'], 'invalid-amount', 2, 'Fee'],
] as const)('blocks bank projection for %s', (_, headers, line, code, row, column) => {
  const result = repairCsv(source([...headers], [[...line]]), 'payment.csv', 'stripe-paypal', { stripePayPalOutput: 'quickbooks-3col' });
  expect(result.canDownload).toBe(false);
  expect(result.issues.filter(({ autoFixed }) => !autoFixed)).toContainEqual(expect.objectContaining({ code, row, column }));
});

it('retains bank conversion for a Net-only source with no Gross and Fee columns', () => {
  const result = repairCsv(source(['Date', 'Description', 'Net', 'Currency'], [['2026-11-24', 'Net only', '7.43', 'GBP']]),
    'net-only.csv', 'stripe-paypal', { stripePayPalOutput: 'quickbooks-3col' });
  expect(result.canDownload).toBe(true);
  expect(result.repairedCsv).toBe('Date,Description,Amount\r\n11/24/2026,Net only,7.43');
});

it.each(['3col', '4col'] as const)('groups all explicit QuickBooks currencies by physical input line for %s', (qboLayout) => {
  const raw = readFileSync(new URL('../../../fixtures/quickbooks/m9-mixed-currency-physical-lines.csv', import.meta.url));
  const result = repairCsv(raw, 'statement.csv', 'quickbooks-bank', { qboLayout });
  const currencySplit = [{ currency: 'USD', lines: [3, 9] }, { currency: 'EUR', lines: [5] }, { currency: 'SAR', lines: [6] },
    { currency: 'AED', lines: [7] }, { currency: 'GBP', lines: [8] }];
  expect(result.canDownload).toBe(false);
  expect(result.currencySplit).toEqual(currencySplit);
  expect(result.issues.filter(({ code }) => code === 'multi-currency').map(({ row }) => row)).toEqual([5, 6, 7, 8]);
  expect(result.rows.map(({ row }) => row)).toEqual([3, 5, 6, 7, 8, 9]);
  expect(repairAudit(result, { qboLayout }).currencySplit).toEqual(currencySplit);
  const report = createBookkeeperSignoffHtml(result, { generatedAt });
  expect(report).toContain('Currency split required');
  expect(report).toContain('<th scope="row">USD</th><td>2</td><td>3, 9</td>');
});

it.each(outputs)('uses only retained payment currencies for %s and excludes a distinct Memo currency', (stripePayPalOutput) => {
  const raw = readFileSync(new URL('../../../fixtures/stripe-paypal/m9-paypal-currency-split.csv', import.meta.url));
  const result = repairCsv(raw, 'paypal.csv', 'stripe-paypal', { stripePayPalOutput, excludePayPalMemo: true });
  expect(result.canDownload).toBe(stripePayPalOutput === 'accounting');
  expect(result.removedRows.map(({ row }) => row)).toEqual([4]);
  expect(result.currencySplit).toEqual(stripePayPalOutput === 'accounting' ? undefined : [{ currency: 'USD', lines: [2, 6] }, { currency: 'GBP', lines: [5] }]);
});

it('displays escaped reconciliation and custody without totaling disputed amounts', () => {
  const raw = readFileSync(new URL('../../../fixtures/stripe-paypal/m9-paypal-reconciliation.csv', import.meta.url));
  const result = repairCsv(raw, 'paypal.csv', 'stripe-paypal');
  const html = createBookkeeperSignoffHtml(result, { generatedAt, custody: { sourceSha256: 'a'.repeat(64) } });
  expect(html).toContain('Expected Net');
  expect(html).toContain('-37.68');
  expect(html).toContain('Gross + Fee');
  expect(html).toContain('1 retained line has no reportable amount');
  expect(html).toContain('a'.repeat(64));
  expect(html).not.toContain('<script>');
});
