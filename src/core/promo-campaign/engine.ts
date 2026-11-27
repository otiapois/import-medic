import { meanPercent } from '../analytics/catalog-impact';
import { sha256 } from '../audit/custody';
import { bigCommerceProductTracking, bigCommerceValueIssues } from '../bigcommerce-price-diff/safety';
import { bigCommerceIdentityHeaders, bigPriceHeader, bigSaleHeader, parseBigCommerceBaseline } from '../bigcommerce-price-diff/source';
import { mappingLabel } from '../shopify-price-diff/mapping';
import { verifiedExports } from '../shopify-price-diff/output';
import { preparePricing, roundRetail } from '../shopify-price-diff/pricing-rules';
import { amountDelta, amountGreaterThan, baselinePrice, priceMovement, readAmount, type Amount } from '../shopify-price-diff/prices';
import { compareAtHeader, parseBaseline, priceHeader, shopifyIdentityHeaders } from '../shopify-price-diff/source';
import { cellValue, type Baseline, type DiffIssue, type StorePlatform, type Variant } from '../shopify-price-diff/types';
import { inspectImport } from '../verify-import/inspector';
import { parseWooCommerceBaseline, wooIdentityHeaders, wooRegularHeader, wooSaleHeader, wooWritable } from '../woocommerce-price-diff/source';
import { campaignCosts } from './costs';
import { promoSignoff } from './signoff';
import type { PromoCampaign, PromoCampaignCustody, PromoCampaignIssue, PromoCampaignOptions, PromoCampaignRow, PromoCampaignSummary } from './types';

export type { PromoCampaign, PromoCampaignCustody, PromoCampaignIssue, PromoCampaignOptions, PromoCampaignRow, PromoCampaignSummary } from './types';

const plainAmount = (value: string | null) => value !== null && baselinePrice.test(value) ? readAmount(value) : null;
const roundings = new Set(['none', 'ending-99', 'ending-95', 'nearest-whole']);

