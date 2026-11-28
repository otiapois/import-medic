import { z } from 'zod';
import { grossMarginFraction, meanPercent } from '../analytics/catalog-impact';
import { sha256 } from '../audit/custody';
import { costText } from '../bom/rollup';
import { signoffBrandSchema, type SignoffBrand } from '../branding/signoff-brand';
import { guardSpreadsheetCell } from '../formula-guard';
import { currencyCode, preparePricing, retailRoundingSchema } from '../shopify-price-diff/pricing-rules';
import { baselinePrice, readAmount } from '../shopify-price-diff/prices';
import { profileText } from '../shopify-price-diff/settings-validation';
import type { StorePlatform } from '../shopify-price-diff/types';
import { exportBuyerCsv, exportMerchantCsv, exportShopifyCsv, renderBuyerLineSheet } from './output';
import { maxQuantity, mergeEvidence, positiveQuantity, readWholesaleBaseline, readWholesaleCosts } from './source';
import type { WholesaleBuyerRow, WholesaleIssue, WholesaleOptions, WholesalePriceList, WholesalePriceRow, WholesaleTier } from './types';

export type {
  WholesaleBuyerRow, WholesaleBuyerTier, WholesaleCustody, WholesaleIssue, WholesaleOptions, WholesalePriceList,
  WholesalePriceRow, WholesalePriceTier, WholesaleTier,
} from './types';

export const wholesaleSettings = z.strictObject({
  brandLabel: profileText(120),
  currency: currencyCode,
  effectiveDate: z.iso.date(),
  shopifyCatalogTitle: profileText(120),
  shopifyTierName: profileText(80),
  minimumMarginPercent: z.string().optional(),
  requireMap: z.boolean().optional(),
  tiers: z.array(z.strictObject({
    tierName: profileText(80),
    discountMode: z.enum(['percent-off-retail', 'cost-plus-percent']),
    value: z.string(),
    minOrderQty: z.string(),
    rounding: retailRoundingSchema,
  })).min(1).max(5),
});

const utf8 = new TextEncoder();
const plainAmount = (raw: string) => baselinePrice.test(raw) ? readAmount(raw) : null;

function prepareTier(tier: WholesaleTier, previousMin: bigint, issues: WholesaleIssue[]) {
  const { tierName, minOrderQty, discountMode, value, rounding } = tier;
  const quantity = positiveQuantity(minOrderQty);
  const amount = plainAmount(value);
  const discount = discountMode === 'percent-off-retail';
  if (quantity === null || quantity <= previousMin) issues.push({ source: 'options', tierName,
    code: 'invalid-tier-minimums', message: 'Tier minimums must be strictly increasing positive whole numbers.' });
  if (amount === null || discount && amount.units >= 100n * 10n ** BigInt(amount.scale)) issues.push({
    source: 'options', tierName, code: 'invalid-tier-percent',
    message: discount ? 'Use a discount from 0% up to less than 100%.' : 'Use a nonnegative markup percentage.',
  });
  return { tierName, quantity, discount, calculate: amount === null ? null : preparePricing({
    mode: 'percent-markup', markupPercent: discount ? '-' + amount.text : amount.text, rounding,
  }) };
}

