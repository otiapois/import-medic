import { decodeCsv, parseCsv, type CsvRecord } from '../csv';
import { canonicalHeader, headerAliases } from '../table';
import { amountCurrencySymbol, currencyFractionDigits, isKnownCurrency, normalizeAmount, readMinorUnits } from '../values';
import type { CategorizationInput, CategorizationIssue, CreditDebitConvention } from './categorization-rules';

export const appendedHeaders = ['Account Code', 'Account Name', 'Tax Code', 'Calculated Net', 'Calculated Tax', 'Matched Rule'] as const;

const fieldAliases = headerAliases({
  Description: ['Memo', 'Details', 'Transaction Description'], Payee: ['Payer'],
  Amount: ['*Amount', 'Transaction Amount'], Gross: ['Gross Amount'],
  Debit: ['Debit Amount'], Credit: ['Credit Amount'], Currency: ['Currency Code', 'Transaction Currency'],
  'Money In': ['Deposit', 'Deposits', 'Money Received'], 'Money Out': ['Withdrawal', 'Withdrawals', 'Money Spent'],
});
const generatedHeaders = new Set<string>(appendedHeaders.map(name => name.toLowerCase()));

type Columns = { text: number[]; signed?: number; debit?: number; credit?: number; moneyIn?: number; moneyOut?: number; currency?: number };
type AmountLayout = { signed: number } | { incoming: number; outgoing: number };
type BankRow = { record: CsvRecord; amount?: { currency: string | null; grossCents: bigint } };

function inspectHeaders({ cells, line, raw, parseError }: CsvRecord, issues: CategorizationIssue[]): Columns {
  const positions = new Map<string, number>();
  const issue = (code: string, message: string, column: string) => issues.push({ code, message, column, line, raw });
  if (parseError) issue('malformed-csv', parseError, 'CSV header');
  for (const [index, header] of cells.entries()) {
    const key = canonicalHeader(header, fieldAliases).toLowerCase();
    if (!key) issue('missing-header', 'Give every source column a header.', `Column ${index + 1}`);
    else if (positions.has(key)) issue('duplicate-header', 'Resolve duplicate or equivalent source headers.', header);
    else if (generatedHeaders.has(key)) issue('existing-categorization-column', 'Start with the source before categorization columns were added.', header);
    else positions.set(key, index);
  }
  const text = ['description', 'payee'].flatMap(name => positions.has(name) ? [positions.get(name)!] : []);
  const amount = positions.get('amount');
  const gross = positions.get('gross');
  const signed = amount ?? gross;
  const debit = positions.get('debit');
  const credit = positions.get('credit');
  const moneyIn = positions.get('money in');
  const moneyOut = positions.get('money out');
  const barePair = debit !== undefined || credit !== undefined;
  const directionalPair = moneyIn !== undefined || moneyOut !== undefined;
  const moneyColumn = 'Amount / Gross / Debit / Credit / Money In / Money Out';
  if (!text.length) issue('missing-text-columns', 'Supply a Description or Payee column.', 'Description / Payee');
  if ((amount !== undefined && gross !== undefined) || (signed !== undefined && (barePair || directionalPair)) || (barePair && directionalPair)) {
    issue('ambiguous-amount-columns', 'Use one signed Amount or Gross column, the Debit and Credit pair, or the Money In and Money Out pair.', moneyColumn);
  } else if (signed === undefined && (debit === undefined || credit === undefined) && (moneyIn === undefined || moneyOut === undefined)) {
    issue('missing-amount-columns', 'Supply a signed Amount or Gross column, or one complete incoming and outgoing pair.', moneyColumn);
  }
  return { text, signed, debit, credit, moneyIn, moneyOut, currency: positions.get('currency') };
}

export function hasCategorizationHeaders(headers: readonly string[]): boolean {
  const issues: CategorizationIssue[] = [];
  inspectHeaders({ cells: [...headers], line: 1, raw: '' }, issues);
  return issues.length === 0;
}

