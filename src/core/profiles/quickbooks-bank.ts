import { auditBankBalance, type BankMovement } from '../accounting/balance-chain';
import type { CsvRecord } from '../csv';
import type { Journal } from '../journal';
import { auditProjection, columnIndex, headerAliases, requireColumn, type Table, type WorkingRow } from '../table';
import type { DateOrder, RepairOptions } from '../types';
import { inferDateOrder, isZeroAmount, normalizeAmount, normalizeDescription, repairAmount, repairDate, reviewAmountSymbols, reviewCurrencies } from '../values';

export const quickBooksAliases = headerAliases({
  Date: ['Transaction Date', 'Post Date', 'Posted Date', 'Posting Date'],
  Description: ['Memo', 'Payee', 'Details', 'Transaction Description'],
  Amount: ['Transaction Amount'],
  Currency: ['Currency Code', 'Transaction Currency'],
  Credit: ['Credit Amount'],
  Debit: ['Debit Amount'],
  'Money In': ['Deposit', 'Deposits', 'Money Received'],
  'Money Out': ['Withdrawal', 'Withdrawals', 'Money Spent'],
  Balance: ['Running Balance'],
});

export const QUICKBOOKS_3COL = ['Date', 'Description', 'Amount'];
const QUICKBOOKS_4COL = ['Date', 'Description', 'Credit', 'Debit'];
const preamble = new Set(['account number', 'statement period', 'opening balance']);
const footer = new Set(['total', 'ending balance', 'closing balance']);
const recordLabel = (record: CsvRecord): string => record.cells[0]?.trim().toLowerCase() ?? '';

export function stripBankStatement(records: readonly CsvRecord[], journal: Journal): readonly CsvRecord[] {
  let start = 0;
  let end = records.length;
  const isBlank = (record: CsvRecord) => !record.parseError && record.raw.trim() === '';
  while (start < end && (isBlank(records[start]) ||
    (!records[start].parseError && records[start].cells.length <= 2 && preamble.has(recordLabel(records[start]))))) {
    const record = records[start++];
    journal.remove(isBlank(record) ? 'blank-row' : 'bank-preamble', record, 'Removed a non-transaction record before the bank header.');
  }
  while (end > start) {
    const record = records[end - 1];
    const summary = !record.parseError && footer.has(recordLabel(record)) && record.cells.length <= 2 &&
      (record.cells.length === 1 || normalizeAmount(record.cells[1]) !== undefined);
    if (!summary && !isBlank(record)) break;
    journal.remove(summary ? 'bank-footer' : 'blank-row', record, 'Removed a non-transaction record after the last bank transaction.');
    end--;
  }
  return records.slice(start, end);
}

type Column = { index: number; name: string };
type SourceAmount = { signed: Column } | { spent: Column; received: Column };

function sourceAmount(table: Table, journal: Journal, options: RepairOptions): SourceAmount | undefined {
  const signed = columnIndex(table, 'Amount');
  const credit = columnIndex(table, 'Credit');
  const debit = columnIndex(table, 'Debit');
  const moneyIn = columnIndex(table, 'Money In');
  const moneyOut = columnIndex(table, 'Money Out');
  const bare = credit !== undefined || debit !== undefined;
  const directional = moneyIn !== undefined || moneyOut !== undefined;
  if ((bare && directional) || (signed !== undefined && (bare || directional))) {
    journal.issue('ambiguous-header', table.headerLine, 'Amount', table.sourceHeaders.join(', '), 'Use one signed Amount column or exactly one payment/deposit pair.', { block: true });
    return undefined;
  }
  if (signed !== undefined) return { signed: { index: signed, name: 'Amount' } };
  if (bare) {
    const first = requireColumn(table, 'Credit', journal);
    const second = requireColumn(table, 'Debit', journal);
    if (first === undefined || second === undefined) return undefined;
    const creditColumn = { index: first, name: 'Credit' };
    const debitColumn = { index: second, name: 'Debit' };
    if (options.qboCreditDebit === 'bank') return { spent: debitColumn, received: creditColumn };
    if (options.qboCreditDebit === 'intuit') return { spent: creditColumn, received: debitColumn };
    journal.issue('credit-debit-direction', table.headerLine, 'Credit/Debit', 'Credit, Debit', 'Choose whether your source places payments under Debit (bank) or Credit (Intuit).', { block: true });
  } else if (directional) {
    const spent = requireColumn(table, 'Money Out', journal);
    const received = requireColumn(table, 'Money In', journal);
    if (spent !== undefined && received !== undefined) {
      return { spent: { index: spent, name: 'Money Out' }, received: { index: received, name: 'Money In' } };
    }
  } else {
    requireColumn(table, 'Amount', journal, 'Add a signed Amount column or include both payment and deposit columns in your source export.');
  }
  return undefined;
}

