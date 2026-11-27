import { sha256 } from '../audit/custody';
import { bigCommerceProductTracking, bigCommerceValueIssues, readBigCommerceStock } from '../bigcommerce-price-diff/safety';
import {
  bigCommerceFileLimit, bigCommerceIdentityHeaders, bigCommerceKey, bigCommerceSkuHeader, bigCommerceStockHeader, bigIdHeader, bigPriceHeader, bigSaleHeader,
  bigTypeHeader, parseBigCommerceBaseline,
} from '../bigcommerce-price-diff/source';
import { shopifyNativeHeaders } from '../profiles/shopify-products';
import { marketValueIssues, type ShopifyMarket } from '../shopify-price-diff/markets';
import { amountDelta, amountGreaterThan, readAmount } from '../shopify-price-diff/prices';
import {
  baselinePrice, canonicalShopifyHeader, compareAtHeader, inventoryHeader, optionNames, optionValues,
  originalQuantity, parseBaseline, priceHeader, readCsvTable, shopifyIdentityHeaders, skuHeader, variantKey,
} from '../shopify-price-diff/source';
import { cellValue } from '../shopify-price-diff/types';
import type { Baseline, DiffIssue, SourceRow, StorePlatform, Variant } from '../shopify-price-diff/types';
import { isScientific } from '../xlsx';
import {
  canonicalWooImportHeader, parseWooCommerceBaseline, readWooStock, wooIdentityHeaders,
  wooRegularHeader, wooSaleHeader, wooStockHeader, wooWritable,
} from '../woocommerce-price-diff/source';

export interface ImportInspectionIssue {
  source: 'baseline' | 'candidate' | 'update';
  code: string;
  message: string;
  line?: number;
  column?: string;
}

export interface ImportDiffRow {
  sku: string;
  product: string;
  baselineLine: number;
  candidateLine: number;
  changes: { column: string; before: string | null; after: string; delta: string | null }[];
}

export interface ImportInspection {
  market?: ShopifyMarket;
  verdict: 'PASS' | 'FAIL_UNSAFE';
  baselineSha256: string;
  candidateSha256: string;
  matchedRows: number;
  changedRows: number;
  changedSkus: number;
  unchangedSiblingSkus: number;
  nonTargetMutations: number;
  brokenGroups: number;
  issues: ImportInspectionIssue[];
  rows: ImportDiffRow[];
  rollback: {
    scope: 'candidate-vs-baseline' | 'paired-update';
    residualDiffs: number | null;
    restored: boolean;
    pairedUpdateSha256?: string;
  };
}

type ReportIssue = (code: string, message: string, line?: number, column?: string) => void;

const shopRequired = ['Handle', 'Title', optionNames[0], optionValues[0], skuHeader];
const baselineGroupIssues = new Set([
  'noncontiguous-handle', 'missing-primary-variant', 'missing-title', 'conflicting-title', 'invalid-handle',
  'invalid-variant-options', 'duplicate-variant-key', 'invalid-woo-parent', 'unexpected-woo-parent',
  'invalid-bigcommerce-group', 'invalid-bigcommerce-option-name', 'invalid-bigcommerce-type', 'duplicate-bigcommerce-id',
]);
const keepEmptyRecords = { retainEmptyRecords: true };

function issueFromSource(source: ImportInspectionIssue['source'], entry: DiffIssue): ImportInspectionIssue {
  const message = entry.code.startsWith('duplicate-') && entry.rows.length > 40
    ? `This identity occurs on ${entry.rows.length} source rows. Resolve every duplicate before importing.` : entry.message;
  return { source, code: entry.code, message,
    ...(entry.row === null ? {} : { line: entry.row }), ...(entry.column === null ? {} : { column: entry.column }) };
}

