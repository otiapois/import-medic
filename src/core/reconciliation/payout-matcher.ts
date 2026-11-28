import { writeReconciliationArtifacts } from './output';
import { parseReconciliationSource, type CandidateRow, type LedgerRow } from './source';
import type { CurrencyTotals, ReconciledPair, ReconciliationException, ReconciliationInput, ReconciliationResult } from './types';

export type { CurrencyTotals, ReconciledPair, ReconciliationException, ReconciliationInput, ReconciliationResult } from './types';

interface SettlementDay {
  side: 'payouts' | 'bank';
  rows: CandidateRow[];
  links: SettlementDay[];
}

const allLines = (rows: readonly LedgerRow[]) => rows.map(({ record }) => record.line).sort((a, b) => a - b);

function matchExact(payouts: CandidateRow[], bank: CandidateRow[], maxLagDays: number) {
  type Dates = Map<number, SettlementDay>;
  const byAmount = new Map<string, { payouts: Dates; bank: Dates }>();
  for (const [side, rows] of [['payouts', payouts], ['bank', bank]] as const) {
    for (const row of rows) {
      const key = row.currency + ':' + row.amount;
      let dates = byAmount.get(key);
      if (!dates) byAmount.set(key, dates = { payouts: new Map(), bank: new Map() });
      const group = dates[side].get(row.day);
      if (group) group.rows.push(row);
      else dates[side].set(row.day, { side, rows: [row], links: [] });
    }
  }

  const pairs: ReconciledPair[] = [];
  const ties: ReconciliationException[] = [];
  const visited = new Set<SettlementDay>();
  for (const dates of byAmount.values()) {
    // Same-currency, same-amount rows on one date have identical candidate sets.
    // Connect each date bucket once, even if many duplicate deposits share that date.
    for (const [day, payout] of dates.payouts) {
      for (let lag = 0; lag <= maxLagDays; lag++) {
        const deposit = dates.bank.get(day + lag);
        if (deposit) {
          payout.links.push(deposit);
          deposit.links.push(payout);
        }
      }
    }
    for (const start of dates.payouts.values()) {
      if (visited.has(start) || start.links.length === 0) continue;
      const component = [start];
      const payoutRows: CandidateRow[] = [];
      const bankRows: CandidateRow[] = [];
      visited.add(start);
      for (const day of component) {
        const side = day.side === 'payouts' ? payoutRows : bankRows;
        for (const row of day.rows) side.push(row);
        for (const next of day.links) {
          if (!visited.has(next)) {
            visited.add(next);
            component.push(next);
          }
        }
      }
      if (payoutRows.length === 1 && bankRows.length === 1) {
        const [payout] = payoutRows;
        const [deposit] = bankRows;
        payout.record.disposition = deposit.record.disposition = 'matched';
        pairs.push({
          payoutId: payout.id, payoutLine: payout.record.line, bankLine: deposit.record.line,
          payoutDate: payout.date, bankDate: deposit.date, bankDescription: deposit.description,
          bankReference: deposit.reference, currency: payout.currency, amountCents: payout.amount.toString(),
          lagDays: deposit.day - payout.day,
        });
      } else {
        for (const row of payoutRows) row.record.disposition = 'ambiguous';
        for (const row of bankRows) row.record.disposition = 'ambiguous';
        const candidateSets = component.filter(day => day.side === 'payouts').map(day => ({
          payoutLines: allLines(day.rows), bankLines: allLines(day.links.flatMap(other => other.rows)),
        })).sort((a, b) => a.payoutLines[0] - b.payoutLines[0]);
        ties.push({ code: 'AMBIGUOUS_TIE', currency: payoutRows[0].currency, deltaCents: null,
          payoutLines: allLines(payoutRows), bankLines: allLines(bankRows), candidateSets,
          payoutCents: payoutRows[0].amount.toString(), bankCents: payoutRows[0].amount.toString(),
          message: 'Multiple exact candidates share this currency, amount, and settlement window. Review the source lines before pairing them.' });
      }
    }
  }
  return { pairs: pairs.sort((a, b) => a.payoutLine - b.payoutLine),
    ties: ties.sort((a, b) => a.payoutLines[0] - b.payoutLines[0]) };
}

interface NearCohort {
  currency: string;
  day: number;
  amount: bigint;
  lines: number[];
}

function unmatchedByDay(rows: CandidateRow[]): Map<string, NearCohort[]> {
  const groups = new Map<string, Map<bigint, NearCohort>>();
  for (const row of rows) {
    if (row.record.disposition !== 'unmatched') continue;
    const key = row.currency + ':' + row.day;
    let byAmount = groups.get(key);
    if (!byAmount) groups.set(key, byAmount = new Map());
    const cohort = byAmount.get(row.amount);
    if (cohort) cohort.lines.push(row.record.line);
    else byAmount.set(row.amount, { currency: row.currency, day: row.day, amount: row.amount, lines: [row.record.line] });
  }
  return new Map([...groups].map(([key, amounts]) => [key, [...amounts.values()]]));
}