function evaluateRows(baseline: ReturnType<typeof readWholesaleBaseline>, costInput: ReturnType<typeof readWholesaleCosts> | undefined,
  options: z.infer<typeof wholesaleSettings>, issues: WholesaleIssue[]): WholesalePriceRow[] {
  let previousMin = 0n;
  const names = new Set<string>();
  const tiers = options.tiers.map(tier => {
    const result = prepareTier(tier, previousMin, issues);
    if (result.quantity !== null) previousMin = result.quantity;
    const comparableName = tier.tierName.trim().normalize('NFC').toLowerCase();
    if (names.has(comparableName)) issues.push({ source: 'options', code: 'duplicate-tier-name', tierName: tier.tierName, message: 'Use distinct tier names.' });
    names.add(comparableName);
    return result;
  });
  if (!tiers.some(tier => tier.tierName === options.shopifyTierName)) issues.push({ source: 'options',
    code: 'invalid-shopify-tier', tierName: options.shopifyTierName, message: 'Select an existing tier by its exact name.' });
  if (guardSpreadsheetCell(options.shopifyCatalogTitle) !== options.shopifyCatalogTitle) issues.push({ source: 'native',
    code: 'unsafe-native-catalog-title', column: 'Catalog Title', message: 'Use an exact destination catalog title that is safe in a spreadsheet.' });
  const requestedMargin = options.minimumMarginPercent;
  const minimumMargin = requestedMargin === undefined ? null : plainAmount(requestedMargin);
  if (requestedMargin !== undefined && (minimumMargin === null || minimumMargin.units >= 100n * 10n ** BigInt(minimumMargin.scale))) {
    issues.push({ source: 'options', code: 'invalid-minimum-margin', message: 'Use a minimum margin from 0% up to less than 100%.' });
  }
  return baseline.map(({ sku, product, price, line, evidence }) => {
    const offered = costInput?.records.get(sku);
    const evidenceUsed = mergeEvidence(evidence, offered?.evidence, sku, line, issues);
    const { cost, map } = evidenceUsed;
    const landedCost = cost ? costText(cost.value) : null;
    const costAmount = landedCost === null ? null : readAmount(landedCost);
    const retail = plainAmount(price);
    const casePack = evidenceUsed.casePack?.value ?? 1n;
    const moq = evidenceUsed.moq?.value ?? 1n;
    const costLine = offered?.line ?? null;
    function fail(code: string, message: string, tierName?: string, field?: NonNullable<typeof cost>) {
      issues.push({ source: field?.source ?? 'pricing', code, message, sku, tierName, line: field?.line ?? line, baselineLine: line,
        ...(costLine === null ? {} : { costLine }) });
    }
    if (guardSpreadsheetCell(sku) !== sku) issues.push({ source: 'native', code: 'unsafe-native-sku', sku, line, baselineLine: line,
      column: 'SKU', tierName: options.shopifyTierName, message: 'This SKU would change under formula neutralization. Correct its native identity first.' });
    let previousPrice: bigint | null = null;
    return { sku, product, line, retailPrice: price, landedCost, map: map ? costText(map.value) : null, casePack: String(casePack), moq: String(moq),
      costLine, tiers: tiers.map(({ tierName, quantity, discount, calculate }) => {
        const missingCost = costAmount === null && (!discount || requestedMargin !== undefined);
        if (missingCost) fail('missing-landed-cost', 'Provide a verified landed cost for this tier and its required margin check.', tierName);
        if (options.requireMap && !map) fail('missing-map', 'Provide a verified MAP for this SKU or turn off the required MAP check.', tierName);
        const required = quantity === null ? null : quantity > moq ? quantity : moq;
        const eligible = required === null ? null : (required + casePack - 1n) / casePack * casePack;
        if (eligible !== null && eligible > maxQuantity) fail('tier-quantity-overflow', 'The first eligible case multiple exceeds the quantity limit.',
          tierName, evidenceUsed.casePack ?? evidenceUsed.moq);
        const basis = discount ? retail : costAmount;
        const invalidRetail = !retail || retail.units <= 0n;
        if (invalidRetail) fail('invalid-retail-price', 'Supply a positive plain retail price for this sellable SKU.', tierName);
        const amount = basis && calculate && !invalidRetail ? calculate(basis) : null;
        const final = amount?.units ?? null;
        if (basis && calculate && !invalidRetail && final === null) {
          fail('nonpositive-tier-price', 'The tier formula and rounding must produce a representable positive price.', tierName, discount ? undefined : cost);
        }
        let marginPercent: string | null = null;
        let profit: string | null = null;
        if (final !== null && amount !== null) {
          if (previousPrice !== null && final > previousPrice) fail('non-monotonic-tier-price',
            'The rounded unit price exceeds the previous tier’s price.', tierName);
          previousPrice = final;
          if (map && final < map.value) fail('below-map', 'The rounded tier unit price is below MAP.', tierName, map);
          if (cost) {
            const difference = final - cost.value;
            if (difference < 0n) fail('below-landed-cost', 'The rounded tier unit price is below landed cost.', tierName, cost);
            const fraction = grossMarginFraction(landedCost!, amount)!;
            marginPercent = meanPercent([fraction], 6);
            profit = difference < 0n ? '-' + costText(-difference) : costText(difference);
            if (minimumMargin && difference * 100n * 10n ** BigInt(minimumMargin.scale) < minimumMargin.units * final) {
              fail('below-minimum-margin', 'The rounded tier unit price does not meet the minimum gross margin.', tierName, cost);
            }
          }
        }
        return { tierName, minOrderQty: eligible === null ? null : String(eligible), unitPrice: amount?.text ?? null, marginPercent, profit };
      }) };
  });
}