function catalogIndex(baseline: Baseline) {
  const woo = baseline.platform === 'woocommerce';
  const key = (variant: Variant) => variant.bigcommerce ? bigCommerceKey(variant.bigcommerce.type, variant.bigcommerce.id) :
    woo ? variant.handle : variantKey(variant.handle, variant.options);
  const variants = new Map(baseline.variants.map((variant) => [key(variant), variant]));
  const bySku = new Map(baseline.variants.filter(({ sku }) => sku !== '').map((variant) => [variant.sku, variant]));
  const groupOf = (variant: Variant) => {
    if (variant.bigcommerce) return variant.bigcommerce.productId;
    const parent = variant.woocommerce?.parent;
    if (!parent) return variant.handle;
    return parent.startsWith('id:') ? parent.slice(3) : bySku.get(parent)?.handle ?? parent;
  };
  const groups = new Map<string, Variant[]>();
  for (const variant of baseline.variants) {
    const group = groupOf(variant);
    const members = groups.get(group) ?? [];
    members.push(variant);
    groups.set(group, members);
  }
  return { variants, bySku, groupOf, groups };
}

function stockValue(raw: string, woo: boolean): bigint | null {
  if (woo) return readWooStock(raw);
  return originalQuantity.test(raw) ? BigInt(raw) : null;
}

function checkTargetValues(woo: boolean, baseline: Baseline, variant: Variant, incoming: Map<string, string>,
  report: ReportIssue, line: number): void {
  const [price, sale, stock] = woo ? [wooRegularHeader, wooSaleHeader, wooStockHeader] : [priceHeader, compareAtHeader, inventoryHeader];
  const oldPrice = readAmount(variant.price);
  const oldSale = variant.compareAtPrice ? readAmount(variant.compareAtPrice) : null;
  const nextPriceRaw = incoming.get(price) ?? variant.price;
  const nextSaleRaw = incoming.get(sale) ?? variant.compareAtPrice;
  const nextPrice = baselinePrice.test(nextPriceRaw) ? readAmount(nextPriceRaw) : null;
  const nextSale = nextSaleRaw && baselinePrice.test(nextSaleRaw) ? readAmount(nextSaleRaw) : null;
  if (incoming.has(price) && !nextPrice) report('invalid-target-value', 'Use a plain nonnegative decimal price.', line, price);
  if (incoming.has(sale) && nextSaleRaw && !nextSale) report('invalid-target-value', 'Use a plain nonnegative decimal or the intended blank cell.', line, sale);

  const nextStockRaw = incoming.get(stock);
  if (nextStockRaw !== undefined) {
    const oldStock = variant.inventoryQty;
    const before = stockValue(oldStock ?? '', woo);
    const after = stockValue(nextStockRaw, woo);
    if (woo && (before === null || after === null || (after < 0n && nextStockRaw !== oldStock))) {
      report('woo-stock-not-managed', 'Stock needs managed whole quantities. Keep the exact original negative value when restoring it.', line, stock);
    } else if (!woo && ((oldStock !== '' && before === null) ||
      (nextStockRaw !== oldStock && (after === null || after < 0n)))) {
      report('invalid-target-value', 'Use a nonnegative whole quantity or the exact original inventory value.', line, stock);
    }
  }

  if (woo && (incoming.has(price) || incoming.has(sale))) {
    if (!oldPrice || !nextPrice) {
      report('woo-regular-price-required', 'Keep a known regular price to verify the effective WooCommerce sale price.', line, price);
    } else if (!baseline.columns.has(sale) && amountGreaterThan(oldPrice, nextPrice)) {
      report('woo-sale-price-required', 'Re-export with Sale price before reducing the regular price. WooCommerce can clear an unseen sale price.', line, sale);
    } else if ((oldSale && !amountGreaterThan(oldPrice, oldSale)) || (nextSale && !amountGreaterThan(nextPrice, nextSale))) {
      report('sale-price-not-below-regular-price', 'The original and effective sale prices must be below their regular prices.', line, sale);
    }
  } else if (!woo && incoming.has(sale) && nextPrice && nextSale &&
    (nextPriceRaw !== variant.price || nextSaleRaw !== variant.compareAtPrice) && !amountGreaterThan(nextSale, nextPrice)) {
    report('compare-at-not-above-price', 'The changed compare-at price must be above the effective variant price.', line, sale);
  }
}

