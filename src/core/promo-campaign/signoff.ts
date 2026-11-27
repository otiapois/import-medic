import { brandSignoffHtml, type SignoffBrand } from '../branding/signoff-brand';
import { custodyFooter, escapeReportText, offlineReportCsp } from '../report-html';
import type { PromoCampaignCustody, PromoCampaignRow, PromoCampaignSummary } from './types';

const detailLimit = 100;
const text = (value: string | number | null) => {
  if (value === null) return '—';
  const raw = String(value);
  return escapeReportText(raw.length > 160 ? raw.slice(0, 160) + '…' : raw);
};

export function promoSignoff(storeLabel: string, platform: string, summary: PromoCampaignSummary, rows: readonly PromoCampaignRow[],
  custody: PromoCampaignCustody, branding?: SignoffBrand): string {
  const warnings = rows.filter(({ issues }) => issues.some(({ severity }) => severity === 'warning'));
  const detail = [...warnings, ...rows.filter(({ status, issues }) => status === 'changed' && !issues.length)].slice(0, detailLimit);
  const statistics = [
    ['Selected rows', summary.selectedRows], ['Changed rows', summary.changedRows], ['Skipped rows', summary.skippedRows],
    ['Warning rows', summary.warningRows], ['Average discount', summary.averageDiscountPercent === null ? null : summary.averageDiscountPercent + '%'],
    ['Total catalog price reduction', summary.totalPriceReduction],
  ].map(([label, value]) => '<dt>' + text(label) + '</dt><dd>' + text(value) + '</dd>').join('');
  const body = detail.map((row) => '<tr>' + [row.line, row.sku, row.product, row.status, row.beforePrice, row.promoPrice, row.revertPrice,
    row.minimumRetail, row.cost, row.costMargin, row.issues.map(({ message }) => message).join(' ')].map((value) => '<td>' + text(value) + '</td>').join('') + '</tr>').join('');
  const headings = ['Line', 'SKU', 'Product', 'Status', 'Before', 'Promo', 'Revert', 'Minimum retail', 'Cost', 'Price less cost', 'Review'];
  return brandSignoffHtml(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${offlineReportCsp}">
<title>Promo Campaign Sign-Off</title><style>
:root{color-scheme:light;font:15px system-ui,sans-serif;color:#17242f;background:#fff}
body{margin:2rem auto;padding:0 1rem;max-width:78rem}
h1{font-size:clamp(1.7rem,5vw,2.6rem)}
h2{font-size:1.25rem}
header,footer{border-block:1px solid #a4b4bd}
header p,dd{overflow-wrap:anywhere}
dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.45rem 1rem}
dd{margin:0}
.table{max-width:100%;overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:60rem;text-align:left;font-variant-numeric:tabular-nums}
th,td{padding:.45rem;border-bottom:1px solid #a4b4bd;vertical-align:top;white-space:nowrap}
th{background:#e9f0f3}
th:nth-child(2){width:14%}
th:nth-child(3){width:10%}
th:last-child{width:28%}
td:is(:nth-child(2),:nth-child(3),:last-child){white-space:normal;overflow-wrap:anywhere}
@page{size:landscape;margin:10mm}
@media print{
  body{margin:0;padding:0;font-size:10pt}
  .table{overflow:visible}
  table{min-width:0}
  th,td{padding:.25rem}
  th{white-space:normal}
  tr{break-inside:avoid}
}
</style></head><body><header><h1>Promo Campaign Sign-Off</h1><p>${text(storeLabel)} · ${text(platform)}</p></header><main><dl>${statistics}</dl>
<p>The Launch and Revert CSVs passed local replay against the uploaded catalog with zero residual differences. Import both files manually into the same store. Before reverting, check for edits made after launch.</p>
<h2 id="review-heading">Floor and margin review</h2><p>Shows up to ${detailLimit} rows, with warnings first. The JSON audit contains the full review.</p><div class="table" role="region" aria-labelledby="review-heading" tabindex="0"><table><thead><tr>${headings.map((label) => '<th scope="col">' + label + '</th>').join('')}</tr></thead><tbody>${body}</tbody></table></div></main>
${custodyFooter([['Baseline CSV', custody.baselineSha256], ['Promo Launch CSV', custody.launchSha256 ?? undefined], ['Promo End Revert CSV', custody.revertSha256 ?? undefined], ['Cost sheet', custody.costSheetSha256]])}</body></html>\n`, branding);
}
