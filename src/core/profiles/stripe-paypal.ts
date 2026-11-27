import type { Journal } from '../journal';
import { expectedPaymentNet } from '../repair/reconciliation';
import { auditProjection, columnIndex, headerAliases, requireColumn, type Table } from '../table';
import type { FeeConvention, RepairOptions } from '../types';
import { inferDateOrder, isZeroAmount, normalizeDate, normalizeDescription, repairAmount, reviewCurrencies } from '../values';
import { QUICKBOOKS_3COL } from './quickbooks-bank';

export const stripePayPalAliases = headerAliases({
  Date: ['created', 'created_at', 'created_utc', 'Created (UTC)', 'Created date (UTC)', 'Transaction Date'],
  Description: ['Name', 'Memo'],
  Gross: ['Amount', 'Gross Amount'],
  Fee: ['Fees', 'Fee Amount'],
  Net: ['Net Amount'],
  Currency: ['Currency Code'],
  'Reference ID': ['Transaction ID', 'Balance Transaction ID', 'balance_transaction_id', 'Payment ID', 'id'],
  'Balance Impact': [],
});

const ACCOUNTING_HEADERS = ['Date', 'Description', 'Gross', 'Fee', 'Net', 'Currency', 'Reference ID'];
export const stripeHeaderSignals = new Set([
  'created', 'created_at', 'created_utc', 'created (utc)', 'created date (utc)', 'balance_transaction_id', 'balance transaction id', 'payment id',
]);

export function resolveFeeConvention(sourceHeaders: readonly string[], selected: RepairOptions['stripePayPalFeeConvention']): FeeConvention {
  const headers = new Set(sourceHeaders.map((header) => header.trim().toLowerCase()));
  if ([...headers].some((header) => stripeHeaderSignals.has(header))) return 'deduction';
  if ((headers.has('balance impact') && headers.has('name')) ||
    (headers.has('transaction id') && (headers.has('balance impact') || headers.has('name') || headers.has('time')))) return 'signed-movement';
  return selected === 'signed-movement' ? selected : 'deduction';
}

function reviewBalanceImpact(rawImpact: string, rawNet: string, net: { value: string; valid: boolean }, line: number, journal: Journal) {
  const impact = rawImpact.trim().toLowerCase();
  if (impact === 'memo') return;
  if (impact !== 'credit' && impact !== 'debit') {
    journal.issue('invalid-balance-impact', line, 'Balance Impact', rawImpact, 'Confirm the original PayPal balance impact before converting to a bank CSV.', { block: true, editable: true });
  } else if (net.valid && (impact === 'debit') !== net.value.startsWith('-')) {
    journal.issue('balance-impact-conflict', line, 'Net', rawNet, 'The Net sign contradicts the PayPal balance impact. Verify the original transaction amount and direction.', { block: true, editable: true });
  }
}

