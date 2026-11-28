import type { FormulaGuardAudit } from './formula-guard';

export const PLATFORM_IDS = ['shopify-products', 'quickbooks-bank', 'stripe-paypal', 'xero-bank', 'freshbooks-expenses'] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];
export type DateOrder = 'auto' | 'MDY' | 'DMY';
export type QuickBooksLayout = '3col' | '4col';
export type CreditDebitConvention = 'auto' | 'bank' | 'intuit';
export type StripePayPalOutput = 'accounting' | 'quickbooks-3col';
export type FeeConvention = 'deduction' | 'signed-movement';
export type DetectedEncoding = 'utf-8' | 'utf-8-bom' | 'windows-1252' | 'utf-16le' | 'unknown';
export type DetectedLineEnding = 'crlf' | 'lf' | 'mixed';

export interface RepairOptions {
  dateOrder?: DateOrder;
  qboLayout?: QuickBooksLayout;
  qboCreditDebit?: CreditDebitConvention;
  stripePayPalOutput?: StripePayPalOutput;
  stripePayPalFeeConvention?: FeeConvention | 'auto';
  excludePayPalMemo?: boolean;
  formulaGuard?: boolean;
}

export interface RepairIssue {
  id: string;
  severity: 'error' | 'warning';
  code: string;
  row: number;
  column: string;
  rawValue: string;
  fixedValue?: string;
  autoFixed: boolean;
  message: string;
  ruleDocSlug: string;
  editable?: boolean;
  reconciliation?: { gross: string; fee: string; net: string; expectedNet: string; feeConvention: FeeConvention };
  taxReconciliation?: TaxLineAmounts;
  relatedLines?: readonly number[];
  duplicateGroup?: number;
}

export interface CellChange {
  row: number;
  column: string;
  before: string;
  after: string;
  reason: string;
  code: string;
}

export interface RemovedRow {
  row: number;
  rawPreview: string;
  reason: string;
  code: string;
}

export interface PreviewRow {
  row: number;
  before: readonly string[];
  after: readonly string[];
}

export interface ManualCellEdit {
  row: number;
  column: string;
  value: string;
}

export interface RoundtripCheck {
  checked: boolean;
  autoFixableRemaining: number | null;
  needsManualReviewCount: number | null;
}

export interface BookkeeperAmountRow {
  row: number;
  currency: string | null;
  amounts: Partial<Record<'amount' | 'gross' | 'fee' | 'net', string>>;
}

export interface BalanceChainBreak {
  row: number;
  expected: string;
  actual: string;
  delta: string;
}

export interface BalanceChain {
  status: 'VERIFIED' | 'FAIL_BALANCE_BREAK' | 'UNVERIFIABLE';
  direction: 'ascending' | 'descending' | null;
  currency: string | null;
  openingBalance: string | null;
  netMovement: string | null;
  closingBalance: string | null;
  verifiedLinks: number;
  totalLinks: number;
  breaks: readonly BalanceChainBreak[];
  reasons: readonly { row: number; column: string; message: string }[];
}

export interface FreshBooksTaxRow {
  row: number;
  name: string;
  amount: string;
}

export interface TaxLineAmounts {
  net: string;
  tax: string;
  gross: string;
  expectedGross: string;
  delta: string;
}

export interface TaxReconciliation {
  status: 'VERIFIED' | 'FAIL_TAX_MISMATCH' | 'UNVERIFIABLE';
  checkedRows: number;
  mismatchCount: number;
  unverifiableCount: number;
  mismatches: readonly (TaxLineAmounts & { row: number })[];
  reasons: readonly { row: number; column: string; message: string }[];
}

export interface DuplicateTransactions {
  groupCount: number;
  affectedRows: number;
  groups: readonly { lines: readonly number[]; date: string; amount: string; currency: string | null; description: string }[];
}

export interface RepairResult {
  filename: string;
  platform: PlatformId;
  detectedEncoding: DetectedEncoding;
  detectedLineEnding: DetectedLineEnding;
  sourceHeaders: readonly string[];
  headers: readonly string[];
  rows: readonly PreviewRow[];
  issues: readonly RepairIssue[];
  changes: readonly CellChange[];
  removedRows: readonly RemovedRow[];
  needsManualReviewCount: number;
  repairedCsv: string;
  canDownload: boolean;
  roundtripCheck: RoundtripCheck;
  formulaGuard: FormulaGuardAudit;
  bookkeeperAmounts: readonly BookkeeperAmountRow[];
  balanceChain?: BalanceChain;
  freshBooksTaxes?: readonly FreshBooksTaxRow[];
  taxReconciliation?: TaxReconciliation;
  duplicateTransactions?: DuplicateTransactions;
  currencySplit?: readonly { currency: string; lines: readonly number[] }[];
  stripePayPalFeeConvention?: FeeConvention;
}