function convertAmounts(row: WorkingRow, source: SourceAmount, splitTarget: boolean, journal: Journal, currencyCode?: string): string[] {
  const line = row.source.line;
  if ('signed' in source) {
    const raw = row.cells[source.signed.index];
    const { value, valid } = repairAmount(raw, line, source.signed.name, journal, {
      blockInvalid: splitTarget || currencyCode !== undefined,
      nonzero: true,
      currencyCode,
    });
    if (!splitTarget) return [value];
    if (!valid) return ['', ''];
    const payment = value.startsWith('-');
    const result = payment ? [value.slice(1), ''] : ['', value];
    journal.change('layout-converted', line, 'Amount', raw, JSON.stringify(result), 'Moved the signed amount to the Intuit Credit or Debit cell.');
    return result;
  }

  const rawSpent = row.cells[source.spent.index];
  const rawReceived = row.cells[source.received.index];
  const splitOptions = { unsigned: true, required: false, currencyCode };
  const spent = repairAmount(rawSpent, line, source.spent.name, journal, splitOptions);
  const received = repairAmount(rawReceived, line, source.received.name, journal, splitOptions);
  if (!spent.valid || !received.valid) return splitTarget ? [spent.value, received.value] : [''];
  let payment = spent.value;
  let deposit = received.value;
  if (payment === '' && deposit === '') {
    journal.issue('missing-amount', line, source.spent.name, rawSpent, 'Enter the amount in the payment or deposit column.', { editable: true, block: !splitTarget });
  } else if (payment !== '' && deposit !== '') {
    if (isZeroAmount(payment) === isZeroAmount(deposit)) {
      const first = source.spent.index < source.received.index ? source.spent : source.received;
      journal.issue('credit-debit-conflict', line, first.name, row.cells[first.index], 'Leave one amount cell blank and verify the direction from the source transaction.', { editable: true, block: true });
      return splitTarget ? [payment, deposit] : [''];
    }
    if (isZeroAmount(payment)) payment = journal.fix('amount-normalized', line, source.spent.name, payment, '', 'Cleared the zero placeholder on the deposit row.');
    else deposit = journal.fix('amount-normalized', line, source.received.name, deposit, '', 'Cleared the zero placeholder on the payment row.');
  } else if (isZeroAmount(payment) || isZeroAmount(deposit)) {
    const [column, raw] = payment !== '' ? [source.spent.name, rawSpent] : [source.received.name, rawReceived];
    journal.issue('invalid-amount', line, column, raw, 'QuickBooks bank CSV requires a nonzero transaction amount. Verify the amount against the source transaction.', { editable: true, block: true });
    return splitTarget ? [rawSpent, rawReceived] : [''];
  }
  if (splitTarget) {
    if (source.spent.name !== 'Credit' || source.received.name !== 'Debit') {
      journal.change('layout-converted', line, 'Credit/Debit', JSON.stringify([rawSpent, rawReceived]), JSON.stringify([payment, deposit]), 'Placed payment and deposit amounts into Intuit Credit and Debit.');
    }
    return [payment, deposit];
  }
  const signed = payment !== '' ? `-${payment}` : deposit;
  journal.change('layout-converted', line, 'Amount', JSON.stringify([rawSpent, rawReceived]), signed, 'Combined payment and deposit columns into a signed amount.');
  return [signed];
}

