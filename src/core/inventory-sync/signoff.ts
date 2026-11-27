import { brandSignoffHtml, type SignoffBrand } from '../branding/signoff-brand';
import { custodyFooter, escapeReportText, offlineReportCsp } from '../report-html';
import type { InventorySyncResult } from './types';

const previewLimit = 100;
const escape = (value: string | number | null) => escapeReportText(value === null ? '—' : String(value));

export function renderInventorySignoff(
  { status, targetLocation, totals, rows, issues, custody, verification }: Omit<InventorySyncResult, 'auditJson' | 'signOffHtml'>,
  brand?: SignoffBrand,
): string {
  const statusText = status === 'ready' ? 'Ready for review' : status === 'blocked' ? 'Held for review' : 'No inventory changes';
  const metrics = [
    ['Units added', totals.unitsAdded], ['Units removed', totals.unitsRemoved],
    ['SKUs zeroed by safety buffer', totals.bufferZeroedCount], ['Out-of-stock count', totals.outOfStockCount],
    ['Changed rows', totals.changedCount],
  ];
  const changed = rows.filter(({ status }) => status === 'changed' || status === 'approval-required' || status === 'blocked');
  const rowHtml = changed.slice(0, previewLimit).map(({ sku, baselineLine, currentRaw, proposedQty, bufferWithheld, status }) =>
    `<tr><th scope="row">${escape(sku)}</th><td>${baselineLine}</td><td>${escape(currentRaw || null)}</td><td>${escape(proposedQty)}</td><td>${escape(bufferWithheld)}</td><td>${escape(status.replaceAll('-', ' '))}</td></tr>`
  ).join('\n');
  const issueHtml = issues.slice(0, previewLimit).map(({ source, supplierIndex, line, message, sku }) =>
    `<li>${escape(source === 'supplier' && supplierIndex !== undefined ? 'Supplier ' + (supplierIndex + 1) : source)}${line === undefined ? '' : ' · line ' + line}${sku === undefined ? '' : ' · ' + escape(sku)} · ${escape(message)}</li>`
  ).join('\n');
  const fingerprints = [
    ['Baseline · ' + custody.baseline.filename, custody.baseline.sha256] as const,
    ...custody.suppliers.map(({ filename, sheetName, sha256 }, index) =>
      ['Supplier ' + (index + 1) + ' · ' + filename + (sheetName === undefined ? '' : ' · ' + sheetName), sha256] as const),
    ['Inventory Update CSV', custody.updateCsvSha256] as const,
    ['Inventory Rollback CSV', custody.rollbackCsvSha256] as const,
  ];
  return brandSignoffHtml(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${offlineReportCsp}"><title>Inventory Sync Sign-Off</title>
<style>
*{box-sizing:border-box}body{max-width:72rem;margin:auto;padding:clamp(1rem,4vw,3rem);color:#152825;background:#f4f7f6;font:1rem/1.5 system-ui,sans-serif;overflow-wrap:anywhere}
h1{margin:0;font-size:clamp(1.75rem,4vw,2.6rem);line-height:1.14}h2{margin:0 0 .6rem}p{margin:.4rem 0 1rem}
header{border-top:.35rem solid #176252;padding-top:1rem}section,footer{margin-top:1.5rem}
section,footer,.summary div{padding:1rem;border:1px solid #829b95;border-radius:.45rem;background:#fff}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.7rem;margin:1.25rem 0}
dt{font-weight:650}dd{margin:0}.summary dd{font-size:1.4rem;font-weight:750}
.table{overflow:auto}.table:focus-visible{outline:3px solid #176252;outline-offset:3px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:.55rem .65rem;vertical-align:top;border-bottom:1px solid #b7c6c4}
td{white-space:nowrap;font-variant-numeric:tabular-nums}thead{background:#e8f0ee}footer dt{margin-top:.65rem}
</style></head>
<body><header><h1>Inventory Sync Sign-Off</h1><p>${statusText} · Target location: ${escape(targetLocation)}</p></header>
<main><dl class="summary">${metrics.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>
${issues.length ? `<section><h2>Review items</h2><p>Both native files are held. See the JSON audit for all review items.</p><ul>${issueHtml}</ul></section>` : ''}
${rowHtml ? `<section><h2 id="inventory-changes">Inventory changes</h2>
${changed.length > previewLimit ? `<p>The JSON audit contains all ${changed.length} rows with changes or review items.</p>` : ''}
<div class="table" tabindex="0" role="region" aria-labelledby="inventory-changes"><table>
<thead><tr><th scope="col">SKU</th><th scope="col">Baseline line</th><th scope="col">On hand</th><th scope="col">Proposed</th><th scope="col">Buffer withheld</th><th scope="col">Status</th></tr></thead>
<tbody>${rowHtml}</tbody></table></div></section>` : ''}
${status === 'ready' ? `<section><h2>Local replay</h2><p>${verification.restoredRows} updated rows restored to their original quantities in the paired replay. ${verification.otherLocationRowsUntouched} rows at other locations are outside both files.</p></section>` : ''}
</main>${custodyFooter(fingerprints)}
</body></html>
`, brand);
}