export function readCategorizationSource({ csv, sourceCurrency, creditDebitConvention }: CategorizationInput) {
  const { text, encoding } = decodeCsv(csv.bytes);
  const issues: CategorizationIssue[] = [];
  const blankLines: number[] = [];
  const records = parseCsv(text).records.filter(record => {
    if (!/^[ \t]*$/.test(record.raw)) return true;
    blankLines.push(record.line);
    return false;
  });
  const [header, ...rows] = records;
  const base = { encoding, issues, blankLines, header };
  const unresolvedRows = (): BankRow[] => rows.map(record => ({ record }));
  if (encoding === 'unknown') {
    issues.push({ code: 'invalid-encoding', message: 'Use a supported CSV encoding without NUL characters.' });
    return { ...base, textIndexes: [], columns: null, rows: unresolvedRows() };
  }
  if (!header) {
    issues.push({ code: 'missing-csv-header', message: 'Supply a CSV header and transaction rows.' });
    return { ...base, textIndexes: [], columns: null, rows: unresolvedRows() };
  }
  const positions = inspectHeaders(header, issues);
  const { cells: headers, line, raw } = header;
  const declaredCurrency = sourceCurrency?.trim().toUpperCase() ?? null;
  const sourceIssue = (code: string, message: string, column: string) => issues.push({ code, message, column, line, raw });
  if (declaredCurrency !== null && !centCurrency(declaredCurrency)) {
    sourceIssue('invalid-source-currency', 'Choose a supported two-decimal ISO currency.', 'Currency');
  } else if (declaredCurrency !== null && positions.currency !== undefined) {
    sourceIssue('unexpected-source-currency', 'Use the per-transaction Currency column, or supply a currency only when the column is absent.', headers[positions.currency]);
  }
  if ((positions.signed !== undefined || positions.moneyIn !== undefined) && creditDebitConvention !== undefined) {
    sourceIssue('unexpected-credit-debit-convention', 'Use a Debit and Credit convention only for a source with those headers.', 'Debit / Credit');
  } else if (positions.debit !== undefined && positions.credit !== undefined && creditDebitConvention === undefined) {
    sourceIssue('credit-debit-convention-required', 'Choose Bank (Debit is outflow) or Intuit (Credit is outflow) for the source pair.', 'Debit / Credit');
  }
  if (!rows.length) issues.push({ code: 'no-transactions', message: 'Supply at least one transaction beneath the header.', line, raw });
  const name = (index: number | undefined) => index === undefined ? null : headers[index];
  const columns = { textColumns: positions.text.map(index => headers[index]), signedAmountColumn: name(positions.signed),
    debitColumn: name(positions.debit), creditColumn: name(positions.credit), moneyInColumn: name(positions.moneyIn), moneyOutColumn: name(positions.moneyOut), currencyColumn: name(positions.currency),
    declaredCurrency, creditDebitConvention: creditDebitConvention ?? null };
  const resolved = { ...base, columns, textIndexes: positions.text };
  if (issues.length) return { ...resolved, rows: unresolvedRows() };
  const layout: AmountLayout = positions.signed !== undefined ? { signed: positions.signed }
    : positions.moneyIn !== undefined ? { incoming: positions.moneyIn, outgoing: positions.moneyOut! }
    : creditDebitConvention === 'bank' ? { incoming: positions.credit!, outgoing: positions.debit! }
    : { incoming: positions.debit!, outgoing: positions.credit! };
  return { ...resolved, rows: rows.map(record => readTransaction(record, layout, headers, positions.currency, declaredCurrency, issues)) };
}

function centCurrency(currency: string): boolean {
  return isKnownCurrency(currency) && currencyFractionDigits(currency) === 2;
}

function readTransaction(record: CsvRecord, layout: AmountLayout, headers: string[], currencyIndex: number | undefined,
  declaredCurrency: string | null, issues: CategorizationIssue[]): BankRow {
  const { cells, line, raw, parseError } = record;
  const issue = (code: string, message: string, column: string, value?: string) => issues.push({ code, message, line, column, raw, value });
  if (parseError || cells.length !== headers.length) {
    issue(parseError ? 'malformed-csv' : 'row-width', parseError ?? 'The row must contain exactly as many cells as the header.', 'CSV record');
    return { record };
  }
  let currency = declaredCurrency;
  if (currencyIndex !== undefined) {
    currency = cells[currencyIndex].trim().toUpperCase();
    if (!centCurrency(currency)) {
      issue('invalid-currency', 'Use a supported two-decimal ISO currency on every row.', headers[currencyIndex], cells[currencyIndex]);
      return { record };
    }
  }
  const read = (index: number, split: boolean) => {
    const value = cells[index];
    if (split && value.trim() === '') return 0n;
    if (currency === null && amountCurrencySymbol(value, true)) {
      issue('missing-symbol-currency', 'Supply the exact ISO currency for an amount with a currency symbol.', headers[index], value);
      return;
    }
    const normalized = normalizeAmount(value, currency ?? undefined, true);
    const cents = normalized !== undefined && normalized.length <= 128 && !(split && normalized.startsWith('-'))
      ? readMinorUnits(normalized, 2) : undefined;
    if (cents === undefined) issue('invalid-amount', split
      ? 'Use an unsigned exact-cent amount that agrees with the currency.'
      : 'Use a signed exact-cent amount that agrees with the currency.', headers[index], value);
    return cents;
  };
  if ('signed' in layout) {
    const grossCents = read(layout.signed, false);
    return grossCents === undefined ? { record } : { record, amount: { currency, grossCents } };
  }
  const incoming = read(layout.incoming, true);
  const outgoing = read(layout.outgoing, true);
  if (incoming === undefined || outgoing === undefined) return { record };
  if ((incoming === 0n) === (outgoing === 0n)) {
    issue('invalid-split-amount', 'Exactly one side of the incoming and outgoing pair must contain a nonzero amount.', `${headers[layout.outgoing]} / ${headers[layout.incoming]}`);
    return { record };
  }
  return { record, amount: { currency, grossCents: incoming - outgoing } };
}
