import type { SignoffBrand } from '../branding/signoff-brand';

export const allocationMethods = ['by-value', 'by-weight', 'by-cbm', 'by-units'] as const;
export const dutyBases = ['FOB', 'CIF'] as const;
type Cents = string | bigint | number;

export interface LandedCostSource {
  name: string;
  bytes: Uint8Array;
  sheetName?: string;
}

export interface LandedCostOptions {
  currency: string;
  sourceCurrency?: string;
  fxRate?: string;
  method: typeof allocationMethods[number];
  dutyBase: typeof dutyBases[number];
  freightCents: Cents;
  insuranceCents: Cents;
  handlingCents: Cents;
  otherChargesCents?: Cents;
  branding?: SignoffBrand;
}

export const sharedCharges = ['freightCents', 'insuranceCents', 'handlingCents', 'otherChargesCents'] as const;
type SharedCharge = typeof sharedCharges[number];
export type SharedAmounts = Record<SharedCharge, bigint>;

export interface LandedCostIssue {
  code: string;
  message: string;
  line?: number;
  lines?: number[];
  column?: string;
  sku?: string;
  value?: string;
}

export interface LandedCostRow extends SharedAmounts {
  line: number;
  sku: string;
  description: string;
  hsCode: string;
  quantity: bigint;
  sourceFobUnitCents: bigint;
  sourceFobCents: bigint;
  allocationWeight: bigint;
  fobCents: bigint;
  dutyRateBps: bigint;
  dutyBaseCents: bigint;
  dutyCents: bigint;
  landedExtendedCents: bigint;
  landedUnitRatio: { numeratorCents: bigint; denominator: bigint };
  landedUnitCost: string;
  landedUnitDisplay: string;
  unitRemainderCents: bigint;
  wholesaleUnitCost: string;
  upliftPercent: string | null;
}

export interface LandedCostTotals extends SharedAmounts {
  fobCents: bigint;
  dutyCents: bigint;
  landedExtendedCents: bigint;
  driftCents: bigint;
}

export type LandedCostProof = Record<SharedCharge | 'landedExtendedCents', {
  expected: bigint; allocated: bigint; drift: bigint;
}>;

export type LandedCostResult = { issues: LandedCostIssue[] } & (
  | { status: 'ready'; currency: string; rows: LandedCostRow[]; totals: LandedCostTotals; proof: LandedCostProof;
    files: { csv: string; html: string; audit: string } }
  | { status: 'blocked'; rows: []; totals: null; files: { audit: string; csv?: never; html?: never } }
);
