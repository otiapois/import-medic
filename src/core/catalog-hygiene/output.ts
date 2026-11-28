import { sha256 } from '../audit/custody';
import { brandSignoffHtml } from '../branding/signoff-brand';
import { decodeCsv, parseCsv, serializeCsvRecords } from '../csv';
import { guardSpreadsheetCell } from '../formula-guard';
import { custodyFooter, escapeReportText, offlineReportCsp } from '../report-html';
import type { CatalogTable } from './source';
import type {
  CatalogHygieneArtifact, CatalogHygieneIssue, CatalogHygieneOptions, CatalogHygieneResult, CatalogHygieneSource,
  CatalogHygieneSourceResult, CatalogHygieneSummary,
} from './types';

const utf8 = new TextEncoder();
const artifact = (filename: string, text: string): CatalogHygieneArtifact => ({ filename, bytes: utf8.encode(text) });
const printable = (text: string) => text.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f\p{Cf}]/gu, character => {
  const hex = character.codePointAt(0)!.toString(16);
  return character.length === 1 ? '\\u' + hex.padStart(4, '0') : '\\u{' + hex + '}';
});

export async function fingerprint({ filename, bytes }: CatalogHygieneArtifact) {
  return { filename, byteLength: bytes.byteLength, sha256: await sha256(bytes) };
}

export function verifiedCatalog(source: CatalogHygieneSource, table: CatalogTable,
  changes: ReadonlyMap<number, ReadonlyMap<number, string>>, sourceIndex: number) {
  const expected = table.records.map(({ cells, line }) => cells.map((cell, index) => changes.get(line)?.get(index) ?? cell));
  const shopify = source.platform === 'shopify';
  const platform = shopify ? 'shopify-products' : source.platform;
  const stem = 'catalog-hygiene-source-' + sourceIndex;
  const cleanedCsv = artifact(stem + '-cleaned.csv', serializeCsvRecords(expected, platform) + (shopify ? '\n' : '\r\n'));
  const parsed = parseCsv(decodeCsv(cleanedCsv.bytes).text).records;
  if (parsed.length !== expected.length || parsed.some(({ cells, line, parseError }, index) => {
    const row = expected[index];
    return parseError || line !== table.records[index].line || cells.length !== row.length ||
      cells.some((cell, column) => cell !== row[column]);
  })) return null;
  return { sourceIndex, cleanedCsv, rollbackCsv: { filename: stem + '-rollback.csv', bytes: new Uint8Array(source.bytes) } };
}

function issueCsv(issues: readonly CatalogHygieneIssue[], sources: readonly CatalogHygieneSourceResult[]) {
  const headers = ['Source', 'Filename', 'Physical line', 'Column', 'Severity', 'Code', 'Value', 'Proposed value',
    'Expected check digit', 'Supplied check digit', 'Related source:line', 'Message'];
  const rows = issues.map(issue => [
    String(issue.sourceIndex), sources[issue.sourceIndex - 1].filename, String(issue.line ?? ''), issue.column ?? '',
    issue.level, issue.code, issue.value ?? '', issue.after ?? '', issue.expectedCheckDigit ?? '', issue.suppliedCheckDigit ?? '',
    issue.related?.map(({ sourceIndex, line }) => sourceIndex + ':' + line).join(', ') ?? '', issue.message,
  ].map(value => printable(guardSpreadsheetCell(value))));
  return artifact('catalog-hygiene-issues.csv', serializeCsvRecords([headers, ...rows], 'catalog-hygiene') + '\r\n');
}

