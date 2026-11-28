import { decodeCsv, parseCsv, type CsvRecord } from '../csv';
import { Journal } from '../journal';
import { currencyFractionDigits, isKnownCurrency, normalizeAmount, readMinorUnits, repairDate } from '../values';
import type { ReconciliationException, ReconciliationSource } from './types';

const payoutColumns = {
  id: ['Payout ID', 'Payout Reference', 'Payout ID/Reference', 'Reference'],
  date: ['Payout Date', 'Date'],
  amount: ['Net Payout Amount', 'Net Payout', 'Net Amount', 'Net'],
  gross: ['Gross', 'Gross Amount'],
  fee: ['Fees', 'Fee'],
  currency: ['Currency'],
} as const;

const bankColumns = {
  date: ['Bank Date', 'Date', '*Date', 'Transaction Date', 'Posting Date'],
  description: ['Description', '*Description', 'Payee', 'Memo'],
  amount: ['Amount', '*Amount'],
  currency: ['Currency'],
  reference: ['Reference'],
} as const;

type Side = 'payouts' | 'bank';
type Column = keyof typeof payoutColumns | keyof typeof bankColumns;
type Disposition = 'matched' | 'unmatched' | 'ambiguous' | 'excluded-unpriced' | 'excluded-non-inflow' | 'ignored-blank';

interface SourceRecord extends CsvRecord {
  currency: string | null;
  amountCents: string | null;
  disposition: Disposition;
}

export interface LedgerRow {
  record: SourceRecord;
  currency: string;
  amount: bigint;
  id: string;
  description: string;
  reference: string;
}

export interface CandidateRow extends LedgerRow {
  date: string;
  day: number;
}

interface ParsedSource {
  evidence: {
    encoding: ReturnType<typeof decodeCsv>['encoding'];
    header: CsvRecord | null;
    records: SourceRecord[];
    currencyDefault: string | null;
  };
  ledger: LedgerRow[];
  candidates: CandidateRow[];
  exceptions: ReconciliationException[];
}

function currencyCode(value: string | undefined): string | undefined {
  const code = value?.trim().toUpperCase();
  return code && isKnownCurrency(code) && currencyFractionDigits(code) === 2 ? code : undefined;
}

const blankRecord = (record: CsvRecord) => record.raw.trim() === '' && !record.parseError;

function csvSyntaxError(record: CsvRecord): string | undefined {
  if (record.parseError) return record.parseError;
  if (!record.cells.some(value => value.includes('"'))) return undefined;
  // Papa accepts literal quotes in bare fields. Check how those already-parsed cells were written.
  let cursor = 0;
  for (const [index, value] of record.cells.entries()) {
    const quoted = record.raw[cursor] === '"';
    const written = quoted ? '"' + value.replaceAll('"', '""') + '"' : value;
    if ((!quoted && value.includes('"')) || !record.raw.startsWith(written, cursor)) {
      return 'A cell contains a quote outside RFC 4180 quoting.';
    }
    cursor += written.length;
    if (quoted) while (/\s/.test(record.raw.charAt(cursor))) cursor++;
    if (index < record.cells.length - 1) cursor++;
  }
  return undefined;
}

