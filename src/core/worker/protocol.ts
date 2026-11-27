import type { BatchDiffOptions, ColumnSelection, ColumnSuggestions, DiffIssue, DiffRow, PriceDiffResult, PricingPreview, RowResolution, StorePlatform } from '../shopify-price-diff/types';
import type { RecipeResult, SupplierRecipe } from '../shopify-price-diff/recipe';
import type { ManualCellEdit, PlatformId, PreviewRow, RemovedRow, RepairIssue, RepairOptions, RepairResult } from '../types';
import type { CatalogImpactSummary } from '../analytics/catalog-impact';
import type { PriceCustody, RepairCustody } from '../audit/custody';
import type { ImportDiffRow, ImportInspection, ImportInspectionIssue } from '../verify-import/inspector';
import type { ShopifyMarket } from '../shopify-price-diff/markets';

export interface WorkerProgress {
  phase: 'reading' | 'parsing' | 'repairing' | 'comparing' | 'exporting';
  percent: number;
}
export interface PlatformSuggestion {
  platform: PlatformId;
  provider: 'Shopify' | 'QuickBooks' | 'Stripe' | 'PayPal' | 'Stripe / PayPal';
}
export interface GuardSummary {
  enabled: boolean;
  neutralizedCount: number;
  blockedCount: number;
}

interface PageRequest { page: number; pageSize: number }
export interface WorkerPage<T> { rows: T[]; total: number; page: number }
export interface WorkerDownload { bytes: ArrayBuffer; filename: string; mime: string }
export type DownloadFormat = 'price-csv' | 'price-rollback-csv' | 'price-audit-csv' | 'price-audit-json' | 'price-signoff-html' | 'repair-csv' | 'repair-audit-json' | 'repair-audit-txt' | 'repair-bookkeeper-html';

interface SourceMeta { name: string; issues: DiffIssue[]; issueCount: number }
export interface SheetMeta extends SourceMeta { headers: string[]; rowCount: number }
export interface BaselineMeta extends SheetMeta { hasSku: boolean; markets?: ShopifyMarket[] }
export interface SupplierMeta extends SourceMeta { sheets: SheetMeta[] }

export type DiffFilter = 'all' | 'updated' | 'flagged' | 'unmatched' | 'unchanged' | 'skipped' | 'margin-watchlist';
export type PricePreviewRow = DiffRow & { variantOptions: string; grossMarginPercent?: string | null };
export interface DiffSummary extends Pick<PriceDiffResult, 'status' | 'canDownload' | 'verification' | 'rollbackVerification' | 'inventoryEnabled' | 'overlapCount' | 'conflictCount' | 'conflictPolicy' | 'market'> {
  custody: PriceCustody;
  formulaGuard: GuardSummary;
  counts: Record<DiffFilter, number>;
  analytics: CatalogImpactSummary;
  issueCount: number;
  currencyConfirmationRequired: boolean;
  currencyConfirmationSupplierIds: string[];
  mappingBlocked: boolean;
}

export type RepairIssueFilter = 'all' | 'review' | 'fixed';
export interface RowMarks { changed: string[]; review: string[] }
export interface RepairPreviewRow extends PreviewRow { beforeMarks: RowMarks; afterMarks: RowMarks }
export interface RepairSummary extends Omit<RepairResult, 'rows' | 'issues' | 'changes' | 'removedRows' | 'repairedCsv' | 'formulaGuard' | 'bookkeeperAmounts'> {
  custody: RepairCustody;
  rowCount: number;
  removedRowCount: number;
  issueCount: number;
  fixed: number;
  warnings: number;
  manuallyEdited: number;
  formulaGuard: GuardSummary;
  suggestions: PlatformSuggestion[];
  beforeHeaderMarks: string[];
  afterHeaderMarks: string[];
}

export interface InspectionSummary extends Omit<ImportInspection, 'rows' | 'issues'> {
  rowCount: number;
  issueCount: number;
}

