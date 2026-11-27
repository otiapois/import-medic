import { grossMarginFraction, meanPercent } from '../analytics/catalog-impact';
import { currencyColumns, explicitlyWholesale, mappingLabel } from '../shopify-price-diff/mapping';
import type { AuditSupplier } from '../shopify-price-diff/output';
import { amountGreaterThan, currenciesAgree, priceMovement, readAmount, sameAmount, type Amount } from '../shopify-price-diff/prices';
import { prepareAutoCompareAt, preparePricing, pricingRuleSchema, type PricingRule } from '../shopify-price-diff/pricing-rules';
import { compareAtHeader } from '../shopify-price-diff/source';
import { issue, type Baseline, type DiffRow, type SourceRow, type Variant } from '../shopify-price-diff/types';
import { costText, exactCostCents, rollupBom, type BomCost, type BomInputs } from './rollup';

export const isCostColumn = (header: string) => explicitlyWholesale(header) || ['cost per item', 'cost price'].includes(mappingLabel(header));

const retailColumns = new Set(['retail price', 'selling price', 'sale price', 'variant price', 'new variant price', 'regular price', 'msrp', 'rrp']);
export const isSupplierCost = (header: string, rule: PricingRule | undefined) => isCostColumn(header) ||
  rule !== undefined && rule.mode !== 'direct' && !retailColumns.has(mappingLabel(header));

/** Convert a verified source unit once. A converted fraction of a cent rounds half up. */
function convertedCents(amount: Amount, rate: Amount): bigint {
  const units = amount.units * rate.units * 100n;
  const denominator = 10n ** BigInt(amount.scale + rate.scale);
  return (2n * units + denominator) / (2n * denominator);
}

function recordCurrencies(row: SourceRow, columns: number[]) {
  return columns.flatMap((column) => {
    const cell = row.cells[column];
    const unit = cell?.value?.trim().toUpperCase();
    if (cell?.kind === 'formula' || cell?.kind === 'unsupported' || unit && !/^(?:[A-Z]{3}|[$€£¥₹])$/.test(unit)) return ['invalid'];
    return unit ? [unit] : [];
  });
}

