import { expect, it } from 'vitest';
import { applyManualCellEdits, repairCsv } from '../../../src/core';
import { serializeCsv } from '../../../src/core/csv';
import { createBookkeeperSignoffHtml } from '../../../src/core/repair/bookkeeper-signoff';

const csv = (headers: string[], rows: string[][]) => new TextEncoder().encode(serializeCsv(headers, rows, 'shopify-products'));
const generatedAt = new Date('2026-11-27T05:00:00.000Z');

it('displays validated, separate currencies, unique source counts and safe original lines after edits/exclusions', () => {
  const hostile = '<script src="https://example.invalid/a.js">&</script>';
  const bytes = csv(['Date', 'Description', 'Gross', 'Fee', 'Net', 'Currency', 'Balance Impact'], [
    ['2026-11-24', 'A multiline\nrecord', '$10.01', '0.02', '9.99', 'usd', 'Credit'],
    ['2026-11-24', hostile, '9007199254740993.0001', '0.17', '9007199254740992.8301', 'EUR', 'Credit'],
    ['2026-11-24', 'Excluded', '100.00', '0', '100.00', 'USD', 'Memo'],
    ['2026-11-24', 'Unknown currency', '100.00', '0', '100.00', 'ZZZ', 'Credit'],
    ['2026-11-24', 'Mismatched symbol', '$999.00', '$0.50', '$998.50', 'EUR', 'Credit'],
  ]);
  const result = applyManualCellEdits(bytes, `client-${hostile}.csv`, 'stripe-paypal', { excludePayPalMemo: true }, [
    { row: 4, column: 'Description', value: 'Reviewed' },
  ]);
  expect(result.removedRows.map(({ row }) => row)).toEqual([5]);
  const html = createBookkeeperSignoffHtml(result, { detectedProvider: 'PayPal', generatedAt });
  expect(html).toContain('<dt>Total rows</dt><dd>5</dd>');
  expect(html).toContain('<dt>Auto-fixed cells</dt><dd>2</dd>');
  expect(html).toContain('<dt>Manually edited cells</dt><dd>1</dd>');
  expect(html).toContain('<dt>Blocked / flagged lines</dt><dd>1</dd>');
  expect(html).toContain('<dt>Excluded memo / non-transaction rows</dt><dd>1</dd>');
  expect(html).toContain('<th scope="row">USD</th><td>1</td><td>10.01');
  expect(html).toContain('<th scope="row">EUR</th><td>1</td><td>9007199254740993.0001');
  expect(html).toContain('9007199254740992.8301');
  expect(html).not.toContain('<th scope="row">ZZZ</th>');
  expect(html).toContain('<th scope="row">4</th><td><ul><li><strong>Manual edit</strong>');
  expect(html).toContain('https&#58;//example.invalid/a.js');
  expect(html).toContain('2026-11-27T05:00:00.000Z');
  expect(html).toContain('Content-Security-Policy');
  expect(html).not.toMatch(/<script\b|src="|href="|https?:\/\//i);
});

it('takes signed QBO amounts and manual currency after projection, even with a bank download held', () => {
  const bytes = csv(['Transaction Date', 'Memo', 'Credit', 'Debit', 'Currency Code'], [
    ['2026-11-24', 'Deposit', '12.123', '', 'cad'], ['2026-11-24', 'Fine', '', '3.01', 'GBP'],
    ['2026-11-24', 'Ambiguous amount', '', '1,000', 'CAD'], ['2026-11-24', 'Unknown currency', '12.00', '', ''],
  ]);
  const result = applyManualCellEdits(bytes, 'ledger.csv', 'quickbooks-bank', { qboLayout: '4col', qboCreditDebit: 'bank' }, [
    { row: 3, column: 'Currency Code', value: 'USD' },
  ]);
  expect(result.headers).toEqual(['Date', 'Description', 'Credit', 'Debit']);
  expect(result.canDownload).toBe(false);
  const html = createBookkeeperSignoffHtml(result, { generatedAt });
  expect(html).toContain('QuickBooks bank (4-column target)');
  expect(html).toContain('<th scope="row">CAD</th><td>1</td><td>12.123');
  expect(html).toContain('<th scope="row">USD</th><td>1</td><td>-3.01');
  expect(html).not.toContain('<th scope="row">GBP</th>');
  expect(html).toContain('2 retained lines have no reportable amount');
  const shopify = repairCsv(csv(['Handle', 'Title'], [['product', 'Example']]), 'shop.csv', 'shopify-products');
  expect(createBookkeeperSignoffHtml(shopify, { generatedAt })).toContain('No monetary totals are available.');
});

it('retains full repair counts while explicitly bounding rendered source lines', () => {
  const rows = Array.from({ length: 600 }, (_, index) => ['2026-11-24', 'Deposit ' + index, '$1.00', 'USD']);
  const result = repairCsv(csv(['Date', 'Description', 'Amount', 'Currency'], rows), 'account.csv', 'quickbooks-bank');
  const html = createBookkeeperSignoffHtml(result, { generatedAt });
  expect(html).toContain('<dt>Auto-fixed cells</dt><dd>1200</dd>');
  expect(html).toContain('<th scope="row">USD</th><td>600</td><td>600.00');
  expect(html).toContain('Showing 500 of 601 source lines');
  expect(html).not.toContain('<th scope="row">501</th>');
});

it('keeps source payment totals across QuickBooks projection and omits conflicting PayPal directions and retained memos', () => {
  const bytes = csv(['Date', 'Description', 'Gross', 'Fee', 'Net', 'Currency', 'Balance Impact'], [
    ['2026-11-24', 'Paid', '-10.10', '0.10', '-10.20', 'USD', 'Debit'],
    ['2026-11-24', 'Source mismatch', '99.00', '0.00', '99.00', 'USD', 'Debit'],
    ['2026-11-24', 'Memo', '42.00', '0.00', '42.00', 'USD', 'Memo'],
  ]);
  const options = { stripePayPalOutput: 'quickbooks-3col' } as const;
  const result = repairCsv(bytes, 'payments.csv', 'stripe-paypal', options);
  expect(result.headers).toEqual(['Date', 'Description', 'Amount']);
  expect(result.canDownload).toBe(false);
  const html = createBookkeeperSignoffHtml(result, { generatedAt, options });
  expect(html).toContain('QuickBooks 3-column bank CSV');
  expect(html).toContain('<th scope="row">USD</th><td>1</td><td>-10.10 <small>1 value</small></td><td>0.10 <small>1 value</small></td><td>-10.20');
  expect(html).toContain('2 retained lines have no reportable amount');
});