export function parseReconciliationSource(file: ReconciliationSource, side: Side, sourceDefault?: string): ParsedSource {
  const { text, encoding } = decodeCsv(file.bytes);
  const { records } = parseCsv(text);
  const header = records.find(record => !blankRecord(record)) ?? null;
  const evidence: ParsedSource['evidence'] = {
    encoding,
    header,
    currencyDefault: null,
    records: records.filter(record => record !== header).map(record => ({
      ...record, currency: null, amountCents: null, disposition: blankRecord(record) ? 'ignored-blank' : 'excluded-unpriced',
    })),
  };
  const ledger: LedgerRow[] = [];
  const candidates: CandidateRow[] = [];
  const exceptions: ReconciliationException[] = [];

  const issue = (code: ReconciliationException['code'], lines: number[], message: string,
    details: Partial<Omit<ReconciliationException, 'code' | 'payoutLines' | 'bankLines' | 'message'>> = {}) => {
    exceptions.push({ code, payoutLines: side === 'payouts' ? lines : [], bankLines: side === 'bank' ? lines : [],
      currency: null, deltaCents: null, message, ...details });
  };

  const headerError = header && csvSyntaxError(header);
  if (!header || headerError) {
    issue('INVALID_SOURCE', header ? [header.line] : [], encoding === 'unknown'
      ? 'This file could not be decoded as a supported CSV encoding.'
      : headerError ?? 'The file does not contain a CSV header.',
    { column: 'CSV header', ...(header && { value: header.raw }) });
    return { evidence, ledger, candidates, exceptions };
  }

  const payoutSide = side === 'payouts';
  const aliases = payoutSide ? payoutColumns : bankColumns;
  const required: Column[] = payoutSide ? ['id', 'date', 'amount'] : ['date', 'description', 'amount'];
  const normalizedHeaders = header.cells.map(value => value.trim().toLowerCase());
  const indexes = new Map<Column, number>();
  let hasCurrencyHeader = false;
  for (const [key, names] of Object.entries(aliases) as [Column, readonly string[]][]) {
    const normalized = names.map(name => name.toLowerCase());
    const matches = normalizedHeaders.flatMap((name, index) => normalized.includes(name) ? [index] : []);
    if (key === 'currency') hasCurrencyHeader = matches.length > 0;
    if (matches.length === 1) indexes.set(key, matches[0]);
    else if (matches.length > 1) {
      issue('INVALID_SOURCE', [header.line], `Provide only one ${names[0]} column.`,
        { column: names[0], value: matches.map(index => header.cells[index]).join(' | ') });
    } else if (required.includes(key)) {
      issue('INVALID_SOURCE', [header.line], `The source requires a ${names[0]} column.`, { column: names[0] });
    }
  }
  const defaultCurrency = hasCurrencyHeader ? undefined : currencyCode(sourceDefault);
  evidence.currencyDefault = defaultCurrency ?? null;
  if (!hasCurrencyHeader && !defaultCurrency) {
    issue('INVALID_SOURCE', [header.line],
      'Add a Currency column or confirm a supported two-decimal ISO currency for this file.', { column: 'Currency', value: sourceDefault });
  }

  const ids = new Map<string, { id: string; currency: string; lines: number[] }>();
  const journal = new Journal('quickbooks-bank');
  for (const record of evidence.records) {
    if (record.disposition === 'ignored-blank') continue;
    const syntaxError = csvSyntaxError(record);
    if (syntaxError || record.cells.length !== header.cells.length) {
      issue('INVALID_ROW', [record.line], syntaxError ?? `Expected ${header.cells.length} cells, found ${record.cells.length}.`,
        { column: 'CSV row', value: record.raw });
      continue;
    }

    const raw = (key: Column) => {
      const index = indexes.get(key);
      return index === undefined ? undefined : record.cells[index];
    };
    const column = (key: Column) => header.cells[indexes.get(key)!];
    const invalid = (key: Column, value: string, message: string, currency?: string) =>
      issue('INVALID_ROW', [record.line], message, { column: column(key), value, currency: currency ?? null });

    const explicitCurrency = raw('currency');
    const currency = hasCurrencyHeader ? currencyCode(explicitCurrency) : defaultCurrency;
    if (explicitCurrency !== undefined && !currency) {
      invalid('currency', explicitCurrency, 'Enter a supported two-decimal ISO currency code for this row.');
    }

    const id = raw('id');
    if (id !== undefined) {
      const trimmed = id.trim();
      if (!trimmed) invalid('id', id, 'Enter the source payout ID or reference.', currency);
      else if (currency) {
        const key = currency + '\0' + trimmed;
        const group = ids.get(key);
        if (group) group.lines.push(record.line);
        else ids.set(key, { id: trimmed, currency, lines: [record.line] });
      }
    }
    const rawDate = raw('date');
    let date: string | undefined;
    if (rawDate !== undefined) {
      date = repairDate(rawDate, journal, { row: record.line, column: column('date') }, undefined, 'ISO', { allowTimestamp: true }).iso;
      if (!date) invalid('date', rawDate, journal.issues.at(-1)!.message, currency);
    }

    const cents = (key: 'amount' | 'gross' | 'fee') => {
      const value = raw(key);
      if (value === undefined || (key !== 'amount' && value.trim() === '')) return undefined;
      const parsed = readMinorUnits(normalizeAmount(value, currency), 2);
      if (parsed === undefined) invalid(key, value, 'Enter an exact cent amount consistent with the source currency.', currency);
      return parsed;
    };
    const amount = cents('amount');
    if (payoutSide && amount !== undefined && amount <= 0n) {
      invalid('amount', raw('amount')!, 'A completed payout requires a positive net amount.', currency);
    }
    if (payoutSide) {
      const gross = cents('gross');
      const fee = cents('fee');
      if (gross !== undefined && fee !== undefined && amount !== undefined) {
        const expected = gross - (fee < 0n ? -fee : fee);
        if (expected !== amount) {
          issue('PAYOUT_TOTAL_MISMATCH', [record.line], 'Net payout differs from Gross minus the fee deduction.',
            { currency: currency ?? null, column: column('amount'), value: raw('amount'), expectedCents: expected.toString(),
              actualCents: amount.toString(), deltaCents: (amount - expected).toString() });
        }
      }
    }

    record.currency = currency ?? null;
    record.amountCents = amount?.toString() ?? null;
    if (currency === undefined || amount === undefined) continue;
    if (!payoutSide && amount <= 0n) {
      record.disposition = 'excluded-non-inflow';
      continue;
    }
    record.disposition = 'unmatched';
    const row = { record, currency, amount, id: id ?? '', description: raw('description') ?? '', reference: raw('reference') ?? '' };
    ledger.push(row);
    if (date && amount > 0n) candidates.push({ ...row, date, day: Date.parse(date) / 86_400_000 });
  }

  for (const { id, currency, lines } of ids.values()) {
    if (lines.length > 1) issue('DUPLICATE_PAYOUT_ID', lines,
      'The same payout ID appears on multiple source rows in this currency. Supply one completed transfer per payout ID.',
      { currency, column: header.cells[indexes.get('id')!], value: id });
  }
  return { evidence, ledger, candidates, exceptions };
}