function hold(code: string, message: string, line?: number, column?: string): PromoCampaignIssue {
  return { code, message, severity: 'hold', source: 'campaign', ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
}

function sourceIssue(entry: DiffIssue, source: PromoCampaignIssue['source']): PromoCampaignIssue {
  return { ...hold(entry.code, entry.message, entry.row ?? undefined, entry.column ?? undefined), source };
}

function prepareDiscount(rule: PromoCampaignOptions['rule'], issues: PromoCampaignIssue[]) {
  const floor = plainAmount(rule.minimumRetail);
  const amount = plainAmount(rule.amount);
  if (!floor || floor.units <= 0n) issues.push(hold('invalid-minimum-retail', 'Enter a positive minimum retail price in store currency.'));
  if (!roundings.has(rule.rounding)) issues.push(hold('invalid-rounding', 'Choose an available retail rounding option.'));
  const isPercent = rule.mode === 'percent-off';
  const valid = isPercent ? amount && !amountGreaterThan(readAmount('1')!, amount) && !amountGreaterThan(amount, readAmount('90')!) :
    rule.mode === 'fixed-amount-off' && amount && amount.units > 0n && amount.scale <= 2;
  if (!valid || !amount) {
    issues.push(hold('invalid-discount', 'Enter 1% to 90% off or a positive fixed amount with at most two decimal places.'));
    return null;
  }
  if (!floor || floor.units <= 0n || !roundings.has(rule.rounding)) return null;
  const calculate = isPercent ? preparePricing({ mode: 'percent-markup', markupPercent: '-' + amount.text, rounding: rule.rounding }) :
    (old: Amount) => roundRetail(readAmount(amountDelta(amount, old))!, rule.rounding);
  return { floor, calculate };
}

function inDefaultScope(variant: Variant, baseline: Baseline): boolean {
  if (!variant.price && !variant.compareAtPrice) return false;
  if (variant.woocommerce) return wooWritable(variant.woocommerce.type);
  return !variant.bigcommerce || variant.bigcommerce.type === 'Product' && !baseline.bigcommerceGroupedProducts?.has(variant.bigcommerce.productId);
}

function selectScope(baseline: Baseline, scope: PromoCampaignOptions['scope'], issues: PromoCampaignIssue[]) {
  const { skuPrefix, skus, handle, tag } = scope ?? {};
  const suppliedSkus = new Set(skus);
  const explicit = skuPrefix !== undefined || skus !== undefined || handle !== undefined || tag !== undefined;
  const tagColumn = baseline.columns.get('Tags');
  if ([skuPrefix, handle, tag, ...suppliedSkus].some(value => value !== undefined && !value.trim()) ||
    skus && (!skus.length || suppliedSkus.size !== skus.length || skuPrefix !== undefined) || tag?.includes(',')) {
    issues.push(hold('invalid-campaign-scope', 'Use one SKU prefix or an exact unique SKU list, an exact handle, and a single tag when filtering.'));
    return { selected: new Set<number>(), ambiguous: new Set<string>() };
  }
  if ((handle !== undefined || tag !== undefined) && (baseline.platform !== undefined || tag !== undefined && tagColumn === undefined)) {
    issues.push(hold('unsupported-campaign-scope', 'Handle and tag filters require a Shopify baseline. Tag filtering also needs the original Tags column.'));
    return { selected: new Set<number>(), ambiguous: new Set<string>() };
  }

  const productTags = new Map<string, { first: string[]; ambiguous: boolean; matched: boolean }>();
  if (tag !== undefined) for (const { source, handle } of baseline.variants) {
    const raw = cellValue(source, tagColumn) ?? '';
    const tags = [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))].sort();
    const original = productTags.get(handle);
    if (!original) productTags.set(handle, { first: tags, ambiguous: false, matched: tags.includes(tag) });
    else if (raw !== '' && (tags.length !== original.first.length || tags.some((value, index) => original.first[index] !== value))) {
      original.ambiguous = true;
      original.matched ||= tags.includes(tag);
    }
  }

  const selected = new Set<number>();
  const ambiguous = new Set<string>();
  const matchedSkus = new Set<string>();
  for (const variant of baseline.variants) {
    const tags = productTags.get(variant.handle);
    if (!explicit && !inDefaultScope(variant, baseline) || skuPrefix !== undefined && !variant.sku.startsWith(skuPrefix) ||
      skus && !suppliedSkus.has(variant.sku) || handle !== undefined && variant.handle !== handle || tag !== undefined && !tags?.matched) continue;
    if (tags?.ambiguous) ambiguous.add(variant.handle);
    selected.add(variant.source.line);
    if (skus) matchedSkus.add(variant.sku);
  }
  const unmatched = skus?.filter(sku => !matchedSkus.has(sku)).length ?? 0;
  if (unmatched) issues.push(hold('campaign-sku-not-found', `${unmatched} requested SKU(s) did not match the exact filters in the baseline.`));
  else if (explicit && !selected.size) issues.push(hold('empty-campaign-scope', 'The filters do not match an existing baseline row.'));
  return { selected, ambiguous };
}

