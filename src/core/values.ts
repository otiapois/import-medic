import { z } from 'zod';
import type { Journal } from './journal';
import type { WorkingRow } from './table';
import type { DateOrder } from './types';

const decimalSchema = z.string().regex(/^(?:\d+(?:\.\d+)?|\.\d+)$/);
const groupedDecimalSchema = z.string().regex(/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/);
const currencySchema = z.string().regex(/^[A-Z]{3}$/);

function splitAmount(source: string) {
  let value = source.trim();
  const parenthesized = value.startsWith('(') && value.endsWith(')');
  if (parenthesized) value = value.slice(1, -1).trim();
  // Accept either -$10.25 or $-10.25, with at most one explicit sign and symbol.
  const parts = /^([+-]?)([$€£¥]?)([+-]?)([^+\-()$€£¥]+)$/.exec(value);
  if (!parts) return undefined;
  const [, prefixSign, currency, suffixSign, magnitude] = parts;
  if ((prefixSign && suffixSign) || (parenthesized && (prefixSign || suffixSign))) return undefined;
  return {
    negative: parenthesized || prefixSign === '-' || suffixSign === '-',
    currency,
    digits: magnitude.trim(),
  };
}

export const amountCurrencySymbol = (source: string): string => splitAmount(source)?.currency ?? '';

export function normalizeAmount(source: string, currencyCode?: string): string | undefined {
  const amount = splitAmount(source);
  if (!amount) return undefined;
  const { negative, currency, digits } = amount;
  if (currency && currencyCode) {
    const format = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
      currencyDisplay: 'narrowSymbol',
    });
    const symbol = format.formatToParts(0).find(({ type }) => type === 'currency')?.value;
    if (symbol !== currency) return undefined;
  }
  const isGrouped = digits.includes(',');
  if (isGrouped) {
    if (!groupedDecimalSchema.safeParse(digits).success) return undefined;
    // A currency symbol does not disambiguate a single comma's role.
    if (!digits.includes('.') && digits.indexOf(',') === digits.lastIndexOf(',')) return undefined;
  } else if (!decimalSchema.safeParse(digits).success) {
    return undefined;
  }

  const number = digits.replaceAll(',', '').replace(/^\./, '0.').replace(/^0+(?=\d)/, '');
  return negative ? `-${number}` : number;
}

export const isZeroAmount = (value: string): boolean => /^-?0(?:\.0+)?$/.test(value);

export function reviewCurrencies(rows: readonly WorkingRow[], index: number, journal: Journal, singleCurrency: boolean): ReadonlyMap<WorkingRow, string> {
  const codes = new Map<WorkingRow, string>();
  const linesByCurrency = new Map<string, number[]>();
  let reference: string | undefined;
  for (const row of rows) {
    const raw = row.cells[index];
    const code = raw.trim().toUpperCase();
    const line = row.source.line;
    if (!currencySchema.safeParse(code).success) {
      journal.issue('invalid-currency', line, 'Currency', raw, 'Enter the original three-letter currency code.', { editable: true, block: singleCurrency });
      continue;
    }
    codes.set(row, journal.fix('currency-normalized', line, 'Currency', raw, code, 'Standardized the currency code to uppercase.'));
    if (singleCurrency) {
      const lines = linesByCurrency.get(code);
      if (lines) lines.push(line);
      else linesByCurrency.set(code, [line]);
    }
    reference ??= code;
    if (singleCurrency && code !== reference) {
      journal.issue('multi-currency', line, 'Currency', raw, `Found ${code} alongside ${reference}. Use a separate bank CSV for each currency.`, { block: true });
    }
  }
  if (linesByCurrency.size > 1) journal.currencySplit = [...linesByCurrency].map(([currency, lines]) => ({ currency, lines }));
  return codes;
}

