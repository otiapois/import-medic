import { amountGreaterThan, currenciesAgree, readAmount, sameAmount, type Amount } from './prices';
import type { DiffRow, SupplierContender, ConflictPolicy } from './types';

export interface SupplierCandidate {
  row: DiffRow;
  evidence: SupplierContender;
  amount: Amount | null;
  currency: string[];
  outputCurrency?: string;
  invalid: boolean;
  bomCost?: string | null;
}

const equalAmount = (left: string | null | undefined, right: string | null | undefined) => {
  if (left === right) return true;
  const a = left ? readAmount(left) : null;
  const b = right ? readAmount(right) : null;
  return a !== null && b !== null && sameAmount(a, b);
};

function equivalent(left: SupplierCandidate, right: SupplierCandidate): boolean {
  const compareAt = (candidate: SupplierCandidate) => candidate.row.baselineRow === null
    ? candidate.evidence.compareAtPrice : candidate.row.newCompareAtPrice;
  return equalAmount(left.row.newPrice, right.row.newPrice)
    && equalAmount(compareAt(left), compareAt(right))
    && equalAmount(left.row.newInventoryQty, right.row.newInventoryQty)
    && currenciesAgree([left.outputCurrency, right.outputCurrency].filter(unit => unit !== undefined))
    && equalAmount(left.bomCost, right.bomCost);
}

export function chooseSupplier(
  candidates: readonly SupplierCandidate[], policy: ConflictPolicy, confirmed: boolean,
): { winner: SupplierCandidate | null; conflict: boolean; code?: string } {
  const first = candidates[0];
  if (candidates.length === 1) return { winner: first, conflict: false };
  const comparisonCurrencyAgrees = currenciesAgree(candidates.flatMap(({ currency }) => currency));
  const invalid = candidates.some(({ invalid, amount, bomCost }) => invalid || amount === null || amount.units < 0n || amount.units === 0n && bomCost !== '0.00');
  const conflict = invalid || !comparisonCurrencyAgrees ||
    candidates.some((candidate) => !sameAmount(first.amount!, candidate.amount!) || !equivalent(first, candidate));
  if (invalid || (policy === 'block-conflicts' && conflict)) return { winner: null, conflict, code: 'supplier-conflict' };
  if (policy === 'block-conflicts') return { winner: first, conflict };
  if (!confirmed) return { winner: null, conflict, code: 'supplier-conflict-confirmation-required' };
  if (policy === 'prefer-first' || policy === 'prefer-last') {
    return { winner: policy === 'prefer-first' ? first : candidates[candidates.length - 1], conflict };
  }
  if (!comparisonCurrencyAgrees) return { winner: null, conflict, code: 'incomparable-supplier-prices' };
  const winner = candidates.reduce((current, candidate) => {
    const [larger, smaller] = policy === 'prefer-highest' ? [candidate, current] : [current, candidate];
    return amountGreaterThan(larger.amount!, smaller.amount!) ? candidate : current;
  });
  if (candidates.some((candidate) => sameAmount(winner.amount!, candidate.amount!) && !equivalent(winner, candidate))) {
    return { winner: null, conflict, code: 'supplier-conflict' };
  }
  return { winner, conflict };
}