export async function buildWholesalePriceList(platform: StorePlatform, baselineBytes: Uint8Array, options: WholesaleOptions,
  branding?: SignoffBrand): Promise<WholesalePriceList> {
  const { costSheet, worksheetName, ...settings } = options;
  const fingerprints = Promise.all([sha256(baselineBytes), costSheet === undefined ? null : sha256(costSheet)]);
  const checked = wholesaleSettings.safeParse(settings);
  const checkedBrand = signoffBrandSchema.optional().safeParse(branding);
  const issues: WholesaleIssue[] = [];
  if (!checked.success) for (const issue of checked.error.issues) issues.push({ source: 'options', code: 'invalid-wholesale-options',
    column: issue.path.join('.'), message: issue.message });
  if (!checkedBrand.success) issues.push({ source: 'options', code: 'invalid-branding', message: 'Provide a valid Workspace Profile brand.' });
  if (worksheetName !== undefined && costSheet === undefined) issues.push({ source: 'options', code: 'missing-cost-sheet',
    message: 'Attach a cost workbook before choosing a worksheet.' });
  const currency = checked.data?.currency ?? '';
  const baseline = readWholesaleBaseline(platform, baselineBytes, currency, issues);
  const costInput = costSheet === undefined ? undefined : readWholesaleCosts(costSheet, worksheetName, currency, issues);
  if (!baseline.length && !issues.length) issues.push({ source: 'baseline', code: 'no-wholesale-skus', message: 'Include at least one sellable catalog SKU.' });
  const rows = checked.success ? evaluateRows(baseline, costInput, checked.data, issues) : [];
  const slug = (checked.data?.brandLabel ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72).replace(/-+$/, '') || 'wholesale';
  const fileNames = { buyer: slug + '-wholesale-buyer-sheet.csv', shopify: slug + '-shopify-b2b-catalog.csv',
    lineSheet: slug + '-wholesale-line-sheet.html', internal: slug + '-wholesale-margin-matrix.csv', audit: 'wholesale-margin-audit.json' };
  const selectedWorksheet = costInput?.selectedWorksheet ?? null;
  let buyerRows: WholesaleBuyerRow[] = [];
  let buyerCsv: string | null = null;
  let shopifyCsv: string | null = null;
  let lineSheetHtml: string | null = null;
  let internalCsv: string | null = null;
  if (checked.success && checkedBrand.success && !issues.length) {
    const { tiers, shopifyCatalogTitle, shopifyTierName } = checked.data;
    const tierNames = tiers.map(({ tierName }) => tierName);
    const buyerProjection: WholesaleBuyerRow[] = rows.map(({ sku, product, casePack, tiers }) => ({
      sku, product, casePack, tiers: tiers.map(({ tierName, minOrderQty, unitPrice }) =>
        ({ tierName, minOrderQty: minOrderQty!, unitPrice: unitPrice! })),
    }));
    const buyer = exportBuyerCsv(buyerProjection, tierNames);
    const shopify = exportShopifyCsv(buyerProjection, shopifyCatalogTitle, tierNames.indexOf(shopifyTierName));
    const merchant = exportMerchantCsv(rows);
    if (buyer === null || shopify === null || merchant === null) issues.push({ source: 'native', code: 'unverified-wholesale-csv',
      message: 'A wholesale CSV could not be re-parsed with every intended cell intact.' });
    else {
      buyerRows = buyerProjection;
      buyerCsv = buyer;
      shopifyCsv = shopify;
      internalCsv = merchant;
      const { brandLabel, currency, effectiveDate } = checked.data;
      lineSheetHtml = renderBuyerLineSheet(buyerProjection, tierNames, { brandLabel, currency, effectiveDate }, checkedBrand.data);
    }
  }
  const [baselineSha256, costSheetSha256] = await fingerprints;
  const [buyerSha256, shopifySha256, lineSheetSha256, internalSha256] = await Promise.all(
    [buyerCsv, shopifyCsv, lineSheetHtml, internalCsv].map(csv => csv === null ? null : sha256(utf8.encode(csv))));
  const custody = { baselineSha256, costSheetSha256, buyerSha256, shopifySha256, lineSheetSha256, internalSha256 };
  const canExport = buyerCsv !== null;
  const auditJson = JSON.stringify({ version: 1, platform, settings, selectedWorksheet, rows, issues, canExport, fileNames, custody }, null, 2) + '\n';
  return { platform, canExport, rows, buyerRows, issues, fileNames, custody, selectedWorksheet, buyerCsv, shopifyCsv, lineSheetHtml, internalCsv, auditJson };
}
