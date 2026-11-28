import type { SignoffBrand } from '../branding/signoff-brand';

export const purchaseOrderPolicies = ['lowest-landed-cost', 'prefer-first', 'block-ties'] as const;
export type PurchaseOrderPolicy = typeof purchaseOrderPolicies[number];

export interface PurchaseOrderSource {
  filename: string;
  bytes: Uint8Array;
}

export interface PurchaseOrderSupplier extends PurchaseOrderSource {
  label: string;
  sheetName?: string;
}

export interface PurchaseOrderOptions {
  targetLocation?: string;
  reorderPoint?: string;
  targetStock?: string;
  policy?: PurchaseOrderPolicy;
  poReference?: string;
  branding?: SignoffBrand;
  workspaceProfile?: PurchaseOrderSource;
}

export interface PurchaseOrderIssue {
  source: 'inventory' | 'supplier' | 'run';
  code: string;
  message: string;
  line?: number;
  lines?: number[];
  supplierIndex?: number;
  sku?: string;
  column?: string;
  value?: string;
  offers?: { supplierIndex: number; line: number }[];
}

export interface PurchaseOrderInventoryInspection {
  locations: string[];
  quantityBasis: string | null;
  issues: PurchaseOrderIssue[];
}

export interface PurchaseOrderSupplierInspection {
  sheetNames: string[];
  selectedSheet: string | null;
  issues: PurchaseOrderIssue[];
}

export interface PurchaseOrderLine {
  sku: string;
  supplierSku: string;
  currentQty: number;
  reorderPoint: number;
  targetStock: number;
  orderQty: number;
  unitCost: string;
  lineTotal: string;
  unitCostCents: number;
  lineTotalCents: number;
  inventoryLine: number;
  supplierLine: number;
  moq: number;
  casePack: number;
  leadTimeDays: number | null;
}

export interface PurchaseOrderSupplierGroup {
  supplierIndex: number;
  label: string;
  lines: PurchaseOrderLine[];
  unitsOrdered: number;
  totalCents: number;
  totalSpend: string;
}

export interface PurchaseOrderSummary {
  belowReorder: number;
  unitsOrdered: number;
  supplierCount: number;
  totalCents: number;
  totalSpend: string;
}

export interface PurchaseOrderDownload {
  filename: string;
  content: string;
}

export interface PurchaseOrderResult {
  status: 'ready' | 'blocked';
  targetLocation: string | null;
  quantityBasis: string | null;
  currency: string | null;
  summary: PurchaseOrderSummary;
  issues: PurchaseOrderIssue[];
  groups: PurchaseOrderSupplierGroup[];
  supplierCsvs: (PurchaseOrderDownload & { supplierIndex: number })[];
  summaryCsv: PurchaseOrderDownload | null;
  auditJson: PurchaseOrderDownload;
  packHtml: PurchaseOrderDownload | null;
}
