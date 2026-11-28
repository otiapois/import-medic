import type { Journal } from '../journal';
import { columnIndex, type Table, type WorkingRow } from '../table';
import type { BalanceChain, BalanceChainBreak } from '../types';
import { currencyFractionDigits, formatMinorUnits, normalizeAmount, readMinorUnits } from '../values';

export interface BankMovement {
  date?: string;
  amount?: string;
  amountColumn: string;
}

const headerBlocks = new Set(['missing-header', 'duplicate-header', 'ambiguous-header', 'credit-debit-direction']);

export function auditBankBalance(
  table: Table,
  journal: Journal,
  movements: ReadonlyMap<WorkingRow, BankMovement>,
  dateColumn: string,
  currencyCodes?: ReadonlyMap<WorkingRow, string>,
): void {
  const balanceIndex = columnIndex(table, 'Balance');
  if (balanceIndex === undefined) return;

  const balanceColumn = table.sourceHeaders[balanceIndex];
  const reasons: BalanceChain['reasons'][number][] = [];
  const breaks: BalanceChainBreak[] = [];
  const validCurrencies = new Set(currencyCodes?.values());
  const currency = validCurrencies.size === 1 && currencyCodes?.size === table.rows.length
    ? validCurrencies.values().next().value ?? null : null;
  const headerProblems = journal.issues.filter(({ row, code, autoFixed }) => !autoFixed && row === table.headerLine && headerBlocks.has(code));
  const currencyProblems = journal.issues.filter(({ code }) => code === 'invalid-currency' || code === 'multi-currency');
  for (const { row, column, message } of [...headerProblems, ...currencyProblems]) reasons.push({ row, column, message });

  function reason(row: number, column: string, message: string, raw?: string, editable = false) {
    reasons.push({ row, column, message });
    if (raw !== undefined) journal.issue('balance-chain-unverifiable', row, column, raw, message, { editable, block: true });
  }

  const scale = currency === null ? 2 : currencyFractionDigits(currency);
  const precision = `${scale} decimal ${scale === 1 ? 'place' : 'places'}`;
  const decimal = (value: bigint) => formatMinorUnits(value, scale);
  if (table.rows.length === 0) reason(table.headerLine, balanceColumn, 'There are no transaction records to check.', '');

  const seen = new Map<string, number>();
  const rows = table.rows.map((row) => {
    const line = row.source.line;
    const movement = movements.get(row);
    const raw = row.cells[balanceIndex] ?? '';
    if (row.invalid) reason(line, 'CSV row', 'This record cannot be read. The verifier cannot connect the transactions on either side of it.');
    if (!movement || row.invalid || headerProblems.length) return { line, raw };

    const amount = readMinorUnits(movement.amount, scale);
    const balance = readMinorUnits(normalizeAmount(raw, currencyCodes?.get(row), true), scale);
    if (!movement.date) reason(line, dateColumn, 'Resolve the transaction date before checking the links on this line.');
    if (amount === undefined) {
      const message = `The balance check needs an unambiguous signed transaction amount at ${precision} without rounding.`;
      if (movement.amount === undefined) reason(line, movement.amountColumn, message);
      else reason(line, movement.amountColumn, message, movement.amount, true);
    }
    if (balance === undefined) {
      reason(line, balanceColumn, `Enter the original running balance in the source currency at ${precision} without rounding.`, raw, true);
    }
    const signature = JSON.stringify(row.cells);
    const previous = seen.get(signature);
    if (previous === undefined) seen.set(signature, line);
    else reason(line, balanceColumn, `This record duplicates source line ${previous}. Confirm the transaction in the original statement.`, raw);
    return { line, date: movement.date, amount, balance, raw };
  });

  let direction: BalanceChain['direction'] = null;
  let orderConflict = false;
  let previousDate: string | undefined;
  for (const { line, date } of rows) {
    if (!date) continue;
    if (previousDate && date !== previousDate) {
      const nextDirection = date > previousDate ? 'ascending' : 'descending';
      direction ??= nextDirection;
      if (direction !== nextDirection) {
        orderConflict = true;
        reason(line, dateColumn, 'This date breaks the statement’s chronological order. Supply the statement in consistent physical order.', '');
      }
    }
    previousDate = date;
  }
  if (orderConflict) direction = null;
  else if (!direction && rows.length > 1 && rows.every(({ date }) => date)) {
    reason(rows[1].line, dateColumn, 'Every transaction has the same date. The file gives no chronological direction for its physical sequence.', '');
  }

  const totalLinks = Math.max(0, rows.length - 1);
  const canCheckAmounts = currencyProblems.length === 0 && headerProblems.length === 0;
  let verifiedLinks = 0;
  if (direction && canCheckAmounts) {
    for (let index = 1; index < rows.length; index++) {
      const [older, later] = direction === 'ascending' ? [rows[index - 1], rows[index]] : [rows[index], rows[index - 1]];
      if (!older.date || !later.date || older.balance === undefined || later.balance === undefined || later.amount === undefined) continue;
      const expected = older.balance + later.amount;
      if (expected === later.balance) {
        verifiedLinks++;
        continue;
      }
      const actual = decimal(later.balance);
      const delta = decimal(later.balance - expected);
      const expectedText = decimal(expected);
      breaks.push({ row: later.line, expected: expectedText, actual, delta });
      journal.issue('balance-chain-break', later.line, balanceColumn, later.raw,
        `Expected ${expectedText}, found ${actual}, discrepancy ${delta}. Check this transaction and the preceding transaction in statement order.`,
        { editable: true, block: true });
    }
  }

  const [first, last] = direction === 'descending' ? [rows.at(-1), rows[0]] : [rows[0], rows.at(-1)];
  let openingBalance: string | null = null;
  let netMovement: string | null = null;
  let closingBalance: string | null = null;
  if (canCheckAmounts && (direction !== null || rows.length === 1)) {
    if (first?.date && first.amount !== undefined && first.balance !== undefined) openingBalance = decimal(first.balance - first.amount);
    if (last?.date && last.balance !== undefined) closingBalance = decimal(last.balance);
    let net = 0n;
    let validNet = true;
    for (const { amount } of rows) {
      if (amount === undefined) {
        validNet = false;
        break;
      }
      net += amount;
    }
    if (validNet) netMovement = decimal(net);
  }

  breaks.sort((left, right) => left.row - right.row);
  reasons.sort((left, right) => left.row - right.row);
  const status = breaks.length > 0 ? 'FAIL_BALANCE_BREAK' : reasons.length > 0 || verifiedLinks !== totalLinks ? 'UNVERIFIABLE' : 'VERIFIED';
  if (status !== 'VERIFIED') journal.blocked = true;
  journal.balanceChain = { status, direction, currency, openingBalance, netMovement, closingBalance, verifiedLinks, totalLinks, breaks, reasons };
}
