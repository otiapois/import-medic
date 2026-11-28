import type { Journal } from '../journal';
import { columnIndex, type Table, type WorkingRow } from '../table';
import type { DuplicateTransactions, TaxReconciliation } from '../types';
import { amountCurrencySymbol, formatMinorUnits, isKnownCurrency, normalizeAmount, readMinorUnits } from '../values';

const headerKey = (header: string) => header.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
const subtotalNames = new Set(['subtotal', 'sub total', 'net before tax', 'net excluding tax', 'net excl tax', 'amount before tax',
  'pre tax amount', 'pretax amount', 'tax exclusive amount', 'vat exclusive amount']);
const netNames = new Set(['net', 'net amount']);
const taxNames = new Set(['tax', 'tax amount', 'total tax', 'tax total', 'vat', 'vat amount', 'sales tax', 'sales tax amount', 'gst', 'gst amount']);
const grossNames = new Set(['gross', 'gross amount', 'gross total', 'total', 'total amount', 'total including tax', 'total incl tax', 'tax inclusive total']);
const paymentMarkers = new Set(['balance impact', 'transaction id', 'time zone', 'balance transaction id', 'payment id']);

export function auditTaxReconciliation(table: Table, journal: Journal, payment = false): void {
  if (!journal.bookkeeperAmounts) return;
  const normalizedHeaders = table.sourceHeaders.map(headerKey);
  const matching = (names: ReadonlySet<string>) => normalizedHeaders.flatMap((name, index) => names.has(name) ? [index] : []);
  const subtotals = matching(subtotalNames);
  const bareNets = matching(netNames);
  const aggregates = matching(taxNames);
  const taxes = aggregates.length ? aggregates : normalizedHeaders.flatMap((name, index) => /^tax \d+ amount$/.test(name) ? [index] : []);
  const gross = matching(grossNames);
  const settlement = payment && (columnIndex(table, 'Fee') !== undefined || normalizedHeaders.some(name => paymentMarkers.has(name)));
  const net = subtotals.length || settlement ? subtotals : bareNets;
  if (!taxes.length || !gross.length || (!net.length && (!settlement || !bareNets.length))) return;

  const mismatches: TaxReconciliation['mismatches'][number][] = [];
  const reasons: TaxReconciliation['reasons'][number][] = [];
  let checkedRows = 0;
  const currencyIndex = columnIndex(table, 'Currency');
  const reason = (row: number, column: string, message: string, raw?: string, editable = false) => {
    reasons.push({ row, column, message });
    if (raw !== undefined) journal.issue('FAIL_TAX_UNVERIFIABLE', row, column, raw, message, { block: true, editable });
  };
  const rows = table.rows.filter(({ invalid }) => !invalid);
  if (!net.length) {
    reason(table.headerLine, table.sourceHeaders[taxes[0]], 'The payment Net field is settlement after fees. Supply a separate tax subtotal to verify this tax amount.');
  } else if ([net, taxes, gross].some(fields => fields.length !== 1)) {
    reason(table.headerLine, 'CSV header', 'Use one unambiguous tax subtotal, tax amount and gross total header.',
      [...net, ...taxes, ...gross].map(index => table.sourceHeaders[index]).join(', '));
  } else if (!rows.length) {
    reason(table.headerLine, table.sourceHeaders[taxes[0]], 'The file contains no valid transaction records to check.');
  } else {
    const indexes = [net[0], taxes[0], gross[0]];
    for (const { cells, source: { line } } of rows) {
      const raw = indexes.map(index => cells[index]);
      const currencyRaw = currencyIndex === undefined ? undefined : cells[currencyIndex];
      const currency = currencyRaw?.trim().toUpperCase();
      if (currency !== undefined && !isKnownCurrency(currency)) {
        reason(line, table.sourceHeaders[currencyIndex!], 'Enter a supported transaction currency before verifying tax amounts.', currencyRaw, true);
        continue;
      }
      const symbols = new Set(raw.map(value => amountCurrencySymbol(value, true)).filter(Boolean));
      if (symbols.size > 1) {
        reason(line, table.sourceHeaders[taxes[0]], 'The tax subtotal, tax amount and gross total must use the same currency.', raw[1], true);
        continue;
      }
      const cents = raw.map(value => readMinorUnits(normalizeAmount(value, currency, true), 2));
      const invalid = cents.findIndex(value => value === undefined);
      if (invalid >= 0) {
        reason(line, table.sourceHeaders[indexes[invalid]], 'Enter the original unambiguous amount in exact cents. Blank values and rounding cannot verify this tax line.', raw[invalid], true);
        continue;
      }
      const [subtotal, tax, actual] = cents as bigint[];
      const expected = subtotal + tax;
      checkedRows++;
      if (expected === actual) continue;
      const [netAmount, taxAmount, grossAmount] = raw;
      const details = { net: netAmount, tax: taxAmount, gross: grossAmount, expectedGross: formatMinorUnits(expected, 2), delta: formatMinorUnits(actual - expected, 2) };
      mismatches.push({ row: line, ...details });
      journal.issue('FAIL_TAX_MISMATCH', line, table.sourceHeaders[gross[0]], grossAmount,
        `Tax subtotal plus tax is ${details.expectedGross}. The supplied total differs by ${details.delta}.`,
        { editable: true, block: true, taxReconciliation: details });
    }
  }
  journal.taxReconciliation = { status: mismatches.length ? 'FAIL_TAX_MISMATCH' : reasons.length ? 'UNVERIFIABLE' : 'VERIFIED',
    checkedRows, mismatchCount: mismatches.length, unverifiableCount: reasons.length, mismatches, reasons };
}

