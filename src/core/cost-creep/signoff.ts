import { brandSignoffHtml, type SignoffBrand } from '../branding/signoff-brand';
import { custodyFooter, escapeReportText as escape, offlineReportCsp } from '../report-html';
import { costCreepSparkline } from './math';
import type { CostCreepCustody, CostCreepRow, CostCreepSummary } from './types';

// A meeting brief stays readable and printable. Full SKU and source histories accompany it in CSV and JSON.
const maxOffenders = 20;
const count = (value: number, unit: string) => value + ' ' + unit + (value === 1 ? '' : 's');

export function renderNegotiationBrief(rows: readonly CostCreepRow[], summary: CostCreepSummary, threshold: string,
  custody: CostCreepCustody, branding?: SignoffBrand): string {
  const { periods, retail, historyCsvSha256 } = custody;
  const displayRows = rows.filter(({ meetsThreshold }) => meetsThreshold).slice(0, maxOffenders);
  const omitted = summary.thresholdSkus - displayRows.length;
  const sections = displayRows.map((row) => {
    const sparkline = costCreepSparkline(row.observations).map((segment) =>
      (segment.length > 1 ? '<polyline points="' + segment.map(({ x, y }) => x + ',' + y).join(' ') + '"/>' : '') +
      segment.map(({ x, y }) => '<circle cx="' + x + '" cy="' + y + '" r="2.5"/>').join('')).join('');
    const snapshot = row.observations.map((observation, index) =>
      '<li><strong>' + escape(periods[index].label) + '</strong> ' + escape(observation?.cost ?? '—') + '</li>').join('');
    const margin = row.margin ? '<p><strong>Old → new gross margin</strong> ' + escape(row.margin.oldGrossMarginPercent) +
      '% → ' + escape(row.margin.newGrossMarginPercent) + '% (' + escape(row.margin.compressionPoints) + ' percentage points compression)</p>' : '';
    return '<article class="offender"><h3>' + escape(row.sku) + '</h3>' +
      '<p class="movement"><strong>' + escape(row.cumulativeDeltaPercent ?? '—') + '%</strong> · ' +
      escape(row.firstObservedCost) + ' → ' + escape(row.latestObservedCost) + (row.currency ? ' ' + escape(row.currency) : '') + '</p>' +
      '<p>' + escape(row.lifecycle.replace(/-/g, ' ')) + ' · ' + count(row.hikeCount, 'hike') + ' · ' + count(row.dropCount, 'drop') + ' · ' +
      row.consecutiveHikes + ' longest run · ' + escape(row.volatility) + ' cost spread</p>' +
      '<svg viewBox="0 0 160 48" role="img" aria-label="Supplier cost trend by period"><path d="M6 42H154"/>' + sparkline + '</svg>' +
      '<ul aria-label="Observed costs by period">' + snapshot + '</ul>' + margin + '</article>';
  });
  const metrics = [
    ['Tracked SKUs', summary.trackedSkus.toString()], ['SKUs at or above threshold', summary.thresholdSkus.toString()],
    ['Worst cumulative hike', summary.worstCumulativeHikePercent === null ? '—' : summary.worstCumulativeHikePercent + '%'],
    ['SKUs with consecutive hikes', summary.consecutiveMultiHikeSkus.toString()],
  ].map(([label, value]) => '<div><dt>' + escape(label) + '</dt><dd>' + escape(value) + '</dd></div>').join('');
  const sources = periods.map(({ label, filename, selectedSheet }) =>
    '<li><strong>' + escape(label) + '</strong> <span>' + escape(filename) +
    (selectedSheet === null ? '' : ' · ' + escape(selectedSheet)) + '</span></li>').join('');
  const fingerprints = [
    ...periods.map(({ label, sha256 }) => [label + ' source bytes', sha256] as const),
    ...(retail ? [[retail.filename + ' source bytes', retail.sha256] as const] : []),
    ['Supplier cost-creep history CSV', historyCsvSha256] as const,
  ];
  const overflow = omitted > 0 ? '<p>' + omitted + ' additional threshold matches appear in the full history CSV and audit JSON.</p>' : '';
  const document = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="' + offlineReportCsp + '"><title>Vendor Negotiation Brief</title><style>' +
    ':root{font:100% system-ui,sans-serif;color:#182939;background:#f2f5f6}body{max-width:70rem;margin:0 auto;padding:clamp(1rem,4vw,3rem);overflow-wrap:anywhere}' +
    'h1,h2,h3,p,dd{margin:0}h1{font-size:clamp(1.85rem,5vw,3rem);line-height:1.14}h2{margin:1.55rem 0 .65rem;font-size:1.35rem}h3{font-size:1.08rem}' +
    'p,header>p{margin:.55rem 0;line-height:1.55}header{background:#1a365d;color:#fff;border-radius:.65rem;padding:clamp(1rem,4vw,2rem)}' +
    '.summary,.offenders{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:.65rem}' +
    '.summary div,.offender,footer{padding:1rem;background:white;border:1px solid #c0ccd6;border-radius:.55rem}dt{font-weight:650}.summary dd{font-size:1.45rem}' +
    '.offenders{grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr))}.movement strong{color:#913b16;font-size:1.4rem}' +
    '.offender svg{display:block;width:100%;max-width:18rem;height:auto;color:#1a664b}.offender polyline{fill:none;stroke:currentColor;stroke-width:2}.offender circle{fill:currentColor}' +
    '.offender path{stroke:#c0ccd6}.offender ul{display:flex;flex-wrap:wrap;gap:.35rem .8rem;padding:0;margin:.45rem 0;list-style:none}.inputs{padding-left:1.25rem}' +
    'footer{margin-top:1.75rem}footer h2{margin-top:0}footer dd{margin:.2rem 0 .65rem}code{overflow-wrap:anywhere}' +
    '@media print{:root{background:#fff}body{padding:0}header{background:#fff;color:#182939;border-bottom:2px solid #182939}.offender{break-inside:avoid}}' +
    '</style></head><body><header><h1>Vendor Negotiation Brief</h1><p>Multi-period supplier cost creep · Threshold ≥ ' + escape(threshold) + '%</p></header>' +
    '<main><dl class="summary">' + metrics + '</dl><section><h2>Top Cost-Creep Offenders</h2>' +
    '<p>Cumulative change compares the first and last observed costs. Ranking and threshold checks use exact values before display rounding. Missing periods break a run of hikes. Cost spread is the highest observed cost minus the lowest.</p>' +
    (sections.length ? '<div class="offenders">' + sections.join('') + '</div>' : '<p>No SKUs meet the threshold.</p>') + overflow +
    '</section><section><h2>Sources in period order</h2><ol class="inputs">' + sources + '</ol>' +
    '<p>Bare supplier amounts use common units. Gross margin holds the matched retail price constant and requires positive retail with evidence of the same denomination. This brief does not change store prices.</p>' +
    '</section></main>' + custodyFooter(fingerprints) + '</body></html>';
  // User text can display a URL, while the source contains neither a URL scheme nor a protocol-relative prefix.
  return brandSignoffHtml(document, branding).replaceAll('//', '&#47;/');
}