function summarize(rows: readonly PromoCampaignRow[]): PromoCampaignSummary {
  const summary: PromoCampaignSummary = { totalRows: rows.length, selectedRows: 0, changedRows: 0, heldRows: 0, skippedRows: 0,
    unchangedRows: 0, warningRows: 0, averageDiscountPercent: null, totalPriceReduction: '0' };
  let total = 0n;
  let scale = 0;
  const discounts: { numerator: bigint; denominator: bigint }[] = [];
  for (const row of rows) {
    if (row.status === 'out-of-scope') continue;
    summary.selectedRows++;
    if (row.issues.some(({ severity }) => severity === 'warning')) summary.warningRows++;
    if (row.status === 'held') summary.heldRows++;
    else if (row.status === 'skipped') summary.skippedRows++;
    else if (row.status === 'unchanged') summary.unchangedRows++;
    else if (row.status === 'changed') {
      summary.changedRows++;
      const before = readAmount(row.beforePrice)!;
      const promo = readAmount(row.promoPrice!)!;
      const digits = Math.max(before.scale, promo.scale);
      const baselineUnits = before.units * 10n ** BigInt(digits - before.scale);
      const reduction = baselineUnits - promo.units * 10n ** BigInt(digits - promo.scale);
      discounts.push({ numerator: reduction, denominator: baselineUnits });
      const nextScale = Math.max(scale, digits);
      total = total * 10n ** BigInt(nextScale - scale) + reduction * 10n ** BigInt(nextScale - digits);
      scale = nextScale;
    }
  }
  if (discounts.length) {
    summary.averageDiscountPercent = meanPercent(discounts);
    const digits = total.toString().padStart(scale + 1, '0');
    const fractional = digits.slice(digits.length - scale).replace(/0+$/, '');
    summary.totalPriceReduction = digits.slice(0, digits.length - scale) + (fractional ? '.' + fractional : '');
  }
  return summary;
}