export function applyBomPricing(
  baseline: Baseline, suppliers: readonly AuditSupplier[], rows: DiffRow[], input: BomInputs,
  readSourceAmount: (raw: string | null, cell: SourceRow['cells'][number] | undefined) => Amount | null,
  reviewGuardCodes: ReadonlySet<string>,
) {
  const columns = baseline.headers.flatMap((header, index) => isCostColumn(header) ? [index] : []);
  const baselineCurrencyColumns = currencyColumns(baseline.headers);
  const variants = new Map<string, Variant | null>();
  for (const variant of baseline.variants) variants.set(variant.sku, variants.has(variant.sku) ? null : variant);
  const byLine = new Map<number, DiffRow>();
  const supplierOnly = new Map<string, DiffRow>();
  for (const row of rows) {
    if (row.baselineRow !== null && !byLine.has(row.baselineRow)) byLine.set(row.baselineRow, row);
    else if (row.baselineRow === null && row.sku !== null && row.status === 'Unmatched Supplier Row') supplierOnly.set(row.sku, row);
  }
  const sources = new Map(suppliers.flatMap((supplier) => {
    const { mapping, sheet } = supplier;
    return mapping ? [[supplier.supplierId, {
      supplier, mapping, records: new Map(sheet.rows.map((row) => [row.line, row])), currency: currencyColumns(sheet.headers),
    }] as const] : [];
  }));
  const units = new Set<string>();
  function currencyOf(evidence: readonly string[]) {
    for (const unit of evidence) units.add(unit);
    return evidence.find((unit) => /^[A-Z]{3}$/.test(unit));
  }
  const cost = (amount: Amount | null, currency: string[], source: Omit<BomCost['source'], 'currency'>, rate?: Amount | null): BomCost | null => {
    const cents = amount && amount.units >= 0n && rate ? convertedCents(amount, rate) : exactCostCents(amount);
    if (cents === null || currency.includes('invalid') || !currenciesAgree(currency)) return null;
    const code = currencyOf(currency);
    return { cents, source: { ...source, ...(code ? { currency: code } : {}) } };
  };
  const cache = new Map<string, { previous: BomCost | null; current: BomCost | null; reason?: string }>();
  const bom = rollupBom(input.sheet, (sku) => {
    const cached = cache.get(sku);
    if (cached) return cached;
    const variant = variants.get(sku);
    if (variant === null) return { previous: null, current: null, reason: 'Component ' + sku + ' matches multiple baseline records.' };
    const row = variant ? byLine.get(variant.source.line) : supplierOnly.get(sku);
    const index = columns.length === 1 ? columns[0] : undefined;
    const original = index === undefined ? undefined : variant?.source.cells[index];
    const oldAmount = readSourceAmount(original?.value ?? null, original);
    const previous = index === undefined || !variant ? null : cost(oldAmount,
      [oldAmount?.currency, original?.currency, ...recordCurrencies(variant.source, baselineCurrencyColumns)].filter((unit) => unit !== undefined && unit !== null),
      { kind: 'baseline', line: variant.source.line, filename: baseline.name, column: baseline.headers[index], ...(original?.value ? { raw: original.value } : {}) });
    let current: BomCost | null = null;
    let reason = 'Component ' + sku + ' needs a verified cost in exact store-currency cents.';
    if (!row || row.status === 'Missing in Supplier' || row.status === 'Skipped') {
      current = previous;
      if (!variant) reason = 'Component ' + sku + ' has no verified supplier or baseline cost.';
      else if (columns.length > 1) reason = 'Component ' + sku + ' has ambiguous baseline cost columns.';
      else if (!previous) reason = 'Component ' + sku + ' has no verified baseline cost.';
    } else if (row.supplierId !== undefined && row.supplierRow !== null &&
      !row.issues.some(({ blocking, code }) => blocking && !reviewGuardCodes.has(code))) {
      const source = sources.get(row.supplierId);
      if (source) {
        const { supplier, records, mapping, currency } = source;
        const record = records.get(row.supplierRow)!;
        const value = record.cells[mapping.price];
        const column = supplier.sheet.headers[mapping.price];
        const raw = value?.value ?? null;
        const amount = readSourceAmount(raw, value);
        const from = [amount?.currency, value?.currency, ...recordCurrencies(record, currency)].filter((unit) => unit !== undefined && unit !== null);
        const fx = supplier.pricingRule?.fx;
        const units = fx ? [fx.sourceCurrency, ...from] : from;
        const confirmed = (!fx || mapping.fxRateConfirmed) && (fx || !from.length || mapping.sameCurrencyConfirmed);
        if (isSupplierCost(column, supplier.pricingRule) &&
          confirmed && !units.includes('invalid') && currenciesAgree(units)) {
          current = cost(amount, fx ? [fx.storeCurrency] : from,
            { kind: 'supplier', filename: supplier.filename, ...(supplier.sheet.name !== supplier.filename ? { worksheet: supplier.sheet.name } : {}),
              supplierId: row.supplierId, line: row.supplierRow, column, ...(raw !== null ? { raw } : {}), ...(fx ? { fx } : {}) },
            fx ? readAmount(fx.fxRate) : null);
        }
        reason = 'Component ' + sku + ' needs a validated supplier cost at ' + supplier.filename + ', line ' + row.supplierRow + '.';
      }
    }
    const resolved = { previous, current, reason };
    cache.set(sku, resolved);
    return resolved;
  });
  if (baseline.market) {
    bom.issues.push(issue('bom', 'bom-market-cost-unverified', 'Use base store pricing for a BOM. The native export does not establish the cost currency for this regional price list.'));
  }
  const pricingSuppliers = [...sources.values()].flatMap(({ supplier, mapping }) => {
    const rule = supplier.pricingRule;
    if (!rule || rule.mode === 'direct') return [];
    const { fx, ...storeRule } = rule;
    return [{ supplier, rule: storeRule, fx, drop: mapping.drop, increase: mapping.increase }];
  });
  bom.pricingSuppliers = pricingSuppliers.map(({ supplier: { supplierId, label } }) => ({ supplierId, label }));
  const options = new Set(pricingSuppliers.map(({ rule, drop, increase }) =>
    JSON.stringify({ rule: pricingRuleSchema.parse(rule), drop, increase })));
  const pricing = input.pricingSupplierId === undefined
    ? options.size === 1 ? pricingSuppliers[0] : undefined
    : pricingSuppliers.find(({ supplier }) => supplier.supplierId === input.pricingSupplierId);
  if (pricing?.fx) units.add(pricing.fx.storeCurrency);
  if (!currenciesAgree([...units])) {
    bom.issues.push(issue('bom', 'bom-currency-conflict', 'Bundle costs use mixed store currencies. Check the baseline currency and the confirmed supplier FX rates.',
      { column: 'Currency', value: [...units].join(', ') }));
  } else {
    const currency = [...units].find((unit) => /^[A-Z]{3}$/.test(unit));
    if (currency) bom.currency = currency;
  }
  if (bom.kits.length && !pricing) {
    bom.issues.push(issue('bom', 'bom-pricing-rule-required', options.size > 1
      ? 'Choose which confirmed supplier pricing rule applies to the bundle SKUs.'
      : 'Confirm a multiplier, percent markup, target margin, or tiered pricing rule for the bundle SKUs.', { column: 'Pricing formula' }));
  }

  const applyPrice = pricing ? preparePricing(pricing.rule) : undefined;
  const autoCompareAt = prepareAutoCompareAt(pricing?.rule);
  const currencyBlocked = bom.issues.some(({ code }) => code === 'bom-currency-conflict' || code === 'bom-market-cost-unverified');
  for (const kit of bom.kits) {
    const variant = variants.get(kit.sku);
    const details = { row: kit.lines[0], rows: kit.lines, column: 'Bundle SKU', value: kit.sku };
    const hold = (code: string, message: string, row?: DiffRow) => {
      const entry = issue('bom', code, message, details);
      bom.issues.push(entry);
      if (row) {
        row.issues.push(entry);
        row.status = 'Blocked';
      }
    };
    if (!variant) {
      hold('bom-bundle-identity', 'Bundle ' + kit.sku + ' needs exactly one matching store baseline SKU.');
      continue;
    }
    kit.baselineLine = variant.source.line;
    const row = byLine.get(variant.source.line)!;
    if (currencyBlocked) {
      kit.newCost = null;
      if (kit.oldCostSource === 'recomputed') {
        kit.oldCost = null;
        kit.oldCostSource = null;
        kit.oldCostEvidence = null;
      }
      for (const component of kit.components) {
        if (component.source?.kind === 'bundle') {
          component.source = null;
          component.unitCost = null;
          component.extendedCost = null;
        }
        if (component.previousSource?.kind === 'bundle') {
          component.previousSource = null;
          component.previousUnitCost = null;
        }
      }
    }
    if (row.supplierRow !== null && row.status !== 'Skipped' || row.supplierContenders?.length) {
      hold('bom-bundle-supplier-conflict', 'Bundle ' + kit.sku + ' has a competing supplier row. Skip that supplier row to use the BOM pricing.', row);
      continue;
    }
    if (row.status === 'Blocked') continue;
    if (kit.newCost === null || !pricing) {
      row.status = 'Blocked';
      continue;
    }
    const amount = readAmount(kit.newCost);
    const price = amount && applyPrice?.(amount);
    const prior = readAmount(variant.price);
    if (!price || !amount || !prior) {
      hold('bom-invalid-kit-retail', 'Bundle ' + kit.sku + ' needs a positive calculated retail and a verifiable original price.', row);
      continue;
    }
    kit.pricingSupplierId = pricing.supplier.supplierId;
    kit.newRetail = sameAmount(prior, price) ? variant.price : price.text;
    const isSale = variant.woocommerce !== undefined || variant.bigcommerce !== undefined;
    const originalCompare = variant.compareAtPrice ? readAmount(variant.compareAtPrice) : null;
    const nextCompare = autoCompareAt ? autoCompareAt(price) : originalCompare;
    const effective = isSale && nextCompare ? nextCompare : price;
    const margin = grossMarginFraction(kit.newCost, effective);
    kit.grossMarginPercent = margin && meanPercent([margin]);
    if (amountGreaterThan(amount, effective)) {
      hold('bom-below-cost', 'Bundle ' + kit.sku + ' would sell below its rolled-up cost. Review its pricing rule and any existing sale price.', row);
    }
    if (autoCompareAt && !nextCompare || nextCompare && (isSale ? !amountGreaterThan(price, nextCompare) : !amountGreaterThan(nextCompare, price))) {
      hold('bom-invalid-compare-at', 'Bundle ' + kit.sku + ' needs a valid ' + (isSale ? 'sale' : 'compare-at') + ' price after repricing.', row);
    }
    const movement = priceMovement(prior, price, pricing.drop, pricing.increase);
    const compareMovement = autoCompareAt && originalCompare && nextCompare
      ? priceMovement(originalCompare, nextCompare, pricing.drop, pricing.increase).guard : null;
    if (movement.guard || compareMovement) {
      hold('bom-price-movement', 'Bundle ' + kit.sku + ' crosses a configured price movement threshold. Review the pricing settings before exporting.', row);
    }
    row.newPrice = kit.newRetail;
    row.computedPrice = price.text;
    row.landedCost = kit.newCost;
    row.deltaPercent = movement.deltaPercent;
    row.bomPricingSupplierId = kit.pricingSupplierId;
    if (price.matchedTier) row.matchedTier = price.matchedTier;
    if (autoCompareAt && nextCompare && (!originalCompare || !sameAmount(originalCompare, nextCompare))) row.newCompareAtPrice = nextCompare.text;
    if (!row.issues.some(({ blocking }) => blocking)) row.status = row.newPrice !== row.oldPrice || row.newCompareAtPrice !== row.oldCompareAtPrice ? 'Updated' : 'Unchanged';
  }
  return bom;
}
