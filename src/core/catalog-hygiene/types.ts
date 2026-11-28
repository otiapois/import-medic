import type { SignoffBrand } from '../branding/signoff-brand';
import type { StorePlatform } from '../shopify-price-diff/types';

export interface CatalogHygieneSource {
  platform: StorePlatform;
  filename: string;
  bytes: Uint8Array;
}

export interface CatalogHygieneOptions {
  trimSkus?: boolean;
  stripZeroWidth?: boolean;
  branding?: SignoffBrand;
  workspaceProfile?: CatalogHygieneArtifact;
}

export interface CatalogLine {
  sourceIndex: number;
  line: number;
}

export interface CatalogHygieneIssue {
  code: string;
  level: 'blocked' | 'warning' | 'fixed';
  sourceIndex: number;
  line: number | null;
  column: string | null;
  value: string | null;
  after?: string;
  expectedCheckDigit?: string;
  suppliedCheckDigit?: string;
  related?: CatalogLine[];
  message: string;
}

export interface CatalogHygieneSummary {
  scannedRows: number;
  invalidBarcodes: number;
  duplicateSkus: number;
  safeTrimFixes: number;
  safeZeroWidthFixes: number;
  blockingIssues: number;
}

export interface CatalogHygieneFingerprint {
  filename: string;
  byteLength: number;
  sha256: string;
}

export interface CatalogHygieneSourceResult extends CatalogHygieneFingerprint {
  sourceIndex: number;
  platform: StorePlatform;
  rows: number;
}

export interface CatalogHygieneArtifact {
  filename: string;
  bytes: Uint8Array;
}

export interface CatalogHygieneCatalog {
  sourceIndex: number;
  cleanedCsv: CatalogHygieneArtifact;
  rollbackCsv: CatalogHygieneArtifact;
}

export interface CatalogHygieneResult {
  status: 'READY' | 'HOLD';
  summary: CatalogHygieneSummary;
  sources: CatalogHygieneSourceResult[];
  issues: CatalogHygieneIssue[];
  artifacts: {
    issuesCsv: CatalogHygieneArtifact;
    auditJson: CatalogHygieneArtifact;
    reportHtml: CatalogHygieneArtifact;
    catalogs: CatalogHygieneCatalog[];
  };
}
