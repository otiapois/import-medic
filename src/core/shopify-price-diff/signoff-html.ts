import { brandSignoffHtml, type SignoffBrand } from '../branding/signoff-brand';
import { cellValue } from './types';
import { bigNameHeader } from '../bigcommerce-price-diff/source';
import type { Baseline, DiffIssue, DiffRow, PriceDiffResult } from './types';
import type { PricingRule } from './pricing-rules';
import { createCatalogImpact, type CatalogImpactSummary } from '../analytics/catalog-impact';
import type { PriceCustody } from '../audit/custody';
import type { BomCostSource, BomRollup } from '../bom/rollup';
import { custodyFooter, escapeReportText as escape, offlineReportCsp } from '../report-html';

const rowLimit = 500;
const watchlistLimit = 100;
const contenderLimit = 12;
const cell = (value: string | null | undefined) => value ? escape(value) : '—';

function sourceLocation(filename: string | undefined, worksheet: string | undefined, row: number): string {
  const names = [filename, worksheet === filename ? undefined : worksheet].filter(Boolean).map(cell);
  return [...names, `Row ${row}`].join(' · ');
}

function meanDelta(rows: readonly DiffRow[]): string {
  let micros = 0n;
  let count = 0n;
  for (const { deltaPercent } of rows) {
    if (deltaPercent === null) continue;
    const [whole, fraction = ''] = deltaPercent.replace(/^-/, '').split('.');
    micros += BigInt(whole + fraction.padEnd(6, '0')) * (deltaPercent.startsWith('-') ? -1n : 1n);
    count++;
  }
  if (!count) return '—';
  const divisor = count * 10_000n;
  const magnitude = micros < 0n ? -micros : micros;
  const hundredths = (2n * magnitude + divisor) / (2n * divisor);
  const sign = micros < 0n && hundredths > 0n ? '-' : '';
  return `${sign}${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}%`;
}

function pricingDescription(rule?: PricingRule): string {
  const details = [];
  if (rule?.mode === 'multiplier') {
    details.push(`Multiplier × ${rule.multiplier}${rule.fixedFee ? ` + ${rule.fixedFee} fixed fee` : ''}`);
  } else if (rule?.mode === 'percent-markup') details.push(`Markup ${rule.markupPercent}%`);
  else if (rule?.mode === 'tiered-brackets') details.push(`Tiered cost brackets (${rule.brackets.length})`);
  else if (rule?.mode === 'target-margin') details.push(`Target margin ${rule.marginPercent}%`);
  else details.push('Direct supplier price');
  if (rule?.retailAdjustmentPercent !== undefined) details.push(`Retail adjustment ${rule.retailAdjustmentPercent}%`);
  if (rule?.rounding) details.push({
    none: 'Cent rounding', 'ending-99': '.99 ending', 'ending-95': '.95 ending', 'nearest-whole': 'Whole-unit rounding',
  }[rule.rounding]);
  if (rule?.minimumRetail) details.push(`Minimum retail ${rule.minimumRetail}`);
  if (rule?.compareAtRule) details.push(`Automatic compare-at × ${rule.compareAtRule.multiplier}`);
  return details.join(' · ');
}

type CachedImpact = { summary: CatalogImpactSummary; watchlist: readonly DiffRow[] };