export function repairAmount(
  raw: string,
  row: number,
  column: string,
  journal: Journal,
  { unsigned = false, required = true, blockInvalid = false, nonzero = false, currencyCode }:
  { unsigned?: boolean; required?: boolean; blockInvalid?: boolean; nonzero?: boolean; currencyCode?: string } = {},
): { value: string; valid: boolean; validatedDecimal?: string } {
  if (!raw.trim()) {
    if (required) journal.issue('missing-amount', row, column, raw, 'Enter the original transaction amount.', { editable: true, block: blockInvalid });
    const value = required ? raw : journal.fix('amount-normalized', row, column, raw, '', 'Cleared whitespace in the unused amount cell.');
    return { value, valid: !required };
  }
  const value = normalizeAmount(raw, currencyCode);
  if (value === undefined || (unsigned && value.startsWith('-'))) {
    const message = unsigned
      ? 'Enter an unsigned amount in the appropriate payment or deposit column.'
      : 'Enter an unambiguous decimal that agrees with the source currency.';
    journal.issue('invalid-amount', row, column, raw, message, { editable: true, block: unsigned || blockInvalid });
    return { value: raw, valid: false };
  }
  if (nonzero && isZeroAmount(value)) {
    journal.issue('invalid-amount', row, column, raw, 'QuickBooks bank CSV requires a nonzero transaction amount. Verify the amount against the source transaction.', { editable: true, block: true });
    return { value: raw, valid: false, validatedDecimal: value };
  }
  return { value: journal.fix('amount-normalized', row, column, raw, value, 'Removed currency formatting without changing the transaction amount.'), valid: true };
}

type ChosenDateOrder = Exclude<DateOrder, 'auto'>;
type CalendarDate = { year: number; month: number; day: number };

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = /^(\d{4})-(\d{2})-(\d{2})$/;
const timestamp = /^(\d{4})-(\d{2})-(\d{2})[T ](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;
const named = /^(\d{1,2})-([a-z]{3})-(\d{4})$/i;
const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function calendarDate(year: number, month: number, day: number): CalendarDate | undefined {
  if (year < 1 || month < 1 || month > 12 || day < 1) return undefined;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1] ? { year, month, day } : undefined;
}

function slashDate(value: string): { MDY?: CalendarDate; DMY?: CalendarDate } {
  const parts = slashed.exec(value.trim());
  if (!parts) return {};
  const [, first, second, year] = parts;
  return {
    MDY: calendarDate(+year, +first, +second),
    DMY: calendarDate(+year, +second, +first),
  };
}

export function inferDateOrder(values: Iterable<string>, choice: DateOrder = 'auto'): ChosenDateOrder | undefined {
  if (choice !== 'auto') return choice;
  const known = new Set<ChosenDateOrder>();
  for (const value of values) {
    const { MDY, DMY } = slashDate(value);
    if (MDY && !DMY) known.add('MDY');
    if (DMY && !MDY) known.add('DMY');
  }
  return known.size === 1 ? known.values().next().value : undefined;
}

export function normalizeDate(
  source: string,
  journal: Journal,
  location: { row: number; column: string },
  inputOrder: ChosenDateOrder | undefined,
  outputOrder: ChosenDateOrder | 'ISO',
  { allowTimestamp = false, blockInvalid = false }: { allowTimestamp?: boolean; blockInvalid?: boolean } = {},
): string {
  const { row, column } = location;
  const value = source.trim();
  if (value === '') {
    journal.issue('missing-date', row, column, source, 'Enter the date from the source transaction.', { editable: true, block: blockInvalid });
    return source;
  }

  const isoParts = (allowTimestamp ? timestamp.exec(value) : null) ?? iso.exec(value);
  const namedParts = named.exec(value);
  let date: CalendarDate | undefined;
  if (isoParts) {
    date = calendarDate(+isoParts[1], +isoParts[2], +isoParts[3]);
  } else if (namedParts) {
    date = calendarDate(+namedParts[3], months.indexOf(namedParts[2].toLowerCase()) + 1, +namedParts[1]);
  } else {
    const { MDY, DMY } = slashDate(value);
    if (!inputOrder && MDY && DMY && MDY.day !== DMY.day) {
      journal.issue('date-order-ambiguous', row, column, source, 'Choose the date order or enter this date as YYYY-MM-DD.', { editable: true, block: true });
      return source;
    }
    date = inputOrder ? { MDY, DMY }[inputOrder] : MDY ?? DMY;
  }

  if (!date) {
    journal.issue('invalid-date', row, column, source, 'Enter a real calendar date using YYYY-MM-DD or the selected date order.', { editable: true, block: blockInvalid });
    return source;
  }

  const year = String(date.year).padStart(4, '0');
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  const formatted = outputOrder === 'ISO' ? `${year}-${month}-${day}` : outputOrder === 'DMY' ? `${day}/${month}/${year}` : `${month}/${day}/${year}`;
  return journal.fix('date-normalized', row, column, source, formatted, 'Standardized the date without shifting its calendar day.');
}

export function normalizeDescription(source: string, journal: Journal, row: number): string {
  const fixed = source.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return journal.fix('description-normalized', row, 'Description', source, fixed, 'Removed control characters and excess spacing from the description.');
}
