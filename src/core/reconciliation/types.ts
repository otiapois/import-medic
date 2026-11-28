import type { SignoffBrand } from '../branding/signoff-brand';

export interface ReconciliationSource {
  filename: string;
  bytes: Uint8Array;
}

export interface ReconciliationInput {
  payouts: ReconciliationSource;
  bank: ReconciliationSource;
  maxLagDays?: number;
  payoutCurrency?: string;
  bankCurrency?: string;
  branding?: SignoffBrand;
}

export interface ReconciledPair {
  payoutId: string;
  payoutLine: number;
  bankLine: number;
  payoutDate: string;
  bankDate: string;
  bankDescription: string;
  bankReference: string;
  currency: string;
  amountCents: string;
  lagDays: number;
}

export type ReconciliationExceptionCode =
  | 'INVALID_SOURCE'
  | 'INVALID_ROW'
  | 'DUPLICATE_PAYOUT_ID'
  | 'PAYOUT_TOTAL_MISMATCH'
  | 'AMBIGUOUS_TIE'
  | 'UNMATCHED_PAYOUT'
  | 'UNMATCHED_BANK_DEPOSIT'
  | 'UNMATCHED_NEAR_AMOUNT';

export interface CandidateLines {
  payoutLines: number[];
  bankLines: number[];
}

export interface ReconciliationException extends CandidateLines {
  code: ReconciliationExceptionCode;
  currency: string | null;
  deltaCents: string | null;
  message: string;
  column?: string;
  value?: string;
  expectedCents?: string;
  actualCents?: string;
  payoutCents?: string;
  bankCents?: string;
  lagDays?: number;
  candidateSets?: CandidateLines[];
}

export interface CurrencyTotals {
  currency: string;
  totalPayoutCents: string;
  matchedPayoutCents: string;
  unmatchedPayoutCents: string;
  ambiguousPayoutCents: string;
  totalBankInflowCents: string;
  matchedBankCents: string;
  unmatchedBankCents: string;
  ambiguousBankCents: string;
}

export interface ReconciliationSummary {
  matchedPairs: number;
  unmatchedPayouts: number;
  unmatchedBankDeposits: number;
  ambiguousGroups: number;
  exceptionCount: number;
  byCurrency: CurrencyTotals[];
}

export interface ReconciliationArtifact {
  filename: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface ReconciliationResult {
  status: 'READY' | 'HOLD';
  summary: ReconciliationSummary;
  pairs: ReconciledPair[];
  exceptions: ReconciliationException[];
  artifacts: {
    pairsCsv: ReconciliationArtifact;
    exceptionsCsv: ReconciliationArtifact;
    auditJson: ReconciliationArtifact;
    signoffHtml: ReconciliationArtifact;
  };
}
