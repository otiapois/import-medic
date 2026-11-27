import type { SignoffBrand } from '../branding/signoff-brand';

export interface InventorySource {
  filename: string;
  bytes: Uint8Array;
}

export interface InventoryMapping {
  skuColumn: number;
  quantityColumn: number;
}

export interface InventorySupplierSource extends InventorySource {
  sheetName?: string;
  mapping?: InventoryMapping;
}

export interface InventorySyncOptions {
  targetLocation?: string;
  reserveUnits: number;
  zeroOutThreshold: number;
  maxCap?: number;
  approveLargeDrop?: boolean;
  brand?: SignoffBrand;
}

export interface InventoryOffer {
  supplierIndex: number;
  line: number;
  quantity: number;
  rawQuantity: string;
}

export interface InventoryIssue {
  code: string;
  message: string;
  source: 'baseline' | 'supplier' | 'run';
  line?: number;
  lines?: number[];
  supplierIndex?: number;
  sku?: string;
  column?: string;
  value?: string;
  offers?: InventoryOffer[];
}

export interface InventoryBaselineInspection {
  locations: string[];
  issues: InventoryIssue[];
}

export interface InventorySupplierInspection {
  headers: string[];
  sheetNames: string[];
  issues: InventoryIssue[];
}

export interface InventorySyncRow {
  sku: string;
  baselineLine: number;
  currentRaw: string;
  currentQty: number | null;
  proposedQty: number | null;
  bufferWithheld: number | null;
  supplierQty: number | null;
  status: 'changed' | 'unchanged' | 'no-supplier-match' | 'approval-required' | 'blocked';
  offers: InventoryOffer[];
  largeDrop?: boolean;
}

export interface InventoryTotals {
  unitsAdded: number | string;
  unitsRemoved: number | string;
  bufferZeroedCount: number;
  outOfStockCount: number;
  changedCount: number;
}

export interface InventoryFingerprint {
  filename: string;
  byteLength: number;
  sha256: string;
  sheetName?: string;
}

export interface InventoryCustody {
  baseline: InventoryFingerprint;
  suppliers: InventoryFingerprint[];
  updateCsvSha256?: string;
  rollbackCsvSha256?: string;
}

export interface InventorySyncResult {
  status: 'ready' | 'no-changes' | 'blocked';
  targetLocation: string | null;
  rows: InventorySyncRow[];
  issues: InventoryIssue[];
  totals: InventoryTotals;
  updateCsv: Uint8Array<ArrayBuffer> | null;
  rollbackCsv: Uint8Array<ArrayBuffer> | null;
  auditJson: string;
  signOffHtml: string;
  custody: InventoryCustody;
  verification: { checked: boolean; restoredRows: number; otherLocationRowsUntouched: number };
}