export async function buildPromoCampaign(platform: StorePlatform, baselineBytes: Uint8Array, options: PromoCampaignOptions): Promise<PromoCampaign> {
  const baselineDigest = sha256(baselineBytes);
  const costSheetDigest = options.costSheet !== undefined ? sha256(options.costSheet) : undefined;
  const issues: PromoCampaignIssue[] = [];
  const woo = platform === 'woocommerce';
  const big = platform === 'bigcommerce';
  const shop = platform === 'shopify';
  const parse = woo ? parseWooCommerceBaseline : big ? parseBigCommerceBaseline : parseBaseline;
  const baseline = parse(baselineBytes, undefined, { retainEmptyRecords: true });
  for (const entry of baseline.issues) issues.push(sourceIssue(entry, 'baseline'));
  const retailHeader = woo ? wooRegularHeader : big ? bigPriceHeader : priceHeader;
  const saleHeader = woo ? wooSaleHeader : big ? bigSaleHeader : compareAtHeader;
  if (baseline.headers.length && !baseline.columns.has(saleHeader)) {
    issues.push({ ...hold('missing-original-sale-column', 'Re-export the original sale or compare-at column to verify exact rollback.', baseline.headerRow ?? undefined, saleHeader), source: 'baseline' });
  }
  const discount = prepareDiscount(options.rule, issues);
  const scope = selectScope(baseline, options.scope, issues);
  const skips = new Set(options.skipLineNumbers);
  if ([...skips].some(line => !scope.selected.has(line))) issues.push(hold('invalid-campaign-skip', 'Skip only a selected physical line from this baseline.'));
  const costs = options.costCheck || options.costSheet !== undefined ? campaignCosts(baseline, options.costSheet, issues) : null;
  const dateColumns = woo ? baseline.headers.flatMap((header, index) =>
    ['date sale price starts', 'date sale price ends'].includes(mappingLabel(header)) ? [index] : []) : [];
  const tracking = big ? bigCommerceProductTracking(baseline) : new Map<string, string>();
  const shopGroupLinks = shop ? new Set(baseline.variants.filter(({ linkedOption }) => linkedOption).map(({ handle }) => handle)) : new Set<string>();
  const patches: Parameters<typeof verifiedExports>[1] = [];
  const rows = baseline.variants.map((variant): PromoCampaignRow => {
    const { source, sku, handle, price, compareAtPrice: originalSale } = variant;
    const { line } = source;
    const regular = plainAmount(price);
    const sale = plainAmount(originalSale);
    const existingSale = !shop && sale && regular && amountGreaterThan(regular, sale) ? sale : null;
    const effective = existingSale ?? regular;
    const before = existingSale ? originalSale! : price;
    const row: PromoCampaignRow = { line, sku, product: handle, status: 'out-of-scope', regularPrice: price, beforePrice: before, promoPrice: null, revertPrice: before,
      beforeCompareAtOrSalePrice: originalSale, promoCompareAtOrSalePrice: null, revertCompareAtOrSalePrice: originalSale, discountPercent: null,
      minimumRetail: options.rule.minimumRetail, cost: null, costSource: null, costMargin: null, issues: [] };
    if (!scope.selected.has(line)) return row;
    const lockedDate = dateColumns.find(index => (cellValue(source, index) ?? '') !== '');
    if (scope.ambiguous.has(handle)) row.issues.push(hold('ambiguous-product-tags', 'The product rows disagree on the original tags.', line, 'Tags'));
    if (shopGroupLinks.has(handle)) row.issues.push(hold('linked-shopify-options', 'This affected handle has linked options that need a different import workflow.', line, 'Handle'));
    if (woo && (!wooWritable(variant.woocommerce!.type) || !sku)) {
      row.issues.push(hold('unsupported-woo-update-type', 'Promote existing simple products or variations with exact SKUs.', line, 'Type'));
    }
    if (lockedDate !== undefined) row.issues.push(hold('scheduled-woo-sale', 'This product already has sale dates. Review its original sale schedule before creating a campaign.', line, baseline.headers[lockedDate]));
    if (!shop && originalSale && (!sale || !regular || !amountGreaterThan(regular, sale))) {
      row.issues.push(hold('invalid-original-sale', 'The original sale must be a plain decimal below the regular price.', line, saleHeader));
    }
    if (!effective || effective.units <= 0n || !regular || regular.units <= 0n) {
      row.issues.push(hold('nonpositive-original-price', 'A campaign requires a known positive original retail price.', line, retailHeader));
    } else if (discount) {
      const promo = discount.calculate(effective);
      if (!promo) {
        row.issues.push(hold('nonpositive-promo-price', 'The discount and rounding must produce a positive price.', line, shop ? retailHeader : saleHeader));
      } else {
        row.promoPrice = promo.text;
        row.promoCompareAtOrSalePrice = shop ? options.rule.preserveHigherCompareAt && sale && amountGreaterThan(sale, regular) ? originalSale : price : promo.text;
        const movement = priceMovement(effective, promo, 100, 100).deltaPercent!;
        row.discountPercent = movement.startsWith('-') ? movement.slice(1) : movement === '0' ? '0' : '-' + movement;
        if (amountGreaterThan(discount.floor, promo)) {
          row.issues.push(hold('minimum-retail-breach', `Promo ${promo.text} is below the minimum retail floor ${options.rule.minimumRetail}.`, line, shop ? retailHeader : saleHeader));
        }
        if (!amountGreaterThan(effective, promo)) {
          row.issues.push(hold('promo-does-not-discount', 'The rounded promo must be below the current effective retail price.', line, shop ? retailHeader : saleHeader));
        }
        if (big) for (const entry of bigCommerceValueIssues(baseline, variant, new Map([[bigSaleHeader, promo.text]]), tracking)) {
          row.issues.push(sourceIssue(entry, 'campaign'));
        }
        if (costs) {
          const cost = costs(variant);
          row.cost = cost.raw;
          row.costSource = cost.source;
          if (!cost.amount) {
            row.issues.push({ ...hold('unknown-promo-cost', 'Margin could not be checked. Use a plain cost in the store currency.', line, cost.source?.column), severity: 'warning' });
          } else {
            row.costMargin = amountDelta(cost.amount, promo);
            if (amountGreaterThan(cost.amount, promo)) {
              row.issues.push({ ...hold('promo-below-cost', `Promo ${promo.text} is below cost ${cost.raw}.`, line, cost.source?.column), severity: 'warning' });
            }
          }
        }
      }
    }
    if (skips.has(line)) {
      row.status = 'skipped';
      row.issues = row.issues.map(entry => entry.severity === 'hold' ? { ...entry, severity: 'warning' } : entry);
    } else if (row.issues.some(({ severity }) => severity === 'hold')) row.status = 'held';
    else if (row.promoPrice === null) row.status = 'unchanged';
    else {
      row.status = 'changed';
      patches.push({ status: 'Updated', baselineRow: line, handle, bigcommerce: variant.bigcommerce, oldPrice: price,
        newPrice: shop ? row.promoPrice : null, oldCompareAtPrice: originalSale, newCompareAtPrice: row.promoCompareAtOrSalePrice });
    }
    issues.push(...row.issues);
    return row;
  });

  const summary = summarize(rows);
  const storeLabel = options.storeLabel ?? baseline.name;
  const store = (options.storeLabel ?? platform).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 72).replace(/^-+|-+$/g, '') || platform;
  const fileNames = { launch: `${store}-promo-launch.csv`, revert: `${store}-promo-revert.csv`, audit: `${store}-promo-audit.json`, signoff: `${store}-promo-sign-off.html` };
  let launchCsv: string | null = null;
  let revertCsv: string | null = null;
  let verification: { matchedRows: number; restored: true; residualDiffs: 0; nonTargetMutations: 0; brokenGroups: 0 } | null = null;
  const custody: PromoCampaignCustody = { baselineSha256: await baselineDigest, launchSha256: null, revertSha256: null };
  if (costSheetDigest) custody.costSheetSha256 = await costSheetDigest;
  if (!patches.length && !issues.some(({ severity }) => severity === 'hold')) {
    issues.push(hold('no-promo-changes', 'Select at least one eligible product with a verified lower promo price.'));
  }
  if (!issues.some(({ severity }) => severity === 'hold')) {
    const identity = woo ? wooIdentityHeaders : big ? bigCommerceIdentityHeaders(baseline) : shopifyIdentityHeaders.filter(column => baseline.columns.has(column));
    const targets = shop ? [retailHeader, saleHeader] : [saleHeader];
    const pair = verifiedExports(baseline, patches, true, false, false, undefined, { identity, targets });
    if (pair.updateBytes && pair.rollbackBytes) {
      const checked = await inspectImport(platform, baselineBytes, pair.rollbackBytes, pair.updateBytes);
      if (checked.verdict === 'PASS' && checked.rollback.restored && checked.rollback.residualDiffs === 0 && checked.nonTargetMutations === 0 &&
        checked.brokenGroups === 0 && checked.rollback.pairedUpdateSha256 && checked.baselineSha256 === custody.baselineSha256) {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        launchCsv = decoder.decode(pair.updateBytes);
        revertCsv = decoder.decode(pair.rollbackBytes);
        custody.launchSha256 = checked.rollback.pairedUpdateSha256;
        custody.revertSha256 = checked.candidateSha256;
        verification = { matchedRows: checked.matchedRows, restored: true, residualDiffs: 0, nonTargetMutations: 0, brokenGroups: 0 };
      } else {
        for (const entry of checked.issues) {
          issues.push({ ...hold(entry.code, entry.message, entry.line, entry.column), source: 'native-verification' });
        }
      }
    }
    if (verification === null) issues.push({ ...hold('unverified-promo-pair', 'The native pair did not pass exact catalog recovery checks.'), source: 'native-verification' });
  }
  const canExport = verification !== null;
  const auditJson = JSON.stringify({ version: 1, platform, storeLabel, rule: options.rule, scope: options.scope ?? null, costCheck: costs !== null,
    skippedLines: [...skips], summary, rows, issues, canExport, verification, fileNames, custody }, null, 2) + '\n';
  return { platform, rows, issues, summary, canExport, launchCsv, revertCsv, auditJson, fileNames, custody,
    signoffHtml: canExport ? promoSignoff(storeLabel, platform, summary, rows, custody) : null };
}