function analyticsSection(rows: readonly DiffRow[], inventoryEnabled: boolean, woo: boolean, issues?: readonly DiffIssue[], cached?: CachedImpact): string {
  const impact = createCatalogImpact(inventoryEnabled, issues);
  const watchlist: string[] = [];
  for (const row of cached?.watchlist.slice(0, watchlistLimit) ?? rows) {
    const cost = impact.add(row);
    if (!cost?.belowOrAtCost || watchlist.length >= watchlistLimit) continue;
    const retail = woo && row.newCompareAtPrice ? row.newCompareAtPrice : row.newPrice;
    watchlist.push(`<tr><th scope="row">${cell(row.sku || row.handle || row.woocommerce?.id)}</th><td>${cell(retail)}</td><td>${cell(cost.landedCost)}</td><td>${cost.grossMarginPercent === null ? '—' : `${cell(cost.grossMarginPercent)}%`}</td></tr>`);
  }
  const { histogram, priceExcluded, margin, inventory } = cached?.summary ?? impact.summarize();
  const percent = (value: string | null) => value === null ? '—' : `${value}%`;
  const metrics = [
    ['Average gross margin', percent(margin.averagePercent)], ['Lowest gross margin', percent(margin.lowestPercent)],
    ['Highest gross margin', percent(margin.highestPercent)], ['Rows with a calculable margin', String(margin.count)],
    ['At or below landed cost', String(margin.watchlistCount)],
  ];
  if (inventory) metrics.push(['Inventory before', inventory.totalQtyBefore], ['Inventory after', inventory.totalQtyAfter],
    ['Net inventory change', inventory.netQtyDelta], ['Newly zeroed', String(inventory.newlyZeroedCount)], ['Inventory unavailable', String(inventory.unknownQtyCount)]);
  return `<section><h2>Batch Impact &amp; Margin Summary</h2>
<dl class="impact-summary">${metrics.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>
<p>Average gross margin gives each matched row with known landed supplier cost and positive retail the same weight.${woo ? ' Sale price is used as retail when present.' : ''}</p>
<table><caption>${woo ? 'Regular price' : 'Variant price'} movement among admitted matches</caption><thead><tr><th scope="col">Change</th><th scope="col">Rows</th></tr></thead>
<tbody>${histogram.map(({ label, count }) => `<tr><th scope="row">${escape(label)}</th><td>${count}</td></tr>`).join('')}</tbody></table>
<p>Outside the histogram · ${priceExcluded.missing} missing · ${priceExcluded.flagged} flagged · ${priceExcluded.skipped} skipped · ${priceExcluded.unmatched} unmatched · ${priceExcluded.unavailable} unavailable.</p>
<h3>Zero / Negative Margin Watchlist</h3>
${margin.watchlistCount > watchlistLimit ? `<p>Showing ${watchlistLimit} of ${margin.watchlistCount} watchlist rows. Open the catalog impact filter to review every matched item.</p>` : ''}
${watchlist.length ? `<table><thead><tr><th scope="col">SKU / handle</th><th scope="col">Final retail</th><th scope="col">Landed cost</th><th scope="col">Gross margin</th></tr></thead><tbody>${watchlist.join('\n')}</tbody></table>` : '<p>No rows with known landed cost are at or below that cost.</p>'}
</section>`;
}

