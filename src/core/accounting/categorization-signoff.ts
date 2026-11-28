import { brandSignoffHtml, type SignoffBrand } from '../branding/signoff-brand';
import { custodyFooter, escapeReportText as escape, offlineReportCsp } from '../report-html';
import { formatMinorUnits } from '../values';
import type { CategorizationResult } from './categorization-rules';

type SignoffData = Pick<CategorizationResult, 'metrics' | 'rows' | 'accountSummary' | 'currencyTotals' | 'custody'>;
const cents = (value: string) => formatMinorUnits(BigInt(value), 2);
const currencyLabel = (value: string | null) => escape(value ?? 'Unspecified currency');
const sampleSize = 20;

export function renderCategorizationSignoff({ metrics, rows, accountSummary, currencyTotals, custody }: SignoffData,
  csvDigests: readonly { filename: string; sha256: string }[], conflictPolicy: string, branding?: SignoffBrand): string {
  const currencies = currencyTotals.map(({ currency, grossCents, netCents, taxCents, rowCount }) =>
    `<tr><th scope="row">${currencyLabel(currency)}</th><td>${rowCount}</td><td>${cents(grossCents)}</td><td>${cents(netCents)}</td><td>${cents(taxCents)}</td></tr>`).join('\n');
  const categories = accountSummary.map(({ currency, accountCode, accountName, taxCode, grossCents, netCents, taxCents, rowCount }) =>
    `<tr><th scope="row">${currencyLabel(currency)}</th><td>${escape(accountCode ?? 'Uncategorized')}</td><td>${escape(accountName ?? '—')}</td><td>${escape(taxCode ?? '—')}</td><td>${rowCount}</td><td>${cents(grossCents)}</td><td>${cents(netCents)}</td><td>${cents(taxCents)}</td></tr>`).join('\n');
  const sample = rows.slice(0, sampleSize).map(({ line, matchText, matchedRuleId, currency, grossCents, netCents, taxCents }) =>
    `<tr><th scope="row">${line}</th><td>${escape(matchText.filter(Boolean).join(' · '))}</td><td>${escape(matchedRuleId ?? 'Uncategorized')}</td><td>${currencyLabel(currency)}</td><td>${cents(grossCents!)}</td><td>${cents(netCents!)}</td><td>${cents(taxCents!)}</td></tr>`).join('\n');
  const fingerprints = [
    [`Transaction CSV · ${custody.source.filename}`, custody.source.sha256] as const,
    [`Rule Pack · ${custody.rulePack.filename}`, custody.rulePack.sha256] as const,
    ...(custody.workspaceProfile ? [[`Workspace Profile · ${custody.workspaceProfile.filename}`, custody.workspaceProfile.sha256] as const] : []),
    ...csvDigests.map(({ filename, sha256 }) => [filename, sha256] as const),
  ];
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${offlineReportCsp}"><title>Bookkeeper Categorization Sign-Off</title>
<style>
*{box-sizing:border-box}body{max-width:72rem;margin:auto;padding:clamp(1rem,4vw,3rem);color:#162b2a;background:#f2f7f6;font:1rem/1.5 system-ui,sans-serif;overflow-wrap:anywhere}
header{padding:1rem 0;border-top:.35rem solid #175a4d}h1{margin:0;font-size:clamp(1.75rem,5vw,2.8rem);line-height:1.15}h2{margin:0 0 .6rem;font-size:1.2rem}p{margin:.5rem 0}
section,footer{margin-top:1rem;border:1px solid #809d97;border-radius:.45rem;padding:1rem;background:white}
.table-scroll{overflow:auto}.table-scroll:focus-visible{outline:3px solid #175a4d;outline-offset:2px}table{width:100%;border-collapse:collapse}
th,td{text-align:left;vertical-align:top;padding:.45rem .5rem;border-bottom:1px solid #b7cbc5}thead{background:#e7f1ee}td:nth-last-child(-n+3){white-space:nowrap;font-variant-numeric:tabular-nums}tbody th{white-space:nowrap}dt{font-weight:650;margin-top:.55rem}dd{margin:0}
@media screen and (max-width:42rem){table{min-width:28rem}table.wide{min-width:41rem}}
@media print{body{padding:0;background:white}section,footer{border:0;padding:0}.table-scroll{overflow:visible}tr{break-inside:avoid}}
</style></head><body><header><h1>Bookkeeper Categorization Sign-Off</h1>
<p>${metrics.categorizedRows} of ${metrics.totalRows} transactions categorized · ${metrics.uncategorizedRows} uncategorized · ${metrics.ambiguousConflicts} ambiguous conflicts</p>
<p>Rule policy <strong>${escape(conflictPolicy)}</strong></p></header>
<main><section aria-labelledby="currency-heading"><h2 id="currency-heading">Totals by currency</h2>
<div class="table-scroll" tabindex="0" role="region" aria-labelledby="currency-heading"><table><thead><tr><th scope="col">Currency</th><th scope="col">Rows</th><th scope="col">Gross</th><th scope="col">Calculated Net</th><th scope="col">Calculated Tax</th></tr></thead><tbody>${currencies}</tbody></table></div></section>
<section aria-labelledby="accounts-heading"><h2 id="accounts-heading">Account and tax totals</h2>
<div class="table-scroll" tabindex="0" role="region" aria-labelledby="accounts-heading"><table class="wide"><thead><tr><th scope="col">Currency</th><th scope="col">Account Code</th><th scope="col">Account Name</th><th scope="col">Tax Code</th><th scope="col">Rows</th><th scope="col">Gross</th><th scope="col">Calculated Net</th><th scope="col">Calculated Tax</th></tr></thead><tbody>${categories}</tbody></table></div></section>
<section aria-labelledby="transactions-heading"><h2 id="transactions-heading">${rows.length > sampleSize ? `First ${sampleSize} transactions` : 'Transactions'}</h2>
<div class="table-scroll" tabindex="0" role="region" aria-labelledby="transactions-heading"><table class="wide"><thead><tr><th scope="col">Source line</th><th scope="col">Description / Payee</th><th scope="col">Matched Rule</th><th scope="col">Currency</th><th scope="col">Gross</th><th scope="col">Calculated Net</th><th scope="col">Calculated Tax</th></tr></thead><tbody>${sample}</tbody></table></div>
${rows.length > sampleSize ? '<p>The categorized CSV and JSON audit contain all transaction rows.</p>' : ''}</section></main>
${custodyFooter(fingerprints)}</body></html>`;
  return brandSignoffHtml(html, branding).replaceAll('//', '&#47;/');
}
