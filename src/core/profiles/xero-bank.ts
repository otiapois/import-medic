import { auditBankBalance, type BankMovement } from '../accounting/balance-chain';
import type { Journal } from '../journal';
import { auditProjection, columnIndex, headerAliases, requireColumn, type Table, type WorkingRow } from '../table';
import type { RepairOptions } from '../types';
import { repairAmount, repairDate, reviewAmountSymbols, reviewCurrencies } from '../values';

const dateColumn = '*Date';
const amountColumn = '*Amount';
const nativeColumns = [dateColumn, amountColumn, 'Payee', 'Description', 'Reference', 'Check Number'];

export const xeroAliases = headerAliases({
  [dateColumn]: ['Date', 'Transaction Date', 'Posting Date', 'Post Date', 'Posted Date'],
  [amountColumn]: ['Amount', 'Transaction Amount'],
  Payee: ['Payer'],
  Description: ['Memo', 'Details', 'Transaction Description'],
  Reference: ['Ref', 'Reference Number'],
  'Check Number': ['Cheque Number', 'Check No.', 'Cheque No.'],
  Balance: ['Running Balance'],
  Currency: ['Currency Code', 'Transaction Currency'],
});

export function repairXero(table: Table, journal: Journal, options: RepairOptions): string[] {
  const date = requireColumn(table, dateColumn, journal);
  const amount = requireColumn(table, amountColumn, journal);
  const movements = new Map<WorkingRow, BankMovement>();
  if (date === undefined || amount === undefined) {
    auditBankBalance(table, journal, movements, dateColumn);
    return table.headers;
  }
  const balance = columnIndex(table, 'Balance');
  const currency = columnIndex(table, 'Currency');
  const rows = table.rows.filter(({ invalid }) => !invalid);
  const currencies = currency === undefined ? undefined : reviewCurrencies(rows, currency, journal, true, true);
  if (currency === undefined) {
    const columns = [{ index: amount, name: amountColumn }];
    if (balance !== undefined) columns.push({ index: balance, name: 'Balance' });
    reviewAmountSymbols(rows, columns, journal, true);
  }
  const headers = nativeColumns.filter((column) => columnIndex(table, column) !== undefined);
  const projection = headers.map((column) => table.positions.get(column.toLowerCase())!);
  auditProjection(table, new Set(headers), journal);
  const inputOrder = options.dateOrder === 'auto' ? undefined : options.dateOrder;
  for (const row of rows) {
    const line = row.source.line;
    const currencyCode = currencies?.get(row);
    const repairedDate = repairDate(row.cells[date], journal, { row: line, column: dateColumn }, inputOrder, 'YMD', { blockInvalid: true });
    const movement = repairAmount(row.cells[amount], line, amountColumn, journal, { blockInvalid: true, allowTrailingMinus: true, currencyCode });
    if (balance !== undefined) movements.set(row, { date: repairedDate.iso, amount: movement.valid ? movement.value : undefined, amountColumn });
    if (journal.bookkeeperAmounts) {
      journal.bookkeeperAmounts.push({ row: line, currency: currencyCode ?? null, amounts: movement.valid ? { amount: movement.value } : {} });
    }
    row.after = [repairedDate.value, movement.value, ...projection.slice(2).map((index) => row.cells[index])];
  }
  auditBankBalance(table, journal, movements, dateColumn, currencies);
  return headers;
}
