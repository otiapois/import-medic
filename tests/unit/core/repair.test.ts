import { describe, expect, it } from 'vitest';
import { applyManualCellEdits, getSourceColumn, repairCsv } from '../../../src/core/index';

const bytes = (csv: string) => new TextEncoder().encode(csv);

describe('repairCsv', () => {
  it('preserves source records and identifies an overflow at its physical line', () => {
    const result = repairCsv(bytes('Handle,Title,Body (HTML)\r\nfirst,First,"one\r\ntwo"\nsecond,Second,Body,overflow\r'), 'products.csv', 'shopify-products');

    expect(result.rows[0]).toMatchObject({ row: 2, before: ['first', 'First', 'one\r\ntwo'] });
    expect(result.rows[1]).toMatchObject({ row: 4, before: ['second', 'Second', 'Body', 'overflow'] });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'row-width', row: 4, column: 'CSV row', editable: false }));
    expect(result.canDownload).toBe(false);
    expect(result.repairedCsv).toBe('');
  });

  it('keeps initial cells and later edits auditable across passes on a modern Shopify CSV', () => {
    const source = bytes('URL handle,Title,SKU,Price\nMy Product,Product,001,broken\n');
    const initial = repairCsv(source, 'products.csv', 'shopify-products');
    const issue = initial.issues.find(({ code }) => code === 'invalid-price')!;
    expect(issue).toMatchObject({ row: 2, column: 'Variant Price', editable: true, rawValue: 'broken' });
    expect(getSourceColumn(initial.platform, initial.sourceHeaders, issue.column)).toBe('Price');
    const result = applyManualCellEdits(source, 'products.csv', 'shopify-products', {}, [{ row: issue.row, column: issue.column, value: '$24.50' }]);

    expect(result).toMatchObject({ sourceHeaders: ['URL handle', 'Title', 'SKU', 'Price'], needsManualReviewCount: 0, canDownload: true });
    expect(result.rows[0]).toMatchObject({ before: ['My Product', 'Product', '001', 'broken'], after: ['my-product', 'Product', '001', '24.50'] });
    expect(result.changes).toContainEqual(expect.objectContaining({ row: 2, column: 'Variant Price', before: 'broken', after: '$24.50', code: 'manual-edit' }));
    expect(result.repairedCsv).toBe('Handle,Title,Variant SKU,Variant Price\nmy-product,Product,001,24.50');
  });

  it('blocks normalization that would merge two different Shopify handles', () => {
    const source = bytes('Handle,Title,Variant SKU\nDemo Product,First Product,001\ndemo-product,Another Product,002');
    const result = repairCsv(source, 'products.csv', 'shopify-products');

    expect(result.issues.filter(({ code }) => code === 'handle-collision').map(({ row }) => row)).toEqual([2, 3]);
    expect(result.rows.map(({ after }) => after[0])).toEqual(['Demo Product', 'demo-product']);
    expect(result.canDownload).toBe(false);
  });

  it('requires a source convention for bare Credit/Debit and exports Intuit directions', () => {
    const source = bytes('Date,Description,Credit,Debit\n2026-11-24,Payment,,23.75\n2026-11-25,Deposit,80.00,');
    const options = { qboLayout: '4col' } as const;
    const unknown = repairCsv(source, 'bank.csv', 'quickbooks-bank', options);
    const known = repairCsv(source, 'bank.csv', 'quickbooks-bank', { ...options, qboCreditDebit: 'bank' });

    expect(unknown.issues).toContainEqual(expect.objectContaining({ code: 'credit-debit-direction', row: 1, column: 'Credit/Debit' }));
    expect(unknown.repairedCsv).toBe('');
    expect(known.repairedCsv).toBe('Date,Description,Credit,Debit\r\n11/24/2026,Payment,23.75,\r\n11/25/2026,Deposit,,80.00');
    expect(known.roundtripCheck).toEqual({ checked: true, autoFixableRemaining: 0, needsManualReviewCount: 0 });
  });

  it('preserves a malformed quoted record for audit and withholds export', () => {
    const result = repairCsv(bytes('Handle,Title\nitem,"Unclosed title\nnext,Next'), 'products.csv', 'shopify-products');

    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'csv-parse-error', row: 2, autoFixed: false, rawValue: 'item,"Unclosed title\nnext,Next' }));
    expect(result.roundtripCheck.checked).toBe(false);
    expect(result.repairedCsv).toBe('');
  });

  it('retains every edit and reruns cross-row rules on the original bytes', () => {
    const source = bytes('Handle,Title,SKU,Price\nproduct,Product,001,broken\nproduct,,001,9.00');
    const edited = applyManualCellEdits(source, 'products.csv', 'shopify-products', {}, [
      { row: 2, column: 'Price', value: 'still broken' },
      { row: 3, column: 'Variant SKU', value: '002' },
    ]);
    expect(edited.issues.filter(({ autoFixed }) => !autoFixed)).toEqual([
      expect.objectContaining({ code: 'invalid-price', row: 2, rawValue: 'still broken' }),
    ]);
    expect(edited.rows.map(({ before }) => before)).toEqual([['product', 'Product', '001', 'broken'], ['product', '', '001', '9.00']]);
    expect(edited.rows.map(({ after }) => after)).toEqual([['product', 'Product', '001', 'still broken'], ['product', '', '002', '9.00']]);
    expect(edited.roundtripCheck).toEqual({ checked: true, autoFixableRemaining: 0, needsManualReviewCount: 1 });
  });

  it('preserves exact decimal precision and pins the generated date order during roundtrip', () => {
    const result = repairCsv(bytes('Date,Description,Amount\n2026-03-04,Exact amount,"($999,999,999,999,999,999.0123456789)"'), 'bank.csv', 'quickbooks-bank');
    expect(result.repairedCsv).toBe('Date,Description,Amount\r\n03/04/2026,Exact amount,-999999999999999999.0123456789');
    expect(result.roundtripCheck.autoFixableRemaining).toBe(0);
  });

  it.each(['3col', '4col'] as const)('blocks a signed zero with editable review in %s', (qboLayout) => {
    const result = repairCsv(bytes('Date,Description,Amount\n2026-03-04,Cancelled,+0.00'), 'bank.csv', 'quickbooks-bank', { qboLayout });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'invalid-amount', row: 2, column: 'Amount', editable: true, rawValue: '+0.00' }));
    expect(result.canDownload).toBe(false);
  });

  it('keeps a lone split zero blocked and clears a placeholder paired with a valid amount', () => {
    const source = bytes('Date,Description,Credit Amount,Debit Amount\n2026-11-24,Payment,23.75,0.00\n2026-11-25,Deposit,,0.00');
    const options = { qboLayout: '4col', qboCreditDebit: 'intuit' } as const;
    const result = repairCsv(source, 'bank.csv', 'quickbooks-bank', options);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'invalid-amount', row: 3, column: 'Debit', editable: true, rawValue: '0.00' }));
    expect(result.canDownload).toBe(false);
    const repaired = applyManualCellEdits(source, 'bank.csv', 'quickbooks-bank', options, [{ row: 3, column: 'Debit', value: '15.00' }]);
    expect(repaired.repairedCsv).toBe('Date,Description,Credit,Debit\r\n11/24/2026,Payment,23.75,\r\n11/25/2026,Deposit,,15.00');
  });

  it('retains zero in accounting output and blocks a zero Net in QuickBooks mode at the source cell', () => {
    const source = bytes('created_utc,description,gross,fee,net,currency,balance_transaction_id\n2026-11-24 18:31:53,Test,0.00,0.00,0.00,usd,txn-01');
    const accounting = repairCsv(source, 'payments.csv', 'stripe-paypal');
    expect(accounting.rows[0].after).toEqual(['2026-11-24', 'Test', '0.00', '0.00', '0.00', 'USD', 'txn-01']);
    expect(accounting.canDownload).toBe(true);
    const quickbooks = repairCsv(source, 'payments.csv', 'stripe-paypal', { stripePayPalOutput: 'quickbooks-3col' });
    expect(quickbooks.issues).toContainEqual(expect.objectContaining({ code: 'invalid-amount', row: 2, column: 'Net', editable: true, rawValue: '0.00' }));
    expect(quickbooks.canDownload).toBe(false);
  });
});
