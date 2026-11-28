import { useCallback, useId, useState } from 'react';
import { PAGE_SIZE, Pagination, usePagination } from '../Pagination';
import { useWorkerPage } from '../useWorkerPage';
import { catalogCellEvidence } from './cellEvidence';
import type { CatalogHygieneArtifact, CatalogHygieneIssue, CatalogHygieneSummary, CatalogHygieneWorker } from './catalogHygieneWorker';

const NUMBER = new Intl.NumberFormat('en-US');
const METRICS = [
  ['scannedRows', 'Scanned Rows'],
  ['invalidBarcodes', 'Invalid Barcodes'],
  ['duplicateSkus', 'Duplicate SKUs'],
  ['safeTrimFixes', 'Safe Trim Fixes'],
] as const;
const DIAGNOSTIC_FILES = [
  ['issuesCsv', 'Download Hygiene Issues CSV'],
  ['auditJson', 'Download Audit JSON'],
  ['reportHtml', 'Download Branded Offline Hygiene Report (.html)'],
] as const;
const RELATED_PREVIEW_SIZE = 4;

function sourceLabel(index: number) {
  return index === 1 ? 'Primary catalog' : 'Secondary catalog';
}

function issueTypeLabel(code: string) {
  const label = code.replaceAll('-', ' ').replace(/\b(?:sku|gs1|gtin|csv|ean|upc)\b/g, (word) => word.toUpperCase());
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function SourceLine({ sourceIndex, line }: Pick<CatalogHygieneIssue, 'sourceIndex' | 'line'>) {
  return <>{sourceLabel(sourceIndex)}{line == null ? '' : ` · line ${line}`}</>;
}

function RelatedLines({ related, sources }: {
  related: NonNullable<CatalogHygieneIssue['related']>;
  sources: CatalogHygieneSummary['sources'];
}) {
  const [expanded, setExpanded] = useState(false);
  const render = (lines: typeof related) => (
    <ul className="catalog-hygiene-related">
      {lines.map((ref) => (
        <li key={`${ref.sourceIndex}-${ref.line}`}>
          <SourceLine {...ref} /> <span>({sources[ref.sourceIndex - 1]?.filename})</span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="catalog-hygiene-references">
      <p>Related source lines</p>
      {render(related.slice(0, RELATED_PREVIEW_SIZE))}
      {related.length > RELATED_PREVIEW_SIZE ? (
        <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary>Show {NUMBER.format(related.length - RELATED_PREVIEW_SIZE)} more related lines</summary>
          {expanded ? render(related.slice(RELATED_PREVIEW_SIZE)) : null}
        </details>
      ) : null}
    </div>
  );
}

function IssueCard({ issue, sources }: {
  issue: CatalogHygieneIssue;
  sources: CatalogHygieneSummary['sources'];
}) {
  const { code, level, sourceIndex, column, value, after, suppliedCheckDigit, expectedCheckDigit, related, message } = issue;
  const hasCell = typeof value === 'string';
  const hasAfter = after !== undefined;
  const badge = level === 'blocked' ? 'Blocking' : level === 'fixed' ? 'Fixed' : hasAfter ? 'Proposed fix' : 'Warning';
  const digitEvidence = expectedCheckDigit !== undefined && suppliedCheckDigit !== undefined;

  return (
    <li className="catalog-hygiene-issue" data-issue-code={code} data-level={level}>
      <div className="catalog-hygiene-issue-header">
        <strong><SourceLine {...issue} /></strong>
        <span className={`issue-badge ${level === 'fixed' ? 'badge-fixed' : 'badge-review'}`}>{badge}</span>
      </div>
      <p className="field-help catalog-hygiene-issue-source">
        <span>{sources[sourceIndex - 1]?.filename}</span>
        {column ? <code>{column}</code> : null}
      </p>
      <p>{message}</p>
      {hasCell || hasAfter || digitEvidence ? (
        <dl className="catalog-hygiene-evidence">
          {hasCell ? <div><dt>{hasAfter ? 'Before' : 'Source value'}</dt><dd><code>{catalogCellEvidence(value)}</code></dd></div> : null}
          {hasAfter ? <div><dt>After</dt><dd><code>{catalogCellEvidence(after)}</code></dd></div> : null}
          {digitEvidence ? <>
            <div><dt>Supplied check digit</dt><dd><code>{suppliedCheckDigit}</code></dd></div>
            <div><dt>Expected check digit</dt><dd><code>{expectedCheckDigit}</code></dd></div>
          </> : null}
        </dl>
      ) : null}
      {related?.length ? <RelatedLines related={related} sources={sources} /> : null}
      <code className="catalog-hygiene-issue-code">{code}</code>
    </li>
  );
}

function CatalogIssues({ worker, report }: { worker: CatalogHygieneWorker; report: CatalogHygieneSummary }) {
  const id = useId();
  const [code, setCode] = useState('');
  const total = code ? report.issueTypes.find((type) => type.code === code)?.count ?? 0 : report.issueCount;
  const page = usePagination(total);
  const read = useCallback(() => worker.request({ type: 'issues', code, page: page.page, pageSize: PAGE_SIZE }),
    [worker, code, page.page]);
  const issues = useWorkerPage(total ? read : null);

  return (
    <section aria-labelledby={id} className="catalog-hygiene-issues">
      <div className="catalog-hygiene-issues-header">
        <h3 id={id}>Catalog hygiene issues</h3>
        {report.issueCount ? (
          <div className="price-sheet">
            <label htmlFor={`${id}-filter`}>Filter catalog hygiene issues</label>
            <select id={`${id}-filter`} value={code} onChange={(event) => { setCode(event.currentTarget.value); page.setPage(0); }}>
              <option value="">All issue types ({NUMBER.format(report.issueCount)})</option>
              {report.issueTypes.map((type) => (
                <option key={type.code} value={type.code}>{issueTypeLabel(type.code)} ({NUMBER.format(type.count)})</option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      {total ? (
        <>
          {issues?.error ? <p className="file-message file-error" role="alert">{issues.error}</p> : issues?.page ? (
            <ul className="catalog-hygiene-issue-list">
              {issues.page.rows.map((issue, index) => (
                <IssueCard key={`${code}:${page.start + index}`} issue={issue} sources={report.sources} />
              ))}
            </ul>
          ) : <p className="field-help" role="status">Loading catalog issues…</p>}
          <Pagination state={page} total={total} label="Catalog hygiene issue pages" />
        </>
      ) : <p className="field-help">No catalog hygiene issues were found.</p>}
    </section>
  );
}

export function CatalogHygieneResults({ worker, report, onDownload }: {
  worker: CatalogHygieneWorker;
  report: CatalogHygieneSummary;
  onDownload: (artifact: CatalogHygieneArtifact) => void;
}) {
  const id = useId();
  const { summary, sources, status } = report;
  return (
    <section aria-labelledby={id} className="catalog-hygiene-results">
      <h3 id={id}>Catalog audit summary</h3>
      <dl className="verify-metrics catalog-hygiene-metrics" aria-label="Catalog hygiene totals">
        {METRICS.map(([key, label]) => (
          <div key={key}><dt>{label}</dt><dd data-testid={`catalog-hygiene-${key}`}>{NUMBER.format(summary[key])}</dd></div>
        ))}
      </dl>
      {summary.safeZeroWidthFixes ? <p className="field-help">Allowlisted zero-width fixes: {NUMBER.format(summary.safeZeroWidthFixes)}</p> : null}
      <div className="catalog-hygiene-downloads">
        <h3>Audit downloads</h3>
        <div className="export-buttons" role="group" aria-label="Catalog hygiene diagnostics">
          {DIAGNOSTIC_FILES.map(([kind, label]) => (
            <button key={kind} type="button" className="button button-secondary" onClick={() => onDownload({ kind })}>{label}</button>
          ))}
        </div>
      </div>
      {status === 'READY' ? <div className="catalog-hygiene-downloads">
        <h3>Cleaned catalog and rollback CSVs</h3>
        <div className="catalog-hygiene-pairs">
          {sources.map(({ sourceIndex, filename }) => (
            <div className="catalog-hygiene-pair" key={sourceIndex} role="group" aria-label={`${sourceLabel(sourceIndex)} CSV pair`}>
              <p className="catalog-hygiene-pair-source"><strong>{sourceLabel(sourceIndex)}</strong><span>{filename}</span></p>
              <div className="export-buttons">
                <button type="button" className="button button-primary" onClick={() => onDownload({ kind: 'cleanedCsv', sourceIndex })}>Download cleaned catalog CSV</button>
                <button type="button" className="button button-secondary" onClick={() => onDownload({ kind: 'rollbackCsv', sourceIndex })}>Download rollback CSV</button>
              </div>
            </div>
          ))}
        </div>
      </div> : null}
      <CatalogIssues worker={worker} report={report} />
    </section>
  );
}
