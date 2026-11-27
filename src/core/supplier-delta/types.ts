export interface SupplierDeltaSource {
  bytes: Uint8Array;
  filename: string;
  sheetName?: string;
}

export interface SupplierDeltaMapping {
  skuColumn?: number;
  costColumn?: number;
  inventoryColumn?: number | null;
}

export type SupplierDeltaSide = 'previous' | 'next';

export interface SupplierDeltaIssue {
  code: string;
  message: string;
  row: number | null;
  rows: number[];
  column: string | null;
  sku: string | null;
  blocking: boolean;
  side: SupplierDeltaSide | null;
}

export interface SupplierDeltaInspection {
  sheetNames: string[];
  selectedSheet: string | null;
  headers: string[];
  suggestions: {
    skuColumns: number[];
    costColumns: number[];
    inventoryColumns: number[];
    mapping: SupplierDeltaMapping;
  };
  issues: SupplierDeltaIssue[];
  rowCount: number;
}

export type SupplierDeltaStatus = 'cost-increased' | 'cost-decreased' | 'unchanged' | 'added-sku' | 'removed-sku' |
  'blocked-duplicate-sku' | 'blocked-invalid-cost' | 'blocked-invalid-sku' | 'blocked-invalid-inventory' | 'blocked-currency';

export interface SupplierDeltaRow {
  sku: string | null;
  status: SupplierDeltaStatus;
  previousRow: number | null;
  newRow: number | null;
  previousCost: string | null;
  newCost: string | null;
  delta: string | null;
  deltaPercent: string | null;
  previousInventory: string | null;
  newInventory: string | null;
  inventoryDelta: string | null;
  currency: string | null;
}

export interface SupplierDeltaCustody {
  previousSha256: string;
  newSha256: string;
  deltaCsvSha256?: string;
  signOffHtmlSha256?: string;
}

export interface SupplierDeltaResult {
  status: 'ready' | 'blocked';
  rows: SupplierDeltaRow[];
  issues: SupplierDeltaIssue[];
  counts: Record<SupplierDeltaStatus, number>;
  maxHikePercent: string | null;
  deltaCsv: string | null;
  auditJson: string;
  signOffHtml: string | null;
  custody: SupplierDeltaCustody;
}

export interface SupplierDeltaSourceDetails {
  filename: string;
  selectedSheet: string | null;
  bytes: number;
}