function nearAmounts(payouts: CandidateRow[], bank: CandidateRow[], maxLagDays: number): ReconciliationException[] {
  const deposits = unmatchedByDay(bank);
  for (const rows of deposits.values()) rows.sort((a, b) => a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0);

  const near: ReconciliationException[] = [];
  const payoutCohorts = [...unmatchedByDay(payouts).values()].flat().sort((a, b) => a.lines[0] - b.lines[0]);
  for (const payout of payoutCohorts) {
    // For integer cents, abs(delta) * 50 <= payout is equivalent to abs(delta) <= floor(payout / 50).
    const relative = payout.amount / 50n;
    const radius = relative > 2500n ? relative : 2500n;
    const lower = payout.amount - radius;
    const upper = payout.amount + radius;
    const candidates: NearCohort[] = [];
    for (let lag = 0; lag <= maxLagDays; lag++) {
      const rows = deposits.get(payout.currency + ':' + (payout.day + lag));
      if (!rows) continue;
      let left = 0;
      let right = rows.length;
      while (left < right) {
        const middle = Math.floor((left + right) / 2);
        if (rows[middle].amount < lower) left = middle + 1;
        else right = middle;
      }
      for (let index = left; index < rows.length && rows[index].amount <= upper; index++) candidates.push(rows[index]);
    }
    candidates.sort((a, b) => a.lines[0] - b.lines[0]);
    for (const deposit of candidates) {
      const delta = deposit.amount - payout.amount;
      if (delta === 0n) continue;
      near.push({ code: 'UNMATCHED_NEAR_AMOUNT', payoutLines: payout.lines, bankLines: deposit.lines,
        currency: payout.currency, payoutCents: payout.amount.toString(), bankCents: deposit.amount.toString(),
        deltaCents: delta.toString(), lagDays: deposit.day - payout.day,
        message: 'A nearby unreconciled bank inflow differs from the payout amount. Check possible fees or another settlement.' });
    }
  }
  return near;
}

function currencyTotals(payouts: LedgerRow[], bank: LedgerRow[]): CurrencyTotals[] {
  const zero = () => ({ total: 0n, matched: 0n, unmatched: 0n, ambiguous: 0n });
  const currencies = new Map<string, { payouts: ReturnType<typeof zero>; bank: ReturnType<typeof zero> }>();
  for (const [side, rows] of [['payouts', payouts], ['bank', bank]] as const) {
    for (const { currency, amount, record } of rows) {
      let group = currencies.get(currency);
      if (!group) currencies.set(currency, group = { payouts: zero(), bank: zero() });
      const totals = group[side];
      totals.total += amount;
      const state = record.disposition;
      if (state === 'matched' || state === 'unmatched' || state === 'ambiguous') totals[state] += amount;
    }
  }
  return [...currencies.entries()].map(([currency, { payouts, bank }]) => {
    if ([payouts, bank].some(({ total, matched, unmatched, ambiguous }) => total !== matched + unmatched + ambiguous)
      || payouts.matched !== bank.matched) throw new Error('Payout reconciliation failed cent conservation.');
    return { currency, totalPayoutCents: payouts.total.toString(), matchedPayoutCents: payouts.matched.toString(),
      unmatchedPayoutCents: payouts.unmatched.toString(), ambiguousPayoutCents: payouts.ambiguous.toString(),
      totalBankInflowCents: bank.total.toString(), matchedBankCents: bank.matched.toString(),
      unmatchedBankCents: bank.unmatched.toString(), ambiguousBankCents: bank.ambiguous.toString() };
  });
}

export async function reconcilePayouts(input: ReconciliationInput): Promise<ReconciliationResult> {
  const { maxLagDays = 5 } = input;
  if (!Number.isInteger(maxLagDays) || maxLagDays < 0 || maxLagDays > 10) {
    throw new Error('Settlement lag must be an integer from 0 to 10 calendar days.');
  }
  const payouts = parseReconciliationSource(input.payouts, 'payouts', input.payoutCurrency);
  const bank = parseReconciliationSource(input.bank, 'bank', input.bankCurrency);
  const exceptions = [...payouts.exceptions, ...bank.exceptions];
  const sourceValid = exceptions.length === 0;
  // An invalid row can hide a competing deposit or payout. Only complete source evidence establishes an isolated exact pair.
  const { pairs, ties } = sourceValid ? matchExact(payouts.candidates, bank.candidates, maxLagDays) : { pairs: [], ties: [] };
  for (const tie of ties) exceptions.push(tie);

  const unmatchedPayouts = payouts.ledger.filter(row => row.record.disposition === 'unmatched');
  const unmatchedBank = bank.ledger.filter(row => row.record.disposition === 'unmatched');
  for (const { id, record, currency, amount } of unmatchedPayouts) {
    exceptions.push({ code: 'UNMATCHED_PAYOUT', payoutLines: [record.line], bankLines: [], currency,
      payoutCents: amount.toString(), deltaCents: null,
      message: sourceValid ? `Payout ${id} has no exact bank inflow in the settlement window.` : 'Payout remains unmatched while source issues require review.' });
  }
  for (const { record, currency, amount } of unmatchedBank) {
    exceptions.push({ code: 'UNMATCHED_BANK_DEPOSIT', payoutLines: [], bankLines: [record.line], currency,
      bankCents: amount.toString(), deltaCents: null,
      message: sourceValid ? 'Bank inflow has no exact payout in the settlement window.' : 'Bank inflow remains unmatched while source issues require review.' });
  }
  if (sourceValid) for (const near of nearAmounts(payouts.candidates, bank.candidates, maxLagDays)) exceptions.push(near);

  const status = exceptions.length ? 'HOLD' : 'READY';
  const summary = { matchedPairs: pairs.length, unmatchedPayouts: unmatchedPayouts.length, unmatchedBankDeposits: unmatchedBank.length,
    ambiguousGroups: ties.length, exceptionCount: exceptions.length, byCurrency: currencyTotals(payouts.ledger, bank.ledger) };
  const outcome = { status, summary, pairs, exceptions } as const;
  const artifacts = await writeReconciliationArtifacts(input, maxLagDays, sourceValid,
    { payouts: payouts.evidence, bank: bank.evidence }, outcome);
  return { ...outcome, artifacts };
}