function numericDelta(column: string, before: string | null, after: string, woo: boolean, bigStock?: string): string | null {
  if (before == null || before === '' || after === '') return null;
  if (column === inventoryHeader || column === wooStockHeader || column === bigStock) {
    const a = column === bigStock ? readBigCommerceStock(before) : stockValue(before, woo);
    const b = column === bigStock ? readBigCommerceStock(after) : stockValue(after, woo);
    return a === null || b === null ? null : (b - a).toString();
  }
  const a = baselinePrice.test(before) ? readAmount(before) : null;
  const b = baselinePrice.test(after) ? readAmount(after) : null;
  return a && b ? amountDelta(a, b) : null;
}

function inspectCandidate(source: 'candidate' | 'update', bytes: Uint8Array, baseline: Baseline, index: ReturnType<typeof catalogIndex>,
  issues: ImportInspectionIssue[], brokenGroups: Set<string>) {
  const woo = baseline.platform === 'woocommerce';
  const bigcommerce = baseline.platform === 'bigcommerce';
  const canon = bigcommerce ? (header: string) => header : woo ? canonicalWooImportHeader : canonicalShopifyHeader;
  const skuColumn = bigcommerce ? bigCommerceSkuHeader(baseline) : woo ? 'SKU' : skuHeader;
  const productColumn = bigcommerce ? bigIdHeader : woo ? 'ID' : 'Handle';
  const identity = bigcommerce ? bigCommerceIdentityHeaders(baseline) : woo ? wooIdentityHeaders : shopifyIdentityHeaders;
  const requiredIdentity = woo || bigcommerce ? identity : shopRequired;
  const table = readCsvTable(bytes, source, 'baseline', canon, { ...keepEmptyRecords, requireUtf8: true });
  const columns = new Map(table.headers.map((header, index) => [canon(header), index]));
  const rawHeaders = new Set(table.headers);
  const selectedMarkets = baseline.markets?.filter(({ priceHeader, compareAtHeader }) =>
    rawHeaders.has(priceHeader) || compareAtHeader !== undefined && rawHeaders.has(compareAtHeader)) ?? [];
  const market = selectedMarkets[0];
  const bigStock = bigcommerce ? bigCommerceStockHeader(baseline) : undefined;
  const targets = new Set(bigcommerce ? [bigPriceHeader, bigSaleHeader, ...(bigStock ? [bigStock] : [])] :
    woo ? [wooRegularHeader, wooSaleHeader, wooStockHeader] : market ? [market.priceHeader, ...(market.compareAtHeader ? [market.compareAtHeader] : [])] :
      [priceHeader, compareAtHeader, inventoryHeader]);
  const allowed = new Set([...identity, ...targets]);
  const cell = (row: SourceRow, column: string) => cellValue(row, columns.get(column)) ?? '';
  const diffs: ImportDiffRow[] = [];
  const matched = new Set<number>();
  const sparseWrites = new Map<number, ReadonlySet<string>>();
  const changedGroups = new Set<string>();
  const changedSkus = new Set<string>();
  const report: ReportIssue = (code, message, line, column) => {
    issues.push({ source, code, message, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) });
  };
  for (const entry of table.issues) issues.push(issueFromSource(source, entry));
  const headerLine = table.headerRow ?? 1;
  const includedTargets = [...columns.keys()].filter((column) => targets.has(column));
  const writeColumns = new Set(includedTargets);
  if (selectedMarkets.length > 1) report('mixed-shopify-market', 'Include columns for only one exact Shopify market.', headerLine);
  if (market && !rawHeaders.has(market.priceHeader)) {
    report('missing-market-price', 'Include the selected market price together with its compare-at column.', headerLine, market.priceHeader);
  }
  if (bigcommerce && bytes.length > bigCommerceFileLimit) report('bigcommerce-file-limit', 'The legacy BigCommerce import exceeds 20 MB.', headerLine);
  let nonTargetMutations = 0;
  for (const header of table.headers) {
    if (allowed.has(canon(header)) && (woo || bigcommerce || shopifyNativeHeaders.has(header) || market && targets.has(header))) continue;
    nonTargetMutations++;
    report('forbidden-column', 'Remove this column. Including it can overwrite data outside price and inventory.', headerLine, header);
  }
  const output = () => {
    let unchangedSiblingSkus = 0;
    for (const group of changedGroups) {
      for (const { sku, source, woocommerce } of index.groups.get(group) ?? []) {
        // WooCommerce can preserve existing siblings by omitting them.
        const sibling = woocommerce ? wooWritable(woocommerce.type) : matched.has(source.line);
        if (sibling && sku && !changedSkus.has(sku)) unchangedSiblingSkus++;
      }
    }
    return { rows: diffs, matchedRows: matched.size, changedSkus: changedSkus.size, nonTargetMutations, unchangedSiblingSkus, market,
      writes: (line: number, column: string) => bigcommerce ? sparseWrites.get(line)?.has(column) : matched.has(line) && writeColumns.has(column) };
  };
  if (!table.headers.length) return output();
  const missingIdentity = requiredIdentity.filter((column) => !columns.has(column));
  for (const column of missingIdentity) report('missing-column', 'Keep this original identity column in the native import.', headerLine, column);
  if (!woo && !bigcommerce) {
    for (const [position, name] of optionNames.entries()) {
      const value = optionValues[position];
      if (columns.has(name) !== columns.has(value)) {
        report('missing-option-column', 'Keep both the option name and option value columns for this dimension.', headerLine, columns.has(name) ? value : name);
      }
    }
  }
  if (!includedTargets.length) report('missing-target-column', 'Include at least one supported price or inventory column.', headerLine);
  for (const column of includedTargets) {
    if (!baseline.columns.has(column)) report('missing-baseline-target', 'The baseline must include the original value of every written column.', headerLine, column);
  }
  if (!table.rows.length) report('missing-candidate-rows', 'Include at least one existing product or variant.');
  if (baseline.issues.length || missingIdentity.length || table.issues.some(({ code }) => code === 'duplicate-header')) return output();

  const malformed = new Set(table.issues.filter(({ code }) => code === 'invalid-csv' || code === 'row-width').map(({ row }) => row));
  const tracking = bigcommerce ? bigCommerceProductTracking(baseline) : undefined;
  const seenKeys = new Set<string>();
  const seenSkus = new Set<string>();
  const groups = new Map<string, { rows: Variant[]; firstLine: number; split: boolean }>();
  let previousProduct: string | undefined;
  let previousBaselineLine = 0;
  for (const row of table.rows) {
    const { line } = row;
    const product = cell(row, productColumn);
    const sku = cell(row, skuColumn);
    const key = bigcommerce ? bigCommerceKey(cell(row, bigTypeHeader), product) :
      woo ? product : variantKey(product, optionValues.map((column) => cell(row, column)));
    const variant = index.variants.get(key);
    const associatedVariant = variant ?? index.bySku.get(sku);
    const groupKey = associatedVariant ? index.groupOf(associatedVariant) : product;
    const group = groups.get(groupKey) ?? { rows: [], firstLine: line, split: false };
    if (!woo) {
      if (previousProduct !== groupKey && groups.has(groupKey)) group.split = true;
      groups.set(groupKey, group);
      previousProduct = groupKey;
    }
    if (malformed.has(line)) {
      if (product !== '') brokenGroups.add(groupKey);
      continue;
    }
    const skuKey = woo || bigcommerce ? sku.toLowerCase() : sku;
    if (skuKey && seenSkus.has(skuKey)) {
      report('duplicate-sku', 'Use each exact existing SKU only once in an import.', line, skuColumn);
      brokenGroups.add(groupKey);
    }
    if (skuKey) seenSkus.add(skuKey);
    if (isScientific(sku)) report('scientific-sku', 'Use the original text SKU without scientific notation.', line, skuColumn);
    if (seenKeys.has(key)) {
      report(bigcommerce ? 'duplicate-bigcommerce-id' : woo ? 'duplicate-woo-id' : 'duplicate-variant-key', 'This existing identity occurs on multiple candidate rows.', line, productColumn);
      brokenGroups.add(groupKey);
      continue;
    }
    seenKeys.add(key);
    if (!variant) {
      report(bigcommerce ? 'unknown-bigcommerce-id' : woo ? 'unknown-woo-id' : 'unknown-variant', 'No unchanged product identity and variant options match this row in the baseline.', line, productColumn);
      if (associatedVariant) nonTargetMutations++;
      brokenGroups.add(groupKey);
      continue;
    }
    if (!woo) group.rows.push(variant);
    if (bigcommerce && variant.source.line <= previousBaselineLine) {
      report('reordered-bigcommerce-rows', 'Keep selected BigCommerce rows in their original baseline order.', line, bigIdHeader);
      brokenGroups.add(groupKey);
    }
    previousBaselineLine = variant.source.line;
    if (woo && (!wooWritable(variant.woocommerce!.type) || !variant.sku)) {
      report('unsupported-woo-update-type', 'Import only existing simple products or variations with an exact SKU.', line, 'Type');
      brokenGroups.add(groupKey);
      continue;
    }
    let exact = true;
    for (const column of identity) {
      const before = cellValue(variant.source, baseline.columns.get(column)) ?? '';
      const after = cell(row, column);
      if (before === after) continue;
      exact = false;
      nonTargetMutations++;
      brokenGroups.add(groupKey);
      const leadingZero = column === skuColumn && /^0[0-9]+$/.test(before) && /^\d+$/.test(after) &&
        before.replace(/^0+(?=\d)/, '') === after.replace(/^0+(?=\d)/, '') && after.length < before.length;
      report(leadingZero ? 'leading-zero-loss' : 'identity-mismatch', leadingZero
        ? 'Restore the exact SKU, including its leading zeros.'
        : 'Keep this original identity cell exactly as exported, including any blank continuation cells.', line, column);
    }
    if (!exact) continue;
    matched.add(variant.source.line);
    const incoming = new Map(includedTargets.map((column) => [column, cell(row, column)]));
    if (bigcommerce) {
      for (const [column, value] of incoming) if (value === '') incoming.delete(column);
      const unsafe = bigCommerceValueIssues(baseline, variant, incoming, tracking!);
      for (const entry of unsafe) {
        report(entry.code, entry.message, line, entry.column ?? undefined);
        if (entry.code === 'bigcommerce-read-only-price' || entry.code === 'bigcommerce-grouped-price') nonTargetMutations++;
      }
      sparseWrites.set(variant.source.line, new Set(incoming.keys()));
    } else if (market) {
      const oldPrice = cellValue(variant.source, baseline.columns.get(market.priceHeader)) ?? '';
      const oldCompare = market.compareAtHeader ? cellValue(variant.source, baseline.columns.get(market.compareAtHeader)) : null;
      const nextPrice = incoming.get(market.priceHeader) ?? oldPrice;
      const nextCompare = market.compareAtHeader ? incoming.get(market.compareAtHeader) ?? oldCompare : null;
      for (const entry of marketValueIssues(market, oldPrice, oldCompare, nextPrice, nextCompare, line)) {
        report(entry.code, entry.message, line, entry.column ?? undefined);
      }
    } else {
      checkTargetValues(woo, baseline, variant, incoming, report, line);
    }
    const changes = [...incoming].flatMap(([column, after]) => {
      const before = cellValue(variant.source, baseline.columns.get(column));
      return before === after ? [] : [{ column, before, after, delta: numericDelta(column, before, after, woo, bigStock) }];
    });
    if (!changes.length) continue;
    changedGroups.add(groupKey);
    if (sku) changedSkus.add(sku);
    diffs.push({ sku, product, baselineLine: variant.source.line, candidateLine: line, changes });
  }

  for (const [handle, { rows, firstLine, split }] of groups) {
    const original = index.groups.get(handle);
    if (!original) continue;
    if (split || original.length !== rows.length || original.some((variant, offset) => variant !== rows[offset])) {
      report(bigcommerce ? 'broken-bigcommerce-group' : 'broken-shopify-group', bigcommerce ?
        'Keep the original Product and every SKU row together and in original order.' :
        'Keep every original variant for this handle together and in its original order.', firstLine, productColumn);
      brokenGroups.add(handle);
    }
    const linked = original.find(({ linkedOption }) => linkedOption);
    if (linked) {
      issues.push({ source: 'baseline', code: 'linked-shopify-options', message: 'A touched product has linked options that require a different import workflow.',
        line: linked.source.line, column: 'Handle' });
      brokenGroups.add(handle);
    }
  }
  return output();
}

