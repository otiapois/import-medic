import { guardSpreadsheetCell } from '../formula-guard';
import { baselinePrice, readAmount } from '../shopify-price-diff/prices';
import { isScientific } from '../xlsx';
import { auditBarcode } from './barcodes';
import { catalogReports, fingerprint, verifiedCatalog } from './output';
import { controlsInIdentifier, readCatalog, stripZeroWidths, zeroWidth, type AddIssue } from './source';
import type {
  CatalogHygieneIssue, CatalogHygieneOptions, CatalogHygieneResult, CatalogHygieneSource, CatalogLine,
} from './types';

export { validateGtin } from './gs1';
export type {
  CatalogHygieneArtifact, CatalogHygieneIssue, CatalogHygieneOptions, CatalogHygieneResult,
  CatalogHygieneSource, CatalogHygieneSummary,
} from './types';

interface Identity extends CatalogLine {
  before: string;
  after: string;
  column: string;
}

const skuKey = (value: string) => value.toLowerCase();
const trimSku = (value: string) => value.replace(/^\p{Zs}+|\p{Zs}+$/gu, '');
const referenceKey = (value: string) => skuKey(trimSku(value));

function retain<T>(groups: Map<string, T[]>, key: string, entry: T) {
  const list = groups.get(key);
  if (list) list.push(entry);
  else groups.set(key, [entry]);
}