export function repairStripePayPal(table: Table, journal: Journal, options: RepairOptions, feeConvention: FeeConvention): string[] {
  const qbo = options.stripePayPalOutput === 'quickbooks-3col';
  const date = requireColumn(table, 'Date', journal);
  const net = requireColumn(table, 'Net', journal, 'Export the itemized Balance or Payout report with the original Net amount.');
  const currency = requireColumn(table, 'Currency', journal);
  let gross = columnIndex(table, 'Gross');
  let fee = columnIndex(table, 'Fee');
  if (!qbo || gross !== undefined || fee !== undefined) {
    gross ??= requireColumn(table, 'Gross', journal);
    fee ??= requireColumn(table, 'Fee', journal);
  }
  const description = columnIndex(table, 'Description');
  const reference = columnIndex(table, 'Reference ID');
  const impact = columnIndex(table, 'Balance Impact');
  if (date === undefined || net === undefined || currency === undefined || (!qbo && (gross === undefined || fee === undefined))) {
    return table.headers;
  }

  if (impact !== undefined) {
    table.rows = table.rows.filter((row) => {
      if (row.invalid || row.cells[impact].trim().toLowerCase() !== 'memo') return true;
      if (options.excludePayPalMemo === true) {
        journal.remove('paypal-memo-removed', row.source, 'Removed a PayPal Memo record with no balance impact.');
        return false;
      }
      if (qbo) {
        journal.issue('paypal-memo-in-export', row.source.line, 'Balance Impact', row.cells[impact], 'Exclude PayPal Memo records before producing a bank CSV. They do not move the balance.', { block: true });
      }
      return true;
    });
  }

  const rows = table.rows.filter(({ invalid }) => !invalid);
  const dateOrder = inferDateOrder(rows.map(({ cells }) => cells[date]), options.dateOrder);
  const outputOrder = qbo ? options.dateOrder === 'DMY' ? 'DMY' : 'MDY' : 'ISO';
  const headers = qbo ? QUICKBOOKS_3COL : ACCOUNTING_HEADERS;
  const usedHeaders = new Set(qbo ? ['Date', 'Description', 'Net'] : headers);
  auditProjection(table, usedHeaders, journal);
  journal.fix(
    'layout-converted',
    table.headerLine,
    'CSV header',
    table.headers.filter((header) => usedHeaders.has(header)).join(', '),
    headers.join(', '),
    'Mapped the payment records to the selected accounting schema.',
  );

  const rowCurrencies = reviewCurrencies(rows, currency, journal, qbo);
  for (const row of rows) {
    const line = row.source.line;
    const cells = row.cells;
    const currencyCode = rowCurrencies.get(row);
    const amountOptions = { blockInvalid: qbo, currencyCode };
    const dateValue = normalizeDate(cells[date], journal, { row: line, column: 'Date' }, dateOrder, outputOrder, { allowTimestamp: true, blockInvalid: qbo });
    const repairedNet = repairAmount(cells[net], line, 'Net', journal, { ...amountOptions, nonzero: qbo });
    const netValue = repairedNet.value;
    const grossAmount = gross === undefined ? undefined : repairAmount(cells[gross], line, 'Gross', journal, amountOptions);
    const feeAmount = fee === undefined ? undefined : repairAmount(cells[fee], line, 'Fee', journal, amountOptions);
    const comparableNet = repairedNet.valid ? netValue : repairedNet.validatedDecimal;
    const expectedNet = grossAmount?.valid && feeAmount?.valid && comparableNet !== undefined
      ? expectedPaymentNet(grossAmount.value, feeAmount.value, comparableNet, feeConvention) : undefined;
    if (expectedNet !== undefined) {
      journal.issue('reconciliation-mismatch', line, 'Net', cells[net],
        'Gross, Fee and Net disagree. Verify the original transaction amounts before exporting.', {
          block: true, editable: true,
          reconciliation: { gross: cells[gross!], fee: cells[fee!], net: cells[net], expectedNet, feeConvention },
        });
    }
    const sourceDescription = description === undefined ? '' : cells[description];
    const balanceImpact = impact === undefined ? undefined : cells[impact].trim().toLowerCase();

    if (qbo) {
      if (impact !== undefined) reviewBalanceImpact(cells[impact], cells[net], repairedNet, line, journal);
      row.after = [dateValue, normalizeDescription(sourceDescription, journal, line), netValue];
      journal.change('layout-converted', line, 'Amount', cells[net], netValue, 'Used the source Net amount for QuickBooks Amount.');
    } else {
      row.after = [dateValue, sourceDescription, grossAmount?.value ?? '', feeAmount?.value ?? '', netValue, currencyCode ?? cells[currency], reference === undefined ? '' : cells[reference]];
    }
    if (journal.bookkeeperAmounts && balanceImpact !== 'memo') {
      const reportable = expectedNet === undefined && (balanceImpact === undefined || ((balanceImpact === 'credit' || balanceImpact === 'debit') &&
        (!repairedNet.valid || isZeroAmount(netValue) || (balanceImpact === 'debit') === netValue.startsWith('-'))));
      journal.bookkeeperAmounts.push({ row: line, currency: currencyCode ?? null, amounts: {
        gross: reportable && grossAmount?.valid ? grossAmount.value : undefined,
        fee: reportable && feeAmount?.valid ? feeAmount.value : undefined,
        net: reportable && repairedNet.valid ? netValue : undefined,
      } });
    }
  }

  return headers;
}
