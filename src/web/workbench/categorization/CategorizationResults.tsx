import { categorizationFilenames } from '../../../core/accounting/categorization-rules';
import type { CategorizationIssue } from '../../../core/accounting/categorization-rules';
import { formatMinorUnits } from '../../../core/values';
import { CustodyFingerprints } from '../CustodyFingerprints';
import { downloadFile } from '../downloads';
import { Pagination, usePagination } from '../Pagination';
import type { CategorizationArtifact, CategorizationPreview } from './categorization.worker';

const COUNT = new Intl.NumberFormat('en-US');
const PERCENT = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
const DOWNLOADS = {
  categorizedCsv: { label: 'Download Categorized CSV', mime: 'text/csv;charset=utf-8' },
  accountSummaryCsv: { label: 'Download Account Summary CSV', mime: 'text/csv;charset=utf-8' },
  auditJson: { label: 'Download Audit JSON', mime: 'application/json;charset=utf-8' },
  signoffHtml: { label: 'Download Bookkeeper Categorization Sign-Off (.html)', mime: 'text/html;charset=utf-8' },
} as const satisfies Record<CategorizationArtifact, { label: string; mime: string }>;

function amount(cents: string) {
  return formatMinorUnits(BigInt(cents), 2);
}

export function IssueList({ issues }: { issues: readonly CategorizationIssue[] }) {
  return (
    <ul className="categorization-issues" aria-label="Categorization issues">
      {issues.map(({ line, code, column, message, matchingRuleIds, path, value }, index) => (
        <li key={index} data-issue-code={code}>
          {line === undefined ? null : <strong>Line {line}{column ? ` · ${column}` : ''} </strong>}
          {path ? <code>{path} </code> : null}{message}
          {value === undefined ? null : <span>Source value <code>{value || '(blank)'}</code></span>}
          {matchingRuleIds?.length ? <span>Matching rules <code>{matchingRuleIds.join(', ')}</code></span> : null}
        </li>
      ))}
    </ul>
  );
}

export function CategorizationResults({ result }: { result: CategorizationPreview }) {
  const { accountSummary, artifacts, custody, currencyTotals, metrics, issues, status } = result;
  const coverage = metrics.totalRows ? metrics.categorizedRows / metrics.totalRows : 0;
  const previewPage = usePagination(accountSummary.length);
  const issuePage = usePagination(issues.length);
  const inputs = [
    { field: 'categorization-source', label: 'Source CSV', sha256: custody.source.sha256, detail: custody.source.filename },
    { field: 'categorization-rule-pack', label: 'Rule pack JSON', sha256: custody.rulePack.sha256, detail: custody.rulePack.filename },
  ];

  return (
    <>
      <dl className="categorization-metrics" aria-label="Categorization coverage">
        <div><dt>Categorized %</dt><dd data-testid="categorization-coverage">{PERCENT.format(coverage)}</dd></div>
        <div><dt>Uncategorized Rows</dt><dd data-testid="categorization-uncategorized">{COUNT.format(metrics.uncategorizedRows)}</dd></div>
        <div><dt>Ambiguous Conflicts</dt><dd data-testid="categorization-ambiguous">{COUNT.format(metrics.ambiguousConflicts)}</dd></div>
      </dl>
      <progress value={coverage} max={1} aria-label="Share of transactions categorized" />
      <p className="field-help">{COUNT.format(metrics.categorizedRows)} of {COUNT.format(metrics.totalRows)} transactions categorized</p>

      <div className="categorization-taxes">
        <h4>Total Calculated Tax</h4>
        {currencyTotals.length ? (
          <dl data-testid="categorization-tax-totals">
            {currencyTotals.map(({ currency, taxCents }) => (
              <div key={currency ?? ''}><dt>{currency ?? 'Unspecified currency'}</dt><dd>{amount(taxCents)}</dd></div>
            ))}
          </dl>
        ) : <p className="field-help">No totals available for this file.</p>}
      </div>

      {issues.length ? (
        <div className="categorization-issue-section">
          <h4>Transaction review ({COUNT.format(issues.length)})</h4>
          <IssueList issues={issues.slice(issuePage.start, issuePage.end)} />
          <Pagination state={issuePage} total={issues.length} label="Categorization issues pagination" />
        </div>
      ) : null}

      {accountSummary.length ? (
        <div className="categorization-account-summary">
          <h4>Account Summary Preview</h4>
          <div className="table-scroll" role="region" aria-label="Scrollable account summary" tabIndex={0}>
            <table aria-label="Account Summary Preview" data-testid="categorization-summary">
              <thead><tr>
                <th scope="col" className="line-cell">Account / Tax code</th>
                <th scope="col">Currency</th><th scope="col">Rows</th><th scope="col">Gross</th><th scope="col">Net</th><th scope="col">Tax</th>
              </tr></thead>
              <tbody>{accountSummary.slice(previewPage.start, previewPage.end).map((row) => (
                <tr key={JSON.stringify([row.currency, row.accountCode, row.taxCode])}>
                  <th scope="row" className="line-cell">{row.accountCode ?? 'Uncategorized'}{row.taxCode ? ` / ${row.taxCode}` : ''}
                    {row.accountName ? <span>{row.accountName}</span> : null}</th>
                  <td>{row.currency ?? 'Unspecified'}</td><td>{COUNT.format(row.rowCount)}</td>
                  <td>{amount(row.grossCents)}</td><td>{amount(row.netCents)}</td><td>{amount(row.taxCents)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <Pagination state={previewPage} total={accountSummary.length} label="Account summary pagination" />
        </div>
      ) : null}

      <div className="categorization-exports">
        <h4>Categorization downloads</h4>
        {status === 'blocked' ? <p className="export-warning">The CSVs and offline sign-off are held. Download the audit for source evidence.</p> : null}
        <div className="export-buttons" role="group" aria-label="Categorization downloads">
          {(Object.keys(DOWNLOADS) as CategorizationArtifact[]).map((key) => (
            <button key={key} type="button" className={`button ${key === 'categorizedCsv' ? 'button-primary' : 'button-secondary'}`}
              disabled={!artifacts[key]} onClick={() => {
                const bytes = artifacts[key];
                if (bytes) downloadFile(categorizationFilenames[key], bytes, DOWNLOADS[key].mime);
              }}>{DOWNLOADS[key].label}</button>
          ))}
        </div>
      </div>
      <CustodyFingerprints entries={[...inputs, ...(custody.outputs ?? []).map(({ filename, sha256 }) => ({
        field: filename,
        label: filename,
        sha256,
      }))]} />
    </>
  );
}
