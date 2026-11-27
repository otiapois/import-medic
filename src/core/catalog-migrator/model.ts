import { guardSpreadsheetCell } from '../formula-guard';
import { amountGreaterThan, baselinePrice, readAmount, type Amount } from '../shopify-price-diff/prices';
import { readCsvTable } from '../shopify-price-diff/source';
import type { SourceRow } from '../shopify-price-diff/types';
import { isScientific } from '../xlsx';

export type CatalogPlatform = 'shopify' | 'woocommerce' | 'bigcommerce';
export type CatalogDialect = 'shopify' | 'woocommerce' | 'bigcommerce-legacy' | 'bigcommerce-modern';

export interface MigrationIssue {
  code: string;
  line: number | null;
  column: string | null;
  message: string;
  level: 'blocked' | 'disclosure';
}

export interface FieldMapping {
  source: string;
  target: string | null;
  notes: string;
}

export interface CatalogMigrationResult {
  sourcePlatform: CatalogPlatform;
  targetPlatform: CatalogPlatform;
  sourceDialect: CatalogDialect;
  targetDialect: CatalogDialect;
  sourceFilename: string;
  issues: MigrationIssue[];
  mapping: FieldMapping[];
  unmappedColumns: string[];
  summary: { sourceProducts: number; sourceVariants: number; targetProducts: number; targetVariants: number; variantParity: boolean };
  preview: { headers: string[]; rows: string[][] } | null;
  custody: { sourceSha256: string; targetSha256?: string; signOffSha256: string };
  artifacts: { targetCsv: Artifact | null; auditJson: Artifact; signOffHtml: Artifact };
}

interface Artifact { filename: string; bytes: Uint8Array }

export type State = '' | 'active' | 'draft' | 'archived' | 'private' | 'pending';
export type Visibility = '' | 'visible' | 'hidden' | 'catalog' | 'search';
export type Shipping = '' | 'physical' | 'digital';
export type StockMode = 'unknown' | 'none' | 'own' | 'parent';
export interface Stock { mode: StockMode; quantity: string }
export interface Weight { amount: string; unit: string; line: number }
export interface Option { name: string; value: string; type?: string; config?: string }

export interface Variant {
  line: number;
  sku: string;
  options: Option[];
  prices: Prices;
  stock: Stock;
  shipping: Shipping;
  weight?: Weight;
  title?: string;
  state?: State;
}

export interface Prices { regular: string; sale: string }
export interface Product {
  line: number;
  handle: string;
  url?: string;
  sku: string;
  title: string;
  state: State;
  visibility: Visibility;
  grouped: boolean;
  stock: Stock;
  shipping: Shipping;
  weight?: Weight;
  base?: Prices;
  variants: Variant[];
}

export const unknownStock: Stock = { mode: 'unknown', quantity: '' };
export const issue = (issues: MigrationIssue[], code: string, line: number | null, column: string | null,
  message: string, level: MigrationIssue['level'] = 'blocked') => {
  issues.push({ code, line, column, message, level });
};

export const identityKey = (value: string) => value.normalize('NFKC').toLowerCase();
export const validHandle = (value: string) => /^[\p{L}\p{N}-]+$/u.test(value) && /[\p{L}\p{N}]/u.test(value);
export const optionKey = (options: readonly Option[]) => JSON.stringify(options.map(option => identityKey(option.value)));
export const nativeText = (value: string) => value.trim() === value && value !== '' &&
  !/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(value);
const safeIdentity = (value: string) => nativeText(value) &&
  !/^[=+\-@]|^'[=+\-@]/.test(value) && guardSpreadsheetCell(value) === value;
export const stableSku = (value: string) => safeIdentity(value) && !isScientific(value);
export const wooStableText = (value: string) => !/[<>]| {2,}|%[0-9a-f]{2}/i.test(value);

export function plainAmount(value: string): Amount | null {
  return baselinePrice.test(value) ? readAmount(value) : null;
}

export function validPrices(regular: string, sale: string): boolean {
  const base = plainAmount(regular);
  if (!base) return false;
  if (sale === '') return true;
  const discounted = plainAmount(sale);
  return discounted !== null && amountGreaterThan(base, discounted);
}

export function exactAmount(units: bigint, scale: number): string {
  const digits = units.toString().padStart(scale + 1, '0');
  if (!scale) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return digits.slice(0, -scale) + (fraction === '' ? '' : '.' + fraction);
}

type Header = (header: string) => string;
export class CatalogSource {
  readonly headerLine: number | null;
  readonly headers: string[];
  readonly columns: Map<string, number>;
  readonly rows: SourceRow[];
  readonly issues: MigrationIssue[];
  readonly products: Product[] = [];
  readonly mappings = new Map<string, FieldMapping>();

  constructor(bytes: Uint8Array, filename: string, public dialect: CatalogDialect, canonical: Header) {
    const table = readCsvTable(bytes, filename, 'baseline', canonical, { retainEmptyRecords: true });
    this.headers = table.headers;
    this.headerLine = table.headerRow;
    this.columns = new Map(table.headers.map((header, index) => [canonical(header), index]));
    this.rows = table.rows.filter(row => row.cells.length === table.headers.length);
    this.issues = table.issues.map(problem => ({ code: problem.code, line: problem.row ?? null, column: problem.column ?? null,
      message: problem.message, level: 'blocked' }));
  }

  value(row: SourceRow, field: string): string {
    return row.cells[this.columns.get(field) ?? -1]?.value ?? '';
  }