export async function auditCatalogHygiene(sources: readonly CatalogHygieneSource[],
  options: CatalogHygieneOptions = {}): Promise<CatalogHygieneResult> {
  if (sources.length < 1 || sources.length > 2) throw new RangeError('Provide one or two native catalogs.');
  const issues: CatalogHygieneIssue[] = [];
  const rawSkus = new Map<string, Identity[]>();
  const caseSkus = new Map<string, Identity[]>();
  const candidateSkus = new Map<string, Identity[]>();
  const gtins = new Map<string, (Identity & { sku: string })[]>();
  const invalidBarcodes = new Set<string>();
  const duplicateSkus = new Set<Identity>();
  const addForSource = (sourceIndex: number): AddIssue => (code, message, details = {}) => {
    issues.push({ code, message, sourceIndex, level: 'blocked', line: null, column: null, value: null, ...details });
  };
  const parsed = sources.map((source, index) => {
    const sourceIndex = index + 1;
    const add = addForSource(sourceIndex);
    const table = readCatalog(source, sourceIndex, add);
    const changes = new Map<number, Map<number, string>>();
    const skuChanges: Identity[] = [];
    for (const { record, priceRequired, scanIdentifiers } of table.rows) {
      if (!scanIdentifiers) continue;
      const { line, cells } = record;
      const { headers, skuIndex, barcodeIndex, priceIndex } = table;
      const updated = new Map<number, string>();
      const sku = cells[skuIndex] ?? '';
      const barcode = cells[barcodeIndex] ?? '';
      const checkIdentity = (value: string, after: string, column: string): boolean => {
        const details = { line, column, value };
        if (controlsInIdentifier(value) || zeroWidth.test(after)) {
          add('embedded-control', 'Review embedded control characters. Only the allowlisted zero-width characters can be removed.', details);
          return false;
        }
        if (guardSpreadsheetCell(value) !== value || guardSpreadsheetCell(after) !== after) {
          add('spreadsheet-formula', 'The original or proposed identifier can be interpreted as a spreadsheet formula.', details);
          return false;
        }
        return true;
      };
      const widthSku = options.stripZeroWidth ? stripZeroWidths(sku) : sku;
      const afterSku = options.trimSkus ? trimSku(widthSku) : widthSku;
      const projectedSku = trimSku(stripZeroWidths(sku));
      const skuDetails = { line, column: headers[skuIndex], value: sku };
      if (sku !== '') {
        const identity = { sourceIndex, line, before: sku, after: afterSku, column: headers[skuIndex] };
        retain(rawSkus, sku, identity);
        retain(caseSkus, skuKey(sku), identity);
        if (projectedSku) retain(candidateSkus, skuKey(projectedSku), identity);
        if (isScientific(stripZeroWidths(sku))) add('scientific-sku', 'This SKU resembles spreadsheet scientific notation. Recover the exact original SKU.', skuDetails);
        else if (trimSku(afterSku) === '') add('empty-sku', 'A supplied SKU cannot be empty or consist only of outer spaces.', skuDetails);
        else if (checkIdentity(sku, afterSku, headers[skuIndex])) {
          if (widthSku !== sku) add('strip-zero-width', 'Removed allowlisted zero-width characters from the SKU.',
            { ...skuDetails, after: afterSku, level: 'fixed' });
          if (afterSku !== widthSku) add('trim-sku', 'Trimmed outer spaces from the SKU.', { ...skuDetails, after: afterSku, level: 'fixed' });
          else if (trimSku(widthSku) !== widthSku) add('outer-sku-whitespace', 'The SKU has outer spaces. Enable SKU trimming to propose their removal.',
            { ...skuDetails, level: 'warning' });
          if (afterSku !== sku) {
            updated.set(skuIndex, afterSku);
            skuChanges.push(identity);
          }
        }
      }
      if (barcode !== '') {
        const column = headers[barcodeIndex];
        const inspected = auditBarcode(barcode, table.barcodeKind, options.stripZeroWidth === true, (code, message, details) => {
          if (code !== 'barcode-outside-gs1-scope') invalidBarcodes.add(sourceIndex + ':' + line);
          add(code, message, { line, column, value: barcode, ...details });
        });
        if (checkIdentity(barcode, inspected.after, column)) {
          if (inspected.after !== barcode) {
            updated.set(barcodeIndex, inspected.after);
            add('strip-zero-width', 'Removed allowlisted zero-width characters from the barcode.',
              { line, column, value: barcode, after: inspected.after, level: 'fixed' });
          }
          if (projectedSku) for (const gtin of new Set(inspected.gtins.map(value => value.padStart(14, '0')))) {
            retain(gtins, gtin, { sourceIndex, line, before: barcode, after: inspected.after, column, sku: skuKey(projectedSku) });
          }
        }
      }
      const price = cells[priceIndex] ?? '';
      if (priceIndex >= 0 && (priceRequired || price !== '')) {
        const negative = price.startsWith('-') && baselinePrice.test(price.slice(1));
        const amount = negative || baselinePrice.test(price) ? readAmount(price) : null;
        const details = { line, column: headers[priceIndex], value: price };
        if (!amount) add('invalid-retail-price', 'Use the original retail price as a plain decimal amount.', details);
        else if (amount.units < 0n) add('negative-retail-price', 'The retail price is negative. Confirm the intended amount.', details);
        else if (amount.units === 0n) add('zero-retail-price', 'The retail price is zero. Confirm the intended amount.', details);
      }
      if (updated.size) changes.set(line, updated);
    }
    return { source, sourceIndex, table, changes, skuChanges };
  });

  const reportDuplicates = (entries: Identity[], code: string, message: string, sku: boolean) => {
    const [first, ...rest] = entries;
    if (sku) for (const entry of entries) duplicateSkus.add(entry);
    addForSource(first.sourceIndex)(code, message, { line: first.line, column: first.column, value: first.before,
      related: rest.map(({ sourceIndex, line }) => ({ sourceIndex, line })) });
  };
  for (const group of rawSkus.values()) if (group.length > 1) {
    reportDuplicates(group, 'duplicate-sku-exact', 'The exact SKU is used on multiple catalog rows.', true);
  }
  for (const group of caseSkus.values()) if (new Set(group.map(({ before }) => before)).size > 1) {
    reportDuplicates(group, 'duplicate-sku-case', 'The SKUs conflict when compared without case.', true);
  }
  for (const group of candidateSkus.values()) if (new Set(group.map(({ before }) => skuKey(before))).size > 1) {
    reportDuplicates(group, 'duplicate-sku-cleanup', 'These SKUs conflict after trimming outer spaces and removing allowlisted zero-width characters.', true);
  }
  for (const [gtin, group] of gtins) if (new Set(group.map(({ sku }) => sku)).size > 1) {
    reportDuplicates(group, 'duplicate-gtin',
      'The same valid GS1 identifier is assigned to different SKUs. The 14-digit comparison value is ' + gtin + '.', false);
  }
  const referenceLinks = new Map<string, CatalogLine[]>();
  for (const { source, sourceIndex, table } of parsed) {
    for (const { value, line } of table.references) {
      const key = source.platform + ':' + referenceKey(value);
      const last = referenceLinks.get(key)?.at(-1);
      if (last?.line !== line || last.sourceIndex !== sourceIndex) retain(referenceLinks, key, { sourceIndex, line });
    }
  }
  for (const { source, sourceIndex, skuChanges } of parsed) {
    for (const identity of skuChanges) {
      // Existing SKU conflicts already prevent an ambiguous identity change and carry the whole group.
      if (duplicateSkus.has(identity)) continue;
      const { before, after, line, column } = identity;
      const keys = new Set([referenceKey(before), referenceKey(after)]);
      const related = [...keys].flatMap(key => referenceLinks.get(source.platform + ':' + key) ?? []);
      if (related.length) addForSource(sourceIndex)('referenced-sku-cleanup',
        'This SKU is referenced by another native record. Preserve its relationships by reviewing the change in the source system.',
        { line, column, value: before, after, related });
    }
  }

  const catalogs: CatalogHygieneResult['artifacts']['catalogs'] = [];
  if (!issues.some(({ level }) => level === 'blocked')) {
    for (const { source, sourceIndex, table, changes } of parsed) {
      const verified = verifiedCatalog(source, table, changes, sourceIndex);
      if (verified) catalogs.push(verified);
      else addForSource(sourceIndex)('catalog-roundtrip-failed', 'The cleaned CSV could not prove the original matrix and intended changes.');
    }
  }
  const blockingIssues = issues.filter(({ level }) => level === 'blocked').length;
  const status = blockingIssues ? 'HOLD' : 'READY';
  if (status === 'HOLD') {
    catalogs.length = 0;
    for (const issue of issues) if (issue.level === 'fixed') {
      issue.level = 'warning';
      issue.message = issue.code === 'trim-sku' ? 'SKU trimming is proposed while the catalog is held.' :
        'Zero-width removal is proposed while the catalog is held.';
    }
  }
  const sourceResults = await Promise.all(parsed.map(async ({ source, sourceIndex, table }) => ({
    ...await fingerprint(source), sourceIndex, platform: source.platform, rows: table.scannedRows,
  })));
  const summary = {
    scannedRows: sourceResults.reduce((sum, source) => sum + source.rows, 0),
    invalidBarcodes: invalidBarcodes.size,
    duplicateSkus: duplicateSkus.size,
    safeTrimFixes: issues.filter(({ level, code }) => level === 'fixed' && code === 'trim-sku').length,
    safeZeroWidthFixes: issues.filter(({ level, code }) => level === 'fixed' && code === 'strip-zero-width').length,
    blockingIssues,
  };
  return { status, summary, sources: sourceResults, issues,
    artifacts: await catalogReports(status, summary, sourceResults, issues, catalogs, options) };
}
