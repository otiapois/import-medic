import { brandSignoffHtml, type SignoffBrand } from '../branding/signoff-brand';
import { parseCsv, serializeCsv } from '../csv';
import { guardSpreadsheetCell as guard } from '../formula-guard';
import { escapeReportText as escape, offlineReportCsp } from '../report-html';
import type { WholesaleBuyerRow, WholesalePriceRow } from './types';

function verifiedCsv(headers: string[], rows: string[][]): string | null {
  const csv = serializeCsv(headers, rows, 'wholesale-sheet');
  const { records } = parseCsv(csv);
  const expected = [headers, ...rows];
  return records.length === expected.length && records.every(({ cells, parseError }, row) =>
    !parseError && cells.length === headers.length && cells.every((cell, index) => cell === expected[row][index])) ? csv : null;
}

const buyerHeaders = (tiers: readonly string[]) =>
  ['SKU', 'Product', 'Case Pack', ...tiers.flatMap(tier => [tier + ' MOQ', tier + ' Unit Price'])];

const buyerCells = ({ sku, product, casePack, tiers }: WholesaleBuyerRow) =>
  [sku, product, casePack, ...tiers.flatMap(({ minOrderQty, unitPrice }) => [minOrderQty, unitPrice])];

export function exportBuyerCsv(rows: readonly WholesaleBuyerRow[], tiers: readonly string[]) {
  return verifiedCsv(buyerHeaders(tiers).map(guard), rows.map(row => buyerCells(row).map(guard)));
}

export function exportShopifyCsv(rows: readonly WholesaleBuyerRow[], title: string, tierIndex: number) {
  return verifiedCsv(['Catalog Title', 'SKU', 'Option1 Name', 'Option1 Value', 'Fixed Price', 'Quantity Increment', 'Minimum Order Quantity'],
    rows.map(({ sku, casePack, tiers }) => [title, sku, '', '', tiers[tierIndex].unitPrice, casePack, tiers[tierIndex].minOrderQty]));
}

export function exportMerchantCsv(rows: readonly WholesalePriceRow[]) {
  return verifiedCsv(['SKU', 'Product', 'Catalog Line', 'Cost Sheet Line', 'Retail Price', 'Landed Cost', 'MAP', 'Case Pack', 'SKU MOQ',
    'Tier', 'Eligible MOQ', 'Unit Price', 'Gross Margin %', 'Profit'],
  rows.flatMap(row => row.tiers.map(tier => [row.sku, row.product, String(row.line), row.costLine?.toString() ?? '',
    row.retailPrice, row.landedCost ?? '', row.map ?? '', row.casePack, row.moq, tier.tierName, tier.minOrderQty ?? '',
    tier.unitPrice ?? '', tier.marginPercent ?? '', tier.profit ?? ''].map(guard))));
}

export function renderBuyerLineSheet(rows: readonly WholesaleBuyerRow[], tiers: readonly string[],
  { brandLabel, currency, effectiveDate }: { brandLabel: string; currency: string; effectiveDate: string }, branding?: SignoffBrand) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${offlineReportCsp}"><title>${escape(brandLabel)} Wholesale Buyer Line Sheet</title>
<style>
*{box-sizing:border-box}body{max-width:78rem;margin:auto;padding:clamp(1rem,4vw,3rem);background:#f4f7f7;color:#152b2b;font:1rem/1.5 system-ui,sans-serif;overflow-wrap:anywhere}
header{border-top:.35rem solid #176252;padding:1rem 0}h1{margin:.25rem 0;font-size:clamp(1.65rem,5vw,2.7rem);line-height:1.15}
p{margin:.4rem 0}.currency{background:#e3efec;border:1px solid #829b95;border-radius:.25rem;padding:.05rem .35rem;font-weight:650}
.sheet-table{background:#fff;border:1px solid #829b95;border-radius:.35rem;overflow:auto}.sheet-table:focus-visible{outline:3px solid #176252;outline-offset:2px}
table{width:100%;border-collapse:collapse}thead{background:#e8f0ee}th,td{text-align:left;vertical-align:top;padding:.5rem;border-bottom:1px solid #b7c6c4}
tbody th,tbody td:nth-child(n+3){font-variant-numeric:tabular-nums}td:nth-child(2){white-space:pre-line}
@media screen{th,td{overflow-wrap:normal}tbody th,tbody td:nth-child(n+3){white-space:nowrap}}
@media print{body{max-width:none;margin:0;padding:0;background:#fff;font-size:9pt}.sheet-table{overflow:visible;border:0}
thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}th,td{padding:.25rem}header{break-after:avoid}}
</style></head><body>
<header><p><strong>${escape(brandLabel)}</strong></p><h1>Wholesale Buyer Line Sheet</h1>
<p>Effective <time datetime="${escape(effectiveDate)}">${escape(effectiveDate)}</time> · <span class="currency">${escape(currency)}</span></p>
<p>Order in case-pack multiples. Each tier lists the minimum eligible units for that SKU.</p></header>
<main><div class="sheet-table" tabindex="0" role="region" aria-label="Wholesale prices"><table>
<thead><tr>${buyerHeaders(tiers).map(text => '<th scope="col">' + escape(text) + '</th>').join('')}</tr></thead>
<tbody>${rows.map(row => '<tr>' + buyerCells(row).map((text, index) =>
    index === 0 ? '<th scope="row">' + escape(text) + '</th>' : '<td>' + escape(text) + '</td>').join('') + '</tr>').join('\n')}</tbody>
</table></div></main></body></html>`;
  return brandSignoffHtml(html, branding).replaceAll('//', '&#47;/');
}