const escape = (value: string) => escapeReportText(printable(value));
function report(status: CatalogHygieneResult['status'], summary: CatalogHygieneSummary,
  sources: readonly CatalogHygieneSourceResult[], issues: readonly CatalogHygieneIssue[],
  files: Parameters<typeof custodyFooter>[0], branding: CatalogHygieneOptions['branding']) {
  const evidence = issues.map(({ sourceIndex, line, column, level, code, value, after, expectedCheckDigit, suppliedCheckDigit, related, message }) =>
    '<li><strong>' + escape(message) + '</strong><div>Source ' + sourceIndex + (line === null ? '' : ', physical line ' + line) +
    (column === null ? '' : ' · ' + escape(column)) + ' · ' + escape(level) + ' · <code>' + escape(code) + '</code></div>' +
    (value === null ? '' : '<div>Source value <code>' + escape(value) + '</code></div>') +
    (after === undefined ? '' : '<div>' + (level === 'fixed' ? 'Cleaned value' : 'Proposed value') + ' <code>' + escape(after) + '</code></div>') +
    (expectedCheckDigit === undefined ? '' : '<div>Expected check digit <b>' + escape(expectedCheckDigit) +
      '</b> · Supplied <b>' + escape(suppliedCheckDigit ?? '') + '</b></div>') +
    (related?.length ? '<div>Related ' + related.map(ref => 'source ' + ref.sourceIndex + ', line ' + ref.line).join(' · ') + '</div>' : '') + '</li>');
  const content = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="' +
    offlineReportCsp + '"><title>Catalog &amp; Barcode Hygiene Report</title><style>' +
    '*{box-sizing:border-box}body{margin:1rem;font:1rem/1.55 system-ui,sans-serif;color:#16271d;background:#f5f7f3;overflow-wrap:anywhere}' +
    'main{max-width:1120px;margin:auto;padding:clamp(1rem,4vw,2rem);background:#fff;border:1px solid #bcc9bd;border-radius:.5rem}' +
    'h1,h2{line-height:1.15}h1{margin-top:0}dt{font-weight:700}dd{margin:0 0 .5rem}code{white-space:pre-wrap}' +
    'li{margin:.65rem 0}footer{border-top:1px solid #bcc9bd;margin-top:2rem}' +
    '@media print{body{margin:0;background:#fff}main{max-width:none;border:0}li{break-inside:avoid}}</style></head><body><main>' +
    '<h1>Catalog &amp; Barcode Hygiene Report</h1><p><strong>' + status + '</strong> · ' +
    (status === 'READY' ? 'Catalog files passed local checks. Review the destination store’s import and matching rules before any live changes.' :
      'Cleaned and rollback files are held until the blocking findings are resolved.') +
    '</p><dl><dt>Scanned rows</dt><dd>' + summary.scannedRows + '</dd><dt>Invalid barcodes</dt><dd>' + summary.invalidBarcodes +
    '</dd><dt>Duplicate SKUs</dt><dd>' + summary.duplicateSkus + '</dd><dt>Safe trim fixes</dt><dd>' + summary.safeTrimFixes +
    '</dd><dt>Safe zero-width fixes</dt><dd>' + summary.safeZeroWidthFixes + '</dd><dt>Blocking issues</dt><dd>' + summary.blockingIssues +
    '</dd></dl><h2>Catalog sources</h2><ol>' + sources.map(({ filename, platform, rows }) =>
      '<li><strong>' + escape(filename) + '</strong> · ' + escape(platform) + ' · ' + rows + ' rows</li>').join('') +
    '</ol><h2>Audit findings</h2>' + (evidence.length ? '<ul>' + evidence.join('') + '</ul>' : '<p>No issues found.</p>') +
    custodyFooter(files) + '</main></body></html>';
  return artifact('catalog-hygiene-report.html', brandSignoffHtml(content, branding).replace(/\/\//g, '&#47;/'));
}

export async function catalogReports(status: CatalogHygieneResult['status'], summary: CatalogHygieneSummary,
  sources: CatalogHygieneSourceResult[], issues: CatalogHygieneIssue[], catalogs: CatalogHygieneResult['artifacts']['catalogs'],
  options: CatalogHygieneOptions): Promise<CatalogHygieneResult['artifacts']> {
  const issuesCsv = issueCsv(issues, sources);
  const [issuesFingerprint, workspaceProfile, ...nativeFingerprints] = await Promise.all([
    fingerprint(issuesCsv), options.workspaceProfile ? fingerprint(options.workspaceProfile) : undefined,
    ...catalogs.flatMap(({ cleanedCsv, rollbackCsv }) => [fingerprint(cleanedCsv), fingerprint(rollbackCsv)]),
  ]);
  const fileHashes: Parameters<typeof custodyFooter>[0] = [
    ...sources.map(({ sourceIndex, filename, sha256 }) => ['Source ' + sourceIndex + ' · ' + filename, sha256] as const),
    ...(workspaceProfile ? [[workspaceProfile.filename, workspaceProfile.sha256] as const] : []),
    ...[issuesFingerprint, ...nativeFingerprints].map(({ filename, sha256 }) => [filename, sha256] as const),
  ];
  const reportHtml = report(status, summary, sources, issues, fileHashes, options.branding);
  const auditJson = artifact('catalog-hygiene-audit.json', JSON.stringify({
    version: 1, status, summary, options: { trimSkus: options.trimSkus === true, stripZeroWidth: options.stripZeroWidth === true },
    sources, issues, custody: {
      ...(workspaceProfile ? { workspaceProfile } : {}),
      outputs: [issuesFingerprint, await fingerprint(reportHtml), ...nativeFingerprints],
    },
  }, null, 2) + '\n');
  return { issuesCsv, auditJson, reportHtml, catalogs };
}