type SeenGroup = { lines: number[]; date: string; amount: string; currency: string | null; description: string; column: string };

export function trackDuplicateTransactions(table: Table, journal: Journal, descriptionColumns: readonly string[]) {
  if (!journal.bookkeeperAmounts) return;
  const columns = descriptionColumns.flatMap(column => {
    const index = columnIndex(table, column);
    return index === undefined ? [] : [index];
  });
  if (!columns.length) return;
  const hasCurrencyColumn = columnIndex(table, 'Currency') !== undefined;
  const groups = new Map<string, SeenGroup>();
  return {
    record(row: WorkingRow, date: string | undefined, amount: string | undefined, rawAmount: string, currencyCode?: string) {
      if (!date || amount === undefined || (hasCurrencyColumn && (!currencyCode || !isKnownCurrency(currencyCode)))) return;
      const original = row.cellsBeforePunctuation ?? row.cells;
      const descriptions = columns.map(column => original[column]);
      const nonempty = descriptions.findIndex(value => value.trim() !== '');
      if (nonempty === -1) return;
      const currency = currencyCode ?? (amountCurrencySymbol(rawAmount, true) || null);
      const amountKey = amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.$/, '') : amount;
      const key = JSON.stringify([date, amountKey, currency, descriptions]);
      const group = groups.get(key);
      if (group) group.lines.push(row.source.line);
      else groups.set(key, { lines: [row.source.line], date, amount: amountKey, currency,
        description: descriptions.filter(value => value !== '').join(' · '), column: table.sourceHeaders[columns[nonempty]] });
    },
    finish() {
      const duplicates: DuplicateTransactions['groups'][number][] = [];
      let affectedRows = 0;
      for (const { column, ...group } of groups.values()) {
        if (group.lines.length <= 1) continue;
        duplicates.push(group);
        affectedRows += group.lines.length;
        const duplicateGroup = duplicates.length;
        for (const [index, line] of group.lines.entries()) {
          const other = group.lines[index === 0 ? 1 : 0];
          journal.issue('FAIL_DUPLICATE_TRANSACTION', line, column, group.description,
            `This transaction matches source line ${other}. Review duplicate group ${duplicateGroup} (${group.lines.length} rows) before importing.`,
            { block: true, relatedLines: [other], duplicateGroup });
        }
      }
      if (duplicates.length) journal.duplicateTransactions = { groupCount: duplicates.length, affectedRows, groups: duplicates };
    },
  };
}
