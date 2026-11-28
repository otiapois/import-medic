import { auditTaxReconciliation, trackDuplicateTransactions } from '../accounting/tax-duplicate';
import type { Journal } from '../journal';
import { auditProjection, columnIndex, headerAliases, requireColumn, type Table } from '../table';
import type { FreshBooksTaxRow, RepairOptions } from '../types';
import { currencyFractionDigits, repairAmount, repairDate, reviewCurrencies } from '../values';

const requiredColumns = ['Date', 'Vendor', 'Category', 'Notes', 'Amount', 'Currency'] as const;
const nativeColumns = ['Date', 'Vendor', 'Category', 'Notes', 'Amount', 'Tax 1 Name', 'Tax 1 Amount', 'Currency'];

export const freshBooksAliases = headerAliases({
  Date: ['Expense Date', 'Transaction Date'],
  Vendor: ['Merchant'],
  Category: ['Expense Category'],
  Notes: ['Description', 'Memo'],
  Amount: ['Expense Amount', 'Transaction Amount'],
  'Tax 1 Name': ['Tax Name'],
  'Tax 1 Amount': ['Tax Amount'],
  Currency: ['Currency Code', 'Expense Currency', 'Transaction Currency'],
});

export function repairFreshBooks(table: Table, journal: Journal, options: RepairOptions, collectTaxes: boolean): string[] {
  auditTaxReconciliation(table, journal);
  const required = requiredColumns.map((column) => requireColumn(table, column, journal));
  if (required.some((index) => index === undefined)) return table.headers;
  const [date, vendor, category, notes, amount, currency] = required as number[];
  const taxName = columnIndex(table, 'Tax 1 Name');
  const taxAmount = columnIndex(table, 'Tax 1 Amount');
  const rows = table.rows.filter(({ invalid }) => !invalid);
  const currencies = reviewCurrencies(rows, currency, journal, true, true);
  const decimals = new Map([...new Set(currencies.values())].map((code) => [code, currencyFractionDigits(code)]));
  const inputOrder = options.dateOrder === 'auto' ? undefined : options.dateOrder;
  const taxes: FreshBooksTaxRow[] = [];
  const duplicateAudit = trackDuplicateTransactions(table, journal, ['Vendor', 'Notes']);
  let firstSign: boolean | undefined;
  auditProjection(table, new Set(nativeColumns), journal);
  for (const row of rows) {
    const line = row.source.line;
    const currencyCode = currencies.get(row);
    const dateValue = repairDate(row.cells[date], journal, { row: line, column: 'Date' }, inputOrder, 'ISO', { blockInvalid: true });
    const rawAmount = row.cells[amount];
    const movement = repairAmount(rawAmount, line, 'Amount', journal, {
      blockInvalid: true, nonzero: true, currencyCode, allowTrailingMinus: true, layoutName: 'FreshBooks expense CSV',
    });
    let validAmount = movement.valid;
    if (validAmount && currencyCode) {
      const [, fraction = ''] = movement.value.split('.');
      if (fraction.replace(/0+$/, '').length > decimals.get(currencyCode)!) {
        journal.issue('freshbooks-amount-scale', line, 'Amount', rawAmount, `This amount exceeds the supported decimal precision of ${currencyCode}.`, { editable: true, block: true });
        validAmount = false;
      }
    }
    if (validAmount) {
      duplicateAudit?.record(row, dateValue.iso, movement.value, rawAmount, currencyCode);
      const negative = movement.value.startsWith('-');
      firstSign ??= negative;
      if (firstSign !== negative) {
        journal.issue('freshbooks-mixed-sign', line, 'Amount', rawAmount,
          'FreshBooks imports only negative rows from a mixed-sign file. Use a single sign for expense imports, or use FreshBooks Bank Reconciliation for the full ledger.',
          { block: true });
      }
    }
    const name = taxName === undefined ? '' : row.cells[taxName];
    const tax = taxAmount === undefined ? '' : row.cells[taxAmount];
    if (collectTaxes && (name || tax)) taxes.push({ row: line, name, amount: tax });
    const taxValue = repairAmount(tax, line, 'Tax 1 Amount', journal, { required: false, currencyCode, allowTrailingMinus: true }).value;
    row.after = [dateValue.value, row.cells[vendor], row.cells[category], row.cells[notes], movement.value, name, taxValue, currencyCode ?? row.cells[currency]];
    journal.bookkeeperAmounts?.push({ row: line, currency: currencyCode ?? null, amounts: validAmount ? { amount: movement.value } : {} });
  }
  duplicateAudit?.finish();
  if (taxes.length > 0) journal.freshBooksTaxes = taxes;
  return nativeColumns;
}