function bomSection(bom: BomRollup): string {
  const source = (evidence: BomCostSource | null) => evidence
    ? escape(evidence.kind === 'supplier' ? 'Supplier cost' : evidence.kind === 'bundle' ? 'Bundle rollup' : 'Baseline cost')
      + ' · ' + sourceLocation(evidence.filename, evidence.worksheet, evidence.line) + ' · ' + escape(evidence.column)
      + (evidence.fx ? ' · ' + escape(evidence.fx.sourceCurrency + ' → ' + evidence.fx.storeCurrency + ' × ' + evidence.fx.fxRate) : '')
    : '—';
  return `<section><h2>Bundle Cost Rollup</h2>
<p>${escape(bom.filename)}${bom.worksheet ? ' · Worksheet: ' + escape(bom.worksheet) : ''} · ${escape(bom.currency ?? 'Store currency')}</p>
${bom.issues.length ? `<ul>${bom.issues.map(({ message, rows }) => `<li>${escape(message)}${rows.length ? ' · BOM lines ' + rows.join(', ') : ''}</li>`).join('')}</ul>` : ''}
${bom.kits.map(kit => `<h3>${escape(kit.sku)}</h3><p>BOM lines ${kit.lines.join(', ')}${kit.baselineLine === null ? '' : ' · Baseline line ' + kit.baselineLine} · Bundle depth ${kit.depth}</p>
<p>Previous cost ${cell(kit.oldCost)}${kit.oldCostSource === 'recomputed' ? ' (recomputed)' : ''} · New cost ${cell(kit.newCost)} · Projected retail ${cell(kit.newRetail)} · Projected margin ${kit.grossMarginPercent === null ? '—' : escape(kit.grossMarginPercent) + '%'}</p>
${kit.oldCostEvidence ? `<p>Previous cost evidence · ${source(kit.oldCostEvidence)}</p>` : ''}
<p>Assembly cost ${cell(kit.assemblyCost)}${kit.assemblyLine === null ? '' : ' · BOM line ' + kit.assemblyLine}${kit.pricingSupplierId === undefined ? '' : ' · Pricing rule: ' + escape(bom.pricingSuppliers?.find(({ supplierId }) => supplierId === kit.pricingSupplierId)?.label ?? kit.pricingSupplierId)}</p>
<table><caption>Components for ${escape(kit.sku)}</caption><thead><tr>
<th scope="col">SKU · BOM line</th><th scope="col">Quantity</th><th scope="col">Prior unit cost</th><th scope="col">Unit cost</th><th scope="col">Extended cost</th><th scope="col">Cost evidence</th>
</tr></thead><tbody>${kit.components.map(component => `<tr><td>${escape(component.sku)} · ${component.line}</td><td>${escape(component.quantity)}</td>
<td>${cell(component.previousUnitCost)}</td><td>${cell(component.unitCost)}</td><td>${cell(component.extendedCost)}</td><td>${source(component.source)}${component.previousSource ? `<small>Previous: ${source(component.previousSource)}</small>` : ''}</td></tr>`).join('')}
</tbody></table>`).join('')}
</section>`;
}