interface SupplierWorksheet { supplierId?: string; sheetIndex: number }
interface DiffSettings { selection: ColumnSelection; resolutions: Readonly<Record<number, RowResolution>> }
export interface SupplierBatchSetting extends DiffSettings { supplierId: string; sheetIndex: number; label?: string }

interface Operations {
  loadBaseline: [{ file: File; platform?: StorePlatform }, BaselineMeta];
  loadSupplier: [{ file: File; supplierId?: string }, SupplierMeta];
  removeSupplier: [{ supplierId: string }, undefined];
  priceSettings: [SupplierWorksheet, ColumnSuggestions];
  priceFormulaPreview: [SupplierWorksheet & { selection: ColumnSelection; market?: string }, PricingPreview | null];
  invalidatePrice: [Record<never, never>, undefined];
  diff: [SupplierWorksheet & DiffSettings & { label?: string; market?: string }, DiffSummary];
  diffBatch: [BatchDiffOptions & { suppliers: readonly SupplierBatchSetting[] }, DiffSummary];
  diffRows: [PageRequest & { filter: DiffFilter; search: string }, WorkerPage<PricePreviewRow>];
  diffIssues: [PageRequest, WorkerPage<DiffIssue>];
  inspectImport: [{ platform: StorePlatform; baseline: File; candidate: File; pairedUpdate?: File }, InspectionSummary];
  inspectionRows: [PageRequest, WorkerPage<ImportDiffRow>];
  inspectionIssues: [PageRequest, WorkerPage<ImportInspectionIssue>];
  loadRepair: [{ file: File | { bytes: Uint8Array; filename: string } }, undefined];
  repair: [{ platform: PlatformId; options: RepairOptions; edits: readonly ManualCellEdit[] }, RepairSummary];
  repairRows: [PageRequest, WorkerPage<RepairPreviewRow>];
  repairRemoved: [PageRequest, WorkerPage<RemovedRow>];
  repairIssues: [PageRequest & { filter: RepairIssueFilter }, WorkerPage<RepairIssue>];
  download: [{ format: DownloadFormat }, WorkerDownload];
  loadRecipe: [{ file: File }, RecipeResult<SupplierRecipe>];
  applyRecipe: [SupplierWorksheet & { recipe: SupplierRecipe }, RecipeResult<{ sheetIndex: number; selection: ColumnSelection }>];
  saveRecipe: [SupplierWorksheet & { supplierLabel: string; storeLabel?: string; selection: ColumnSelection }, RecipeResult<WorkerDownload>];
}

type Operation = keyof Operations;
export type WorkerRequest = { [Type in Operation]: { type: Type } & Operations[Type][0] }[Operation];
export type ResultScope = 'price' | 'repair' | 'inspection';

export function invalidatesResult(request: WorkerRequest): ResultScope | undefined {
  switch (request.type) {
    case 'loadBaseline': case 'loadSupplier': case 'removeSupplier': case 'invalidatePrice': case 'diff': case 'diffBatch': return 'price';
    case 'loadRepair': case 'repair': return 'repair';
    case 'inspectImport': return 'inspection';
  }
}

export function resultScope(request: WorkerRequest): ResultScope | undefined {
  switch (request.type) {
    case 'diff': case 'diffBatch': case 'diffRows': case 'diffIssues': return 'price';
    case 'repair': case 'repairRows': case 'repairIssues': case 'repairRemoved': return 'repair';
    case 'inspectImport': case 'inspectionRows': case 'inspectionIssues': return 'inspection';
    case 'download': return request.format.startsWith('price-') ? 'price' : 'repair';
  }
}

export const supersededResult = 'The local result was replaced before the request finished.';
export type WorkerResult<R extends WorkerRequest = WorkerRequest> = Operations[R['type']][1];
export type WorkerMessage = { id: number; request: WorkerRequest };
export type WorkerReply =
  | { id: number; kind: 'progress'; progress: WorkerProgress }
  | { id: number; kind: 'result'; value: WorkerResult }
  | { id: number; kind: 'error'; message: string };
