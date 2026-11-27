import type { SignoffBrand } from '../branding/signoff-brand';

export const costCreepFilenames = {
  historyCsv: 'supplier-cost-creep.csv',
  auditJson: 'supplier-cost-creep-audit.json',
  briefHtml: 'vendor-negotiation-brief.html',
} as const;

export interface CostCreepSource {
  bytes: Uint8Array;
  filename: string;
  sheetName?: string;
}

export interface CostCreepMapping {
  skuColumn?: number | string;
  amountColumn?: number | string;
}

export interface CostCreepPeriod extends CostCreepSource {
  label: string;
  mapping?: CostCreepMapping;
}

export interface CostCreepRetail extends CostCreepSource {
  mapping?: CostCreepMapping;
  currency?: string;
}

export interface CostCreepOptions {
  creepThresholdPercent?: string;
  retail?: CostCreepRetail;
  currency?: string;
  branding?: SignoffBrand;
}

export interface CostCreepIssue {
  code: string;
  message: string;
  row: number | null;
  rows: number[];
  column: string | null;
  sku: string | null;
  value: string | null;
  blocking: boolean;
  periodLabel: string | null;
  source: 'period' | 'retail' | 'analysis';
}

export interface CostCreepSourceInspection {
  sheetNames: string[];
  selectedSheet: string | null;
  headers: string[];
  suggestions: Partial<Record<keyof CostCreepMapping, number>>;
  issues: CostCreepIssue[];
  rowCount: number;
}

export type CostCreepLifecycle = 'active-all-periods' | 'added-later' | 'discontinued' | 'reappeared';

export interface CostCreepObservation {
  row: number;
  rawCost: string;
  cost: string;
  sourceRows: { row: number; rawCost: string }[];
}

export interface CostCreepMargin {
  retail: string;
  rawRetail: string;
  retailRow: number;
  sourceRows: { row: number; rawRetail: string }[];
  oldGrossMarginPercent: string;
  newGrossMarginPercent: string;
  compressionPoints: string;
}

export interface CostCreepRow {
  sku: string;
  observations: (CostCreepObservation | null)[];
  firstObservedCost: string;
  latestObservedCost: string;
  cumulativeDelta: string;
  cumulativeDeltaPercent: string | null;
  hikeCount: number;
  dropCount: number;
  consecutiveHikes: number;
  lifecycle: CostCreepLifecycle;
  currency: string | null;
  volatility: string;
  meetsThreshold: boolean;
  margin: CostCreepMargin | null;
}

export interface CostCreepSummary {
  trackedSkus: number;
  thresholdSkus: number;
  worstCumulativeHikePercent: string | null;
  consecutiveMultiHikeSkus: number;
}

interface CostCreepFingerprint {
  filename: string;
  bytes: number;
  sha256: string;
}

export interface CostCreepPeriodFingerprint extends CostCreepFingerprint {
  label: string;
  selectedSheet: string | null;
}

export interface CostCreepCustody {
  periods: CostCreepPeriodFingerprint[];
  retail?: CostCreepFingerprint;
  historyCsvSha256?: string;
  briefHtmlSha256?: string;
}

export interface CostCreepResult {
  status: 'ready' | 'blocked';
  rows: CostCreepRow[];
  issues: CostCreepIssue[];
  summary: CostCreepSummary;
  thresholdPercent: string;
  historyCsv: string | null;
  auditJson: string;
  briefHtml: string | null;
  custody: CostCreepCustody;
}
