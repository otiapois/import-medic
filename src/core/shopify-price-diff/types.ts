import type { PriceCustody } from '../audit/custody';
import type { FormulaGuardAudit } from '../formula-guard';
import type { FxConversion, PricingRule } from './pricing-rules';
import type { ShopifyMarket } from './markets';

export interface DiffIssue {
  code: string;
  source: 'baseline' | 'supplier' | 'mapping' | 'verification';
  row: number | null;
  column: string | null;
  value: string | null;
  rows: number[];
  message: string;
  blocking: boolean;
  supplierId?: string;
  supplierSource?: string;
  supplierContenders?: SupplierContender[];
}

export interface SourceCell {
  value: string | null;
  kind: 'text' | 'number' | 'formula' | 'unsupported' | 'missing';
  formula?: string;
  scientific?: boolean;
  currency?: string;
}

export interface SourceRow {
  line: number;
  cells: SourceCell[];
}

export interface SourceTable {
  name: string;
  headerRow: number | null;
  headers: string[];
  rows: SourceRow[];
  issues: DiffIssue[];
}

export type StorePlatform = 'shopify' | 'woocommerce' | 'bigcommerce';

export interface WooCommerceIdentity {
  id: string;
  type: string;
  parent: string;
}

export interface BigCommerceIdentity {
  id: string;
  type: 'Product' | 'SKU';
  name: string;
  productId: string;
}

export interface Baseline extends SourceTable {
  platform?: StorePlatform;
  columns: ReadonlyMap<string, number>;
  variants: Variant[];
  markets?: ShopifyMarket[];
  market?: ShopifyMarket;
  bigcommerceGroupedProducts?: ReadonlySet<string>;
}

export interface Variant {
  source: SourceRow;
  handle: string;
  sku: string;
  options: string[];
  price: string;
  compareAtPrice: string | null;
  inventoryQty: string | null;
  linkedOption: boolean;
  woocommerce?: WooCommerceIdentity;
  bigcommerce?: BigCommerceIdentity;
}

export type SupplierSheet = SourceTable & { selectedSheet?: string };

export interface SupplierFile {
  name: string;
  sheets: SupplierSheet[];
  selectedSheet?: string;
  sheetNames?: string[];
  issues: DiffIssue[];
}

export interface ColumnSelection {
  market?: string;
  joinKey?: 'sku' | 'handle-options';
  skuColumn?: number;
  handleColumn?: number;
  optionColumns?: readonly (number | null)[];
  priceColumn?: number;
  compareAtColumn?: number | null;
  inventoryColumn?: number | null;
  inventoryDropThresholdPercent?: number;
  conflictPolicy?: ConflictPolicy;
  confirmed?: boolean;
  sameCurrencyConfirmed?: boolean;
  fxRateConfirmed?: boolean;
  dropThresholdPercent?: number;
  increaseThresholdPercent?: number;
  formulaGuard?: boolean;
  pricingRule?: PricingRule;
}

export interface ColumnSuggestions {
  skuColumns: number[];
  handleColumns: number[];
  optionColumns: number[][];
  priceColumns: number[];
  compareAtColumns: number[];
  selection: ColumnSelection;
  requiresConfirmation: boolean;
}

export interface RowResolution {
  skip?: boolean;
  price?: string;
  compareAtPrice?: string;
  inventoryQty?: string;
  confirm?: boolean;
}

export const conflictPolicies = ['block-conflicts', 'prefer-first', 'prefer-last', 'prefer-lowest', 'prefer-highest'] as const;
export type ConflictPolicy = typeof conflictPolicies[number];

export interface SupplierDiffInput {
  supplierId: string;
  filename: string;
  label?: string;
  sheet: SupplierSheet;
  selection?: ColumnSelection;
  resolutions?: Readonly<Record<number, RowResolution>>;
}

export interface BatchDiffOptions {
  market?: string;
  conflictPolicy?: ConflictPolicy;
  conflictPolicyConfirmed?: boolean;
}

export interface SupplierContender {
  supplierId: string;
  label: string;
  filename: string;
  worksheet: string;
  row: number;
  priceColumn: string | null;
  price: string | null;
  inventoryColumn: string | null;
  inventoryQty: string | null;
  compareAtColumn: string | null;
  compareAtPrice: string | null;
}

export interface DiffRow {
  id: string;
  status: 'Updated' | 'Unchanged' | 'Unmatched Supplier Row' | 'Missing in Supplier' | 'Blocked' | 'Skipped';
  sku: string | null;
  handle: string | null;
  woocommerce?: WooCommerceIdentity;
  bigcommerce?: BigCommerceIdentity;
  market?: ShopifyMarket;
  baselineRow: number | null;
  supplierRow: number | null;
  oldPrice: string | null;
  newPrice: string | null;
  deltaPercent: string | null;
  oldCompareAtPrice: string | null;
  newCompareAtPrice: string | null;
  supplierPrice: string | null;
  computedPrice: string | null;
  landedCost?: string;
  matchedTier?: string;
  fxApplied?: FxConversion;
  supplierCompareAtPrice: string | null;
  priceOutput: 'omitted' | 'value';
  compareAtOutput: 'omitted' | 'empty' | 'value';
  supplierId?: string;
  supplierSource?: string;
  supplierFilename?: string;
  supplierWorksheet?: string;
  supplierContenders?: SupplierContender[];
  oldInventoryQty?: string | null;
  newInventoryQty?: string | null;
  supplierInventoryQty?: string | null;
  inventoryOutput?: 'omitted' | 'empty' | 'value';
  issues: DiffIssue[];
}

export interface Verification {
  checked: boolean;
  nonTargetFieldsChanged: number;
  brokenVariantGroups: number;
}

export interface RollbackVerification {
  checked: boolean;
  restoredVariants: number;
}

export interface PricingPreview {
  supplierRow: number;
  supplierPrice: string;
  computedPrice: string;
  computedCompareAtPrice?: string;
  matchedTier?: string;
  retailAdjustmentPercent?: string;
  fxApplied?: FxConversion;
}

export interface PriceDiffResult {
  market?: ShopifyMarket;
  rows: DiffRow[];
  issues: DiffIssue[];
  suggestions: ColumnSuggestions;
  status: 'ready' | 'review' | 'no-changes';
  canDownload: boolean;
  updateCsv: string | null;
  rollbackCsv: string | null;
  updateBytes: Uint8Array<ArrayBuffer> | null;
  rollbackBytes: Uint8Array<ArrayBuffer> | null;
  auditCsv: string;
  auditJson: string;
  serializeAuditJson(custody?: PriceCustody): string;
  verification: Verification;
  rollbackVerification: RollbackVerification;
  formulaGuard: FormulaGuardAudit;
  inventoryEnabled: boolean;
  overlapCount: number;
  conflictCount: number;
  conflictPolicy: ConflictPolicy;
  supplierPricing?: { supplierId: string; label: string; filename: string; pricingRule?: PricingRule }[];
}

export function issue(source: DiffIssue['source'], code: string, message: string, details: Partial<Omit<DiffIssue, 'source' | 'code' | 'message'>> = {}): DiffIssue {
  const row = details.row ?? null;
  return { source, code, message, row, column: null, value: null, rows: row === null ? [] : [row], blocking: true, ...details };
}

export const cellValue = (row: SourceRow, index: number | null | undefined): string | null =>
  index === undefined || index === null ? null : row.cells[index]?.value ?? null;
