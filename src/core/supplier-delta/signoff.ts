import { brandSignoffHtml, type SignoffBrand } from '../branding/signoff-brand';
import { custodyFooter, escapeReportText, offlineReportCsp } from '../report-html';
import type { SupplierDeltaCustody, SupplierDeltaResult, SupplierDeltaRow, SupplierDeltaSourceDetails } from './types';

const detailLimit = 100;
const majorThreshold = 1_000n;
const percentUnits = (value: string | null): bigint | null => value === null ? null : BigInt(value.replace('.', ''));
const escaped = (value: string): string => escapeReportText(value.length > 240 ? value.slice(0, 237) + '\u2026' : value);
const amount = (value: string | null, currency: string | null): string => {
  if (value === null) return '\u2014';
  const [before, after = ''] = value.split('.');
  const sign = /^[+-]/.test(before) ? before[0] : '';
  const prefix = currency === 'USD' ? '$' : currency && /^[A-Z]{3}$/.test(currency) ? currency + ' ' : currency ?? '';
  return escaped(sign + prefix + before.slice(sign.length) + '.' + after.padEnd(2, '0'));
};
const sourceLabel = ({ filename, selectedSheet }: SupplierDeltaSourceDetails): string =>
  escaped(filename) + (selectedSheet === null ? '' : ' \u00b7 Worksheet: ' + escaped(selectedSheet));

export function renderSupplierDeltaSignOff(
  sources: { previous: SupplierDeltaSourceDetails; next: SupplierDeltaSourceDetails }, rows: readonly SupplierDeltaRow[],
  counts: SupplierDeltaResult['counts'], maxHikePercent: string | null, custody: SupplierDeltaCustody, branding?: SignoffBrand,
): string {
  const hikes = rows.flatMap((row) => row.status === 'cost-increased' ? [{ row, percent: percentUnits(row.deltaPercent) }] : []);
  hikes.sort((a, b) => {
    if (a.percent === b.percent) return 0;
    if (a.percent === null) return 1;
    if (b.percent === null) return -1;
    return a.percent > b.percent ? -1 : 1;
  });
  const body = hikes.slice(0, detailLimit).map(({ row, percent }) =>
    '<tr' + (percent !== null && percent >= majorThreshold ? ' class="major"' : '') + '><th scope="row">' + escaped(row.sku ?? '') +
    '</th><td>' + amount(row.previousCost, row.currency) + '</td><td>' + amount(row.newCost, row.currency) + '</td><td>' +
    amount(row.delta, row.currency) + '</td><td>' + (row.deltaPercent === null ? 'From zero' : escaped(row.deltaPercent) + '%') + '</td></tr>').join('\n');
  const stats = [
    ['Added SKUs', counts['added-sku']], ['Removed SKUs', counts['removed-sku']],
    ['Cost hikes', counts['cost-increased']], ['Cost drops', counts['cost-decreased']],
    ['Max hike', maxHikePercent === null ? '\u2014' : maxHikePercent + '%'],
  ];
  return brandSignoffHtml(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${offlineReportCsp}"><title>Supplier Delta Executive Sign-Off</title>
<style>
*{box-sizing:border-box}body{max-width:72rem;margin:auto;padding:clamp(1rem,4vw,3rem);color:#142527;background:#f4f7f6;font:1rem/1.5 system-ui,sans-serif}
h1{font-size:clamp(1.75rem,4vw,2.6rem);line-height:1.12;margin:0}h2{margin:0 0 .65rem}p{margin:.5rem 0 1rem}
header{border-top:.35rem solid #166052;padding-top:1.25rem}main,footer{margin-top:1.5rem}header,td,th,dd{overflow-wrap:anywhere}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.65rem;margin:1.25rem 0 2rem}
.summary div,footer,.review{padding:1rem;border:1px solid #9eafac;border-radius:.4rem;background:white}.summary dt{font-weight:600}.summary dd{margin:0;font-size:1.35rem;font-weight:750}
.table{overflow:auto;margin-top:.75rem}table{width:100%;border-collapse:collapse}th,td{padding:.55rem .65rem;text-align:left;border-bottom:1px solid #b7c6c4}
td{white-space:nowrap;font-variant-numeric:tabular-nums}thead{background:#e8f0ee}label{font-weight:600}
input{accent-color:#166052}input:focus-visible,.table:focus-visible{outline:3px solid #166052;outline-offset:3px}
#major-only{margin-inline-end:.65rem;vertical-align:middle}
#major-only:checked~.table tbody tr:not(.major){display:none}
#major-only:checked~.table tbody:not(:has(.major))~tfoot{display:table-footer-group}tfoot{display:none}
footer dl{margin:0}footer dt{margin-top:.55rem;font-weight:650}footer dd{margin:0}
</style></head>
<body><header><h1>Supplier Delta Executive Sign-Off</h1><p>Previous: ${sourceLabel(sources.previous)}<br>New: ${sourceLabel(sources.next)}</p></header>
<main><dl class="summary">${stats.map(([label, count]) => '<div><dt>' + label + '</dt><dd>' + count + '</dd></div>').join('')}</dl>
<section class="review"><h2 id="top-hikes">Top cost hikes</h2>
${hikes.length ? `<p>${hikes.length > detailLimit ? 'Showing the first ' + detailLimit + ' of ' + hikes.length + ' cost hikes. ' : ''}The CSV and JSON audit contain every SKU.</p>
<input id="major-only" type="checkbox"><label for="major-only">Show hikes of at least 10%</label>
<div class="table" role="region" aria-labelledby="top-hikes" tabindex="0"><table><thead><tr><th scope="col">SKU</th><th scope="col">Previous cost</th><th scope="col">New cost</th><th scope="col">Change</th><th scope="col">Change %</th></tr></thead><tbody>${body}</tbody><tfoot><tr><td colspan="5">No listed hikes reach 10%.</td></tr></tfoot></table></div>` :
    '<p>No cost hikes were found.</p>'}</section></main>
${custodyFooter([['Previous supplier source', custody.previousSha256], ['New supplier source', custody.newSha256], ['Supplier Delta CSV', custody.deltaCsvSha256]])}
</body></html>
`, branding);
}