export function repairQuickBooks(table: Table, journal: Journal, options: RepairOptions): { headers: string[]; dateOrder: Exclude<DateOrder, 'auto'> } {
  const date = requireColumn(table, 'Date', journal);
  const description = requireColumn(table, 'Description', journal);
  const amount = sourceAmount(table, journal, options);
  const dateOrder = options.dateOrder === 'DMY' ? 'DMY' : 'MDY';
  const balance = columnIndex(table, 'Balance');
  const movements = new Map<WorkingRow, BankMovement>();
  if (date === undefined || description === undefined || !amount) {
    auditBankBalance(table, journal, movements, 'Date');
    return { headers: table.headers, dateOrder };
  }

  const rows = table.rows.filter(({ invalid }) => !invalid);
  const currency = columnIndex(table, 'Currency');
  if (currency === undefined) {
    const columns = 'signed' in amount ? [amount.signed] : [amount.spent, amount.received];
    if (balance !== undefined) columns.push({ index: balance, name: 'Balance' });
    reviewAmountSymbols(rows, columns, journal, balance !== undefined);
  }
  const currencyCodes = currency === undefined ? undefined : reviewCurrencies(rows, currency, journal, true, balance !== undefined);
  const sourceOrder = inferDateOrder(rows.map(({ cells }) => cells[date]), options.dateOrder);
  const outputOrder = dateOrder;
  const split = options.qboLayout === '4col';
  const headers = split ? QUICKBOOKS_4COL : QUICKBOOKS_3COL;
  const kept = new Set(['Date', 'Description', ...('signed' in amount ? [amount.signed.name] : [amount.spent.name, amount.received.name])]);
  auditProjection(table, kept, journal);
  const sourceLayout = table.headers.filter((column) => kept.has(column));
  if (split && !('signed' in amount) && amount.spent.name === 'Debit') {
    journal.issue('layout-converted', table.headerLine, 'Credit/Debit', 'Bank convention', 'Swapped bank payment/deposit semantics into the Intuit Credit and Debit columns.', { fixedValue: 'Intuit convention' });
  }
  journal.fix('layout-converted', table.headerLine, 'CSV header', sourceLayout.join(', '), headers.join(', '), 'Reshaped the bank transactions into the selected QuickBooks layout.');

  for (const row of rows) {
    const line = row.source.line;
    const currencyCode = currencyCodes?.get(row);
    const dateValue = repairDate(row.cells[date], journal, { row: line, column: 'Date' }, sourceOrder, outputOrder, { blockInvalid: balance !== undefined });
    const descriptionValue = normalizeDescription(row.cells[description], journal, line);
    const existingIssues = journal.issues.length;
    const amounts = convertAmounts(row, amount, split, journal, currencyCode);
    if (journal.bookkeeperAmounts || balance !== undefined) {
      const [payment, deposit] = amounts;
      const value = split ? payment ? `-${payment}` : deposit : payment;
      const valid = value && !journal.issues.slice(existingIssues).some(({ autoFixed }) => !autoFixed);
      journal.bookkeeperAmounts?.push({ row: line, currency: currencyCode ?? null, amounts: valid ? { amount: value } : {} });
      if (balance !== undefined) {
        const amountColumn = 'signed' in amount ? amount.signed.name : value.startsWith('-') ? amount.spent.name : amount.received.name;
        movements.set(row, { date: dateValue.iso, amount: valid ? value : undefined, amountColumn });
      }
    }
    row.after = [
      dateValue.value, descriptionValue, ...amounts,
    ];
  }
  auditBankBalance(table, journal, movements, 'Date', currencyCodes);
  return { headers, dateOrder: outputOrder };
}