export function createSignoffHtml(
  baseline: Baseline, result: Pick<PriceDiffResult, 'rows' | 'canDownload' | 'rollbackVerification'> &
    Partial<Pick<PriceDiffResult, 'supplierPricing' | 'conflictCount' | 'conflictPolicy' | 'inventoryEnabled' | 'issues' | 'market' | 'bom'>>,
  rule?: PricingRule, cached?: CachedImpact, custody?: PriceCustody, branding?: SignoffBrand,
): string {
  const woo = baseline.platform === 'woocommerce';
  const bigcommerce = baseline.platform === 'bigcommerce';
  const productPricing = woo || bigcommerce;
  const platformName = bigcommerce ? 'BigCommerce' : woo ? 'WooCommerce' : 'Shopify';
  const heading = platformName + ' Price Update — Client Sign-Off Summary';
  const updated = result.rows.filter(row => row.status === 'Updated');
  const flagged = result.rows.filter(row => row.status === 'Blocked');
  const skipped = result.rows.filter(row => row.status === 'Skipped').length;
  const unchanged = result.rows.filter(row => row.status === 'Unchanged').length;
  const total = updated.length + flagged.length;
  const shown = [...flagged, ...updated].slice(0, rowLimit);
  const titles = new Map<string, string>();
  const options = new Map<number, string>();
  const titleColumn = baseline.columns.get(bigcommerce ? bigNameHeader : woo ? 'Name' : 'Title');
  for (const variant of baseline.variants) {
    const title = cellValue(variant.source, titleColumn);
    if (title) titles.set(variant.handle, title);
    options.set(variant.source.line, variant.options.filter(Boolean).join(' / '));
  }
  const suppliers = result.supplierPricing ?? [];
  const oneRule = rule ?? suppliers[0]?.pricingRule;
  const multiple = suppliers.length > 1;
  const supplierName = (supplier: typeof suppliers[number]) => suppliers.filter(({ label }) => label === supplier.label).length > 1
    ? `${supplier.label} (${supplier.filename})` : supplier.label;
  const metrics = [
    [bigcommerce ? 'Updated products and SKUs' : woo ? 'Updated products and variations' : 'Updated variants', String(updated.length)], ['Skipped / unchanged', `${skipped} / ${unchanged}`],
    ['Blocked / flagged', String(flagged.length)], ['Avg price delta %', meanDelta(updated)],
    ['Pricing formula', multiple ? suppliers.map(supplier => {
      const fx = supplier.pricingRule?.fx;
      return `${supplierName(supplier)} · ${pricingDescription(supplier.pricingRule)}${fx ? ` · ${fx.sourceCurrency} → ${fx.storeCurrency} × ${fx.fxRate}` : ''}`;
    }).join(' | ') : pricingDescription(oneRule)],
    ['Rollback CSV pair', result.canDownload && result.rollbackVerification.checked
      ? `Verified with update · ${result.rollbackVerification.restoredVariants} ${bigcommerce ? 'product and SKU' : woo ? 'product and variation' : 'variant'} rows` : 'Unavailable for this comparison'],
  ];
  if (result.market) metrics.push(['Target price list', result.market.name], ['Market price column', result.market.priceHeader]);
  if (!multiple && oneRule?.fx) metrics.push(['Manual FX rate', `${oneRule.fx.sourceCurrency} → ${oneRule.fx.storeCurrency} × ${oneRule.fx.fxRate}`]);
  const showSources = result.rows.some(row => row.supplierSource || row.supplierContenders?.length);
  if (multiple) {
    const counts = new Map<string, number>();
    for (const row of updated) if (row.supplierId) counts.set(row.supplierId, (counts.get(row.supplierId) ?? 0) + 1);
    metrics.push(['Supplier updates', suppliers.map(supplier => `${supplierName(supplier)} (${counts.get(supplier.supplierId) ?? 0})`).join(' · ')]);
    if (result.conflictCount) metrics.push(['Supplier conflicts', `${result.conflictCount} · ${result.conflictPolicy?.replaceAll('-', ' ')}`]);
  }
  if (result.inventoryEnabled) metrics.push([productPricing ? 'Stock changes' : 'Inventory changes', String(updated.filter(row => row.oldInventoryQty !== row.newInventoryQty).length)]);
  const showTiers = shown.some(row => row.matchedTier);
  const rows = shown.map(row => {
    const identity = row.woocommerce?.id ?? row.handle;
    const title = row.bigcommerce?.name ?? (identity === null ? undefined : titles.get(identity));
    const option = row.baselineRow === null ? undefined : options.get(row.baselineRow);
    const related = bigcommerce ? [row.bigcommerce?.type, row.bigcommerce?.type === 'SKU' ? row.bigcommerce.productId : undefined].filter(Boolean).join(' / ') :
      woo ? [row.woocommerce?.type, row.woocommerce?.parent].filter(Boolean).join(' / ') : option;
    return `<tr><td>${cell(row.sku)}</td><td>${cell(identity)}${title ? `<small>${escape(title)}</small>` : ''}</td>
<td>${cell(related)}</td><td>${cell(row.oldPrice)}</td><td>${cell(row.newPrice)}</td>
<td>${row.deltaPercent === null ? '—' : `${escape(row.deltaPercent)}%`}</td><td>${cell(row.oldCompareAtPrice)} → ${cell(row.newCompareAtPrice)}</td>
${result.inventoryEnabled ? `<td>${cell(row.oldInventoryQty)} → ${cell(row.newInventoryQty)}</td>` : ''}
${showSources ? `<td>${cell(row.supplierSource)}${row.supplierRow !== null ? `<span class="supplier-detail">${sourceLocation(row.supplierFilename, row.supplierWorksheet, row.supplierRow)}</span>` : ''}
${row.supplierContenders?.slice(0, contenderLimit).map(({ label, filename, worksheet, row, priceColumn, price, inventoryColumn, inventoryQty, compareAtColumn, compareAtPrice }) =>
    `<span class="supplier-detail">${cell(label)} · ${sourceLocation(filename, worksheet, row)} · ${cell(priceColumn)}: ${cell(price)}${inventoryColumn ? ` · ${cell(inventoryColumn)}: ${cell(inventoryQty)}` : ''}${compareAtColumn ? ` · ${cell(compareAtColumn)}: ${cell(compareAtPrice)}` : ''}</span>`).join('') ?? ''}${row.supplierContenders && row.supplierContenders.length > contenderLimit ? `<span class="supplier-detail">${row.supplierContenders.length - contenderLimit} more supplier rows in the full audit.</span>` : ''}</td>` : ''}
${showTiers ? `<td>${cell(row.matchedTier)}</td>` : ''}<td>${escape(row.status)}</td></tr>`;
  });
  return brandSignoffHtml(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${offlineReportCsp}">
<title>${heading}</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:clamp(10px,4vw,32px);font:14px/1.45 system-ui,sans-serif;color:#183134;background:#fff}
main{max-width:1120px;margin:auto;overflow-wrap:anywhere}
h1{font-size:clamp(20px,4vw,30px);line-height:1.2}
.summary,.impact-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr));gap:8px}
.summary div,.impact-summary div{padding:9px;border:1px solid #b7cac6;border-radius:6px;background:#f1f7f5}
dt,th,caption{font-weight:700}
dd{margin:2px 0 0}
table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:clamp(10px,2.2vw,13px)}
caption{text-align:left;padding:8px 0}
th,td{border:1px solid #b7cac6;padding:5px;text-align:left;vertical-align:top}
th{background:#eaf3f1}
small,.supplier-detail{display:block}
.supplier-detail{font-size:smaller}
@media print{body{padding:0;font-size:11pt}.summary div,.impact-summary div,th{background:#fff}tr,.summary div,.impact-summary div{break-inside:avoid}thead{display:table-header-group}}
</style>
</head>
<body><main>
<h1>${heading}</h1>
<p>Review the proposed prices${result.inventoryEnabled ? ' and quantities' : ''} before importing the matching ${platformName} update CSV.</p>
<dl class="summary">${metrics.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>
<p>The average covers updated ${bigcommerce ? 'products and SKUs' : woo ? 'products and variations' : 'variants'} with a comparable baseline price.</p>
${bigcommerce ? '<p>Use the legacy product import with Overwrite existing products and Ignore blank values enabled. Match only the included columns. If BigCommerce requires category assignment for this file, stop before importing.</p>' : ''}
${analyticsSection(result.rows, result.inventoryEnabled === true, productPricing, result.issues, cached)}${result.bom ? '\n' + bomSection(result.bom) : ''}
${total > rowLimit ? `<p>Showing ${rowLimit} of ${total} updated or flagged rows, with flagged rows first. See the full diff audit for the remaining ${total - rowLimit}.</p>` : ''}
${rows.length ? `<table><caption>Updated and flagged rows</caption><thead><tr>
<th scope="col">SKU</th><th scope="col">${productPricing ? 'ID' : 'Handle'}</th><th scope="col">${productPricing ? 'Type / Parent' : 'Options'}</th><th scope="col">Old Price</th><th scope="col">New Price</th><th scope="col">Delta %</th><th scope="col">${productPricing ? 'Sale Price' : 'Compare-At'}</th>${result.inventoryEnabled ? `<th scope="col">${productPricing ? 'Stock' : 'Inventory Qty'}</th>` : ''}${showSources ? '<th scope="col">Supplier source</th>' : ''}${showTiers ? '<th scope="col">Matched Tier</th>' : ''}<th scope="col">Status</th>
</tr></thead><tbody>${rows.join('\n')}</tbody></table>` : '<p>There are no updated or flagged rows to show.</p>'}
${custody ? custodyFooter([
    ['Baseline CSV', custody.baselineSha256],
    ...custody.suppliers.map(({ filename, bytes, sha256, selectedSheet }) =>
      [`Supplier ${filename} (${bytes} bytes)${selectedSheet === undefined ? '' : ` · Worksheet: ${selectedSheet}`}`, sha256] as const),
    ...(custody.bom ? [[`Bundle BOM ${custody.bom.filename} (${custody.bom.bytes} bytes)${custody.bom.worksheet ? ` · Worksheet: ${custody.bom.worksheet}` : ''}`, custody.bom.sha256] as const] : []),
    ['Update CSV', custody.updateCsvSha256],
    ['Rollback CSV', custody.rollbackCsvSha256],
  ]) : ''}
</main></body>
</html>
`, branding);
}