export async function inspectImport(
  platform: StorePlatform, baselineCsvBytes: Uint8Array, candidateCsvBytes: Uint8Array, pairedUpdateCsvBytes?: Uint8Array,
): Promise<ImportInspection> {
  // Start hashing and inspect the same views before yielding to the caller.
  const fingerprints = Promise.all([
    sha256(baselineCsvBytes), sha256(candidateCsvBytes), pairedUpdateCsvBytes && sha256(pairedUpdateCsvBytes),
  ]);
  const baseline = platform === 'bigcommerce' ? parseBigCommerceBaseline(baselineCsvBytes, undefined, keepEmptyRecords) : platform === 'woocommerce'
    ? parseWooCommerceBaseline(baselineCsvBytes, undefined, keepEmptyRecords)
    : parseBaseline(baselineCsvBytes, undefined, keepEmptyRecords);
  const index = catalogIndex(baseline);
  const issues = baseline.issues.map((entry) => issueFromSource('baseline', entry));
  const brokenGroups = new Set<string>();
  if (baseline.issues.length) {
    const variantsByLine = new Map(baseline.variants.map((variant) => [variant.source.line, variant]));
    for (const entry of baseline.issues) {
      if (!baselineGroupIssues.has(entry.code)) continue;
      const variant = entry.row === null ? undefined : variantsByLine.get(entry.row);
      brokenGroups.add(variant ? index.groupOf(variant) : entry.value ?? String(entry.row));
    }
  }
  const candidate = inspectCandidate('candidate', candidateCsvBytes, baseline, index, issues, brokenGroups);
  const update = pairedUpdateCsvBytes && inspectCandidate('update', pairedUpdateCsvBytes, baseline, index, issues, brokenGroups);
  if (update && candidate.market?.priceHeader !== update.market?.priceHeader) {
    issues.push({ source: 'candidate', code: 'rollback-scope-mismatch', message: 'The rollback and paired update must target the same Shopify price list.' });
  }
  let residualDiffs: number | null = null;
  if (!issues.length) {
    if (update) {
      // All omitted cells stay in the baseline. Each candidate write overrides
      // the update at the same baseline coordinate, including an exact restore.
      const residuals = new Map<string, { baselineLine: number; column: string; candidateLine?: number }>();
      for (const { baselineLine, changes } of update.rows) {
        for (const { column } of changes) residuals.set(`${baselineLine}:${column}`, { baselineLine, column });
      }
      for (const { baselineLine, candidateLine, changes } of candidate.rows) {
        for (const { column } of changes) residuals.set(`${baselineLine}:${column}`, { baselineLine, column, candidateLine });
      }
      // Matching baseline cells are deliberately absent from the diff rows.
      // The included target coordinates record exactly which ones the candidate writes.
      for (const [key, { baselineLine, column, candidateLine }] of residuals) {
        if (candidateLine === undefined && candidate.writes(baselineLine, column)) {
          residuals.delete(key);
          continue;
        }
        issues.push({ source: 'candidate', code: 'rollback-residual',
          message: `This cell on baseline line ${baselineLine} would remain different after importing the rollback.`,
          ...(candidateLine === undefined ? {} : { line: candidateLine }), column });
      }
      residualDiffs = residuals.size;
    } else {
      residualDiffs = candidate.rows.reduce((sum, row) => sum + row.changes.length, 0);
    }
  }
  const [baselineSha256, candidateSha256, pairedUpdateSha256] = await fingerprints;
  const { rows, matchedRows, changedSkus, unchangedSiblingSkus, nonTargetMutations } = candidate;
  return {
    verdict: issues.length ? 'FAIL_UNSAFE' : 'PASS', baselineSha256, candidateSha256, matchedRows, changedRows: rows.length, changedSkus,
    unchangedSiblingSkus, nonTargetMutations: nonTargetMutations + (update?.nonTargetMutations ?? 0), brokenGroups: brokenGroups.size, issues, rows,
    ...(candidate.market ? { market: candidate.market } : {}),
    rollback: { scope: update ? 'paired-update' : 'candidate-vs-baseline', residualDiffs, restored: residualDiffs === 0,
      ...(pairedUpdateSha256 === undefined ? {} : { pairedUpdateSha256 }) },
  };
}