  require(fields: readonly string[]): boolean {
    if (this.headers.length === 0) return false;
    const missing = fields.filter(field => !this.columns.has(field));
    for (const field of missing) this.add('missing-column', this.headerLine, field, 'This catalog needs the ' + field + ' column.');
    return missing.length === 0;
  }

  add(code: string, line: number | null, column: string | null, message: string, level: MigrationIssue['level'] = 'blocked'): void {
    const index = column === null ? undefined : this.columns.get(column);
    issue(this.issues, code, line, index === undefined ? column : this.headers[index], message, level);
  }

  map(field: string, target: string | null, notes = 'Carried with the target platform’s field conventions.'): void {
    const index = this.columns.get(field);
    if (index !== undefined) this.mappings.set(this.headers[index], { source: this.headers[index], target, notes });
  }

  money(row: SourceRow, baseColumn: string, secondaryColumn: string, compareAt = false, fallback?: Prices): Prices {
    const base = this.value(row, baseColumn);
    const secondary = this.value(row, secondaryColumn);
    if (base === '' && secondary === '' && fallback) return fallback;
    if (!plainAmount(base)) {
      this.add('invalid-price', row.line, baseColumn, 'Use a plain nonnegative decimal without a currency symbol.');
    }
    if (secondary !== '' && !plainAmount(secondary)) {
      this.add('invalid-price', row.line, secondaryColumn, 'Use a plain nonnegative decimal without a currency symbol.');
    }
    const prices = compareAt && secondary !== '' ? { regular: secondary, sale: base } : { regular: base, sale: secondary };
    if (plainAmount(base) && secondary !== '' && plainAmount(secondary) && !validPrices(prices.regular, prices.sale)) {
      this.add('inverted-price', row.line, secondaryColumn, 'The list or regular price must be strictly above the active sale price.');
    }
    return prices;
  }

  weight(row: SourceRow, column: string, unit: string): Weight | undefined {
    const amount = this.value(row, column);
    if (amount === '') return;
    if (!plainAmount(amount)) this.add('invalid-weight', row.line, column, 'Use a plain nonnegative decimal weight.');
    return { amount, unit, line: row.line };
  }

  count(row: SourceRow, column: string): string {
    const value = this.value(row, column);
    if (value && (!/^-?\d{1,16}(?![\s\S])/.test(value) || BigInt(value) > 9_007_199_254_740_991n || BigInt(value) < -9_007_199_254_740_991n)) {
      this.add('invalid-stock', row.line, column, 'Use an exact safe whole number for tracked stock.');
    }
    return value;
  }

  boolean(row: SourceRow, column: string): '' | 'true' | 'false' {
    const value = this.value(row, column).toLowerCase();
    if (value === '') return '';
    if (['true', 'yes', 'y', '1'].includes(value)) return 'true';
    if (['false', 'no', 'n', '0'].includes(value)) return 'false';
    this.add('invalid-boolean', row.line, column, 'Use a native true or false flag.');
    return '';
  }
}

export function validateCatalog(source: CatalogSource, columns: { sku: string; title: string; option: string; handle?: string }): void {
  const skus = new Map<string, number>();
  const handles = new Map<string, number>();
  const validateSku = (sku: string, line: number) => {
    if (!sku) return;
    if (!stableSku(sku)) source.add('unsafe-sku', line, columns.sku, 'This SKU could change meaning or be read as a spreadsheet formula.');
    const key = identityKey(sku);
    const first = skus.get(key);
    if (first !== undefined) source.add('duplicate-sku', line, columns.sku, 'This SKU collides with the SKU on line ' + first + '.');
    else skus.set(key, line);
  };
  if (!source.products.length && source.headers.length) source.add('missing-products', source.headerLine, null, 'No complete product rows were found.');
  for (const product of source.products) {
    if (product.title.trim() === '' || guardSpreadsheetCell(product.title) !== product.title) {
      source.add('unsafe-title', product.line, columns.title, 'A product needs a title that can be written without changing it or treating it as a formula.');
    }
    if (product.handle && columns.handle) {
      const key = identityKey(product.handle);
      const first = handles.get(key);
      if (first !== undefined) source.add('duplicate-handle', product.line, columns.handle, 'This handle collides with the handle on line ' + first + '.');
      else handles.set(key, product.line);
    }
    if (product.grouped) validateSku(product.sku, product.line);
    const first = product.variants[0];
    if (!first) {
      source.add('missing-variants', product.line, columns.option, 'The source declares variants but supplies no complete variant rows.');
      continue;
    }
    const names = JSON.stringify(first.options.map(option => [option.name, option.type ?? '']));
    const combinations = new Map<string, number>();
    for (const variant of product.variants) {
      validateSku(variant.sku, variant.line);
      if (product.grouped && (variant.options.length === 0 || JSON.stringify(variant.options.map(option => [option.name, option.type ?? ''])) !== names)) {
        source.add('inconsistent-options', variant.line, columns.option, 'Every variant must use the same named option dimensions and types.');
      }
      if (new Set(variant.options.map(option => identityKey(option.name))).size !== variant.options.length || variant.options.some(option =>
        !safeIdentity(option.name) || !safeIdentity(option.value))) {
        source.add('unsafe-option', variant.line, columns.option, 'Option names and values must be distinct, exact, nonempty text and safe spreadsheet cells.');
      }
      const key = optionKey(variant.options);
      const duplicate = combinations.get(key);
      if (duplicate !== undefined) source.add('duplicate-variant', variant.line, columns.option, 'This option combination collides with the variant on line ' + duplicate + '.');
      else combinations.set(key, variant.line);
    }
  }
}
