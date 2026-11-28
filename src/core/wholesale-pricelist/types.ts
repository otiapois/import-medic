import type { StorePlatform } from '../shopify-price-diff/types';

export interface WholesaleTier {
  tierName: string;
  discountMode: 'percent-off-retail' | 'cost-plus-percent';
  value: string;
  minOrderQty: string;
  rounding: 'none' | 'ending-99' | 'ending-95' | 'nearest-whole';
}

export interface WholesaleOptions {
  tiers: readonly WholesaleTier[];
  minimumMarginPercent?: string;
  requireMap?: boolean;
  costSheet?: Uint8Array;
  worksheetName?: string;
  brandLabel: string;
  effectiveDate: string;
  currency: string;
  shopifyCatalogTitle: string;
  shopifyTierName: string;
}

export interface WholesaleIssue {
  code: string;
  message: string;
  source: 'baseline' | 'cost-sheet' | 'options' | 'pricing' | 'native';
  sku?: string;
  tierName?: string;
  line?: number;
  lines?: number[];
  baselineLine?: number;
  costLine?: number;
  column?: string;
}

export interface WholesaleBuyerTier {
  tierName: string;
  minOrderQty: string;
  unitPrice: string;
}

export interface WholesaleBuyerRow {
  sku: string;
  product: string;
  casePack: string;
  tiers: WholesaleBuyerTier[];
}

export interface WholesalePriceTier extends Omit<WholesaleBuyerTier, 'unitPrice' | 'minOrderQty'> {
  minOrderQty: string | null;
  unitPrice: string | null;
  marginPercent: string | null;
  profit: string | null;
}

export interface WholesalePriceRow extends Omit<WholesaleBuyerRow, 'tiers'> {
  line: number;
  retailPrice: string;
  landedCost: string | null;
  map: string | null;
  moq: string;
  costLine: number | null;
  tiers: WholesalePriceTier[];
}

export interface WholesaleCustody {
  baselineSha256: string;
  costSheetSha256: string | null;
  buyerSha256: string | null;
  shopifySha256: string | null;
  lineSheetSha256: string | null;
  internalSha256: string | null;
}

export interface WholesalePriceList {
  platform: StorePlatform;
  canExport: boolean;
  rows: WholesalePriceRow[];
  buyerRows: WholesaleBuyerRow[];
  issues: WholesaleIssue[];
  fileNames: { buyer: string; shopify: string; lineSheet: string; internal: string; audit: string };
  custody: WholesaleCustody;
  selectedWorksheet: string | null;
  buyerCsv: string | null;
  shopifyCsv: string | null;
  lineSheetHtml: string | null;
  internalCsv: string | null;
  auditJson: string;
}
