import type { StorePlatform } from '../shopify-price-diff/types';

export interface PromoCampaignOptions {
  rule: {
    mode: 'percent-off' | 'fixed-amount-off';
    amount: string;
    rounding: 'none' | 'ending-99' | 'ending-95' | 'nearest-whole';
    minimumRetail: string;
    preserveHigherCompareAt?: boolean;
  };
  scope?: { skuPrefix?: string; skus?: readonly string[]; handle?: string; tag?: string };
  skipLineNumbers?: readonly number[];
  costCheck?: boolean;
  costSheet?: Uint8Array;
  storeLabel?: string;
}

export interface PromoCampaignIssue {
  code: string;
  message: string;
  severity: 'hold' | 'warning';
  source: 'campaign' | 'baseline' | 'cost-sheet' | 'native-verification';
  line?: number;
  column?: string;
}

export interface PromoCampaignRow {
  line: number;
  sku: string;
  product: string;
  status: 'changed' | 'held' | 'skipped' | 'unchanged' | 'out-of-scope';
  regularPrice: string;
  beforePrice: string;
  promoPrice: string | null;
  revertPrice: string;
  beforeCompareAtOrSalePrice: string | null;
  promoCompareAtOrSalePrice: string | null;
  revertCompareAtOrSalePrice: string | null;
  discountPercent: string | null;
  minimumRetail: string;
  cost: string | null;
  costSource: { kind: 'baseline' | 'cost-sheet'; line: number; column: string } | null;
  costMargin: string | null;
  issues: PromoCampaignIssue[];
}

export interface PromoCampaignSummary {
  totalRows: number;
  selectedRows: number;
  changedRows: number;
  heldRows: number;
  skippedRows: number;
  unchangedRows: number;
  warningRows: number;
  averageDiscountPercent: string | null;
  totalPriceReduction: string;
}

export interface PromoCampaignCustody {
  baselineSha256: string;
  launchSha256: string | null;
  revertSha256: string | null;
  costSheetSha256?: string;
}

export interface PromoCampaign {
  platform: StorePlatform;
  rows: PromoCampaignRow[];
  summary: PromoCampaignSummary;
  issues: PromoCampaignIssue[];
  canExport: boolean;
  launchCsv: string | null;
  revertCsv: string | null;
  auditJson: string;
  signoffHtml: string | null;
  fileNames: { launch: string; revert: string; audit: string; signoff: string };
  custody: PromoCampaignCustody;
}
