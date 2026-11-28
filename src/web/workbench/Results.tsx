import { lazy, Suspense, useCallback, useId, useRef, useState } from 'react';
import type { WorkbenchWorker } from '../../core/worker/client';
import type { RepairSummary } from '../../core/worker/protocol';
import type { RepairIssue } from '../../core/types';
import { BalanceAudit } from './BalanceAudit';
import { ExportActions, Inquiry } from './downloads';
import type { RepairDownload } from './downloads';
import { PAGE_SIZE, Pagination, pagination, usePagination } from './Pagination';
import { TabBar } from './TabBar';
import { useWorkerPage } from './useWorkerPage';

const Preview = lazy(() => import('./Preview').then(({ Preview }) => ({ default: Preview })));

const RESULT_TABS = [
  { id: 'issues', label: 'Issues & Review' },
  { id: 'preview', label: 'Before / After Table' },
  { id: 'removed', label: 'Removed Rows' },
] as const;

type ResultsTab = (typeof RESULT_TABS)[number]['id'];
type IssueFilter = 'all' | 'review' | 'fixed';

const ENCODINGS = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 BOM',
  'windows-1252': 'Windows-1252',
  'utf-16le': 'UTF-16LE',
  unknown: 'Unknown encoding',
};

interface ResultPage {
  worker: WorkbenchWorker;
  result: RepairSummary;
  current: boolean;
}

export function Results({ result, worker, current, busy, guardEnabled, onEdit, onGuard, onDownload }: ResultPage & {
  busy: boolean;
  guardEnabled: boolean;
  onEdit: (issue: RepairIssue, value: string) => void;
  onGuard: (value: boolean) => void;
  onDownload: (format: RepairDownload) => void;
}) {
  const id = useId();
  const [tab, setTab] = useState<ResultsTab>('issues');
  const [filter, setFilter] = useState<IssueFilter>('all');
  const [saveMessage, setSaveMessage] = useState('');
  const reviewHeading = useRef<HTMLHeadingElement>(null);

  function saveEdit(issue: RepairIssue, value: string) {
    reviewHeading.current?.focus();
    onEdit(issue, value);
    setSaveMessage(`Line ${issue.row}, ${issue.column} saved. Updating review.`);
  }

  return (
    <>
      <section className="workbench-results" aria-labelledby={`${id}-heading`}>
        <div className="results-heading">
          <div>
            <h2 id={`${id}-heading`}>Repair results</h2>
            <p className="result-filename">{result.filename}</p>
          </div>
          <p className="result-format">{ENCODINGS[result.detectedEncoding]} <span aria-hidden="true">/</span> {result.detectedLineEnding === 'mixed' ? 'Mixed line endings' : result.detectedLineEnding.toUpperCase()}</p>
        </div>
        {current ? (
          <dl className="summary-grid repair-summary" aria-live="polite">
            <div><dt>Total rows</dt><dd>{(result.rowCount + result.removedRowCount).toLocaleString('en-US')}</dd></div>
            <div><dt>Auto-fixed issues</dt><dd className="count-fixed" data-testid="auto-fixed-count">{result.fixed.toLocaleString('en-US')}</dd></div>
            <div><dt>Manually edited</dt><dd data-testid="manually-edited-count">{result.manuallyEdited.toLocaleString('en-US')}</dd></div>
            <div><dt>Needs manual review</dt><dd className={result.needsManualReviewCount ? 'count-review' : ''} data-testid="manual-review-count">{result.needsManualReviewCount.toLocaleString('en-US')}</dd></div>
            <div><dt>Removed rows</dt><dd>{result.removedRowCount.toLocaleString('en-US')}</dd></div>
          </dl>
        ) : null}
        {current && (result.balanceChain || result.platform === 'xero-bank') ? <BalanceAudit chain={result.balanceChain} /> : null}
        <TabBar id={id} label="Repair results views" items={RESULT_TABS} active={tab} onChange={setTab} className="result-tabs" />
        {RESULT_TABS.map((item) => (
          <div key={item.id} role="tabpanel" id={`${id}-${item.id}-panel`} aria-labelledby={`${id}-${item.id}-tab`} tabIndex={0} className="result-panel" hidden={tab !== item.id}>
            {tab === item.id && item.id === 'issues' ? (
              <>
                <div className="panel-heading">
                  <h3 ref={reviewHeading} tabIndex={-1}>Inspect each issue</h3>
                  <label className="filter-label">
                    Filter issues
                    <select value={filter} onChange={(event) => setFilter(event.currentTarget.value as IssueFilter)}>
                      <option value="all">All issues</option>
                      <option value="review">Needs review</option>
                      <option value="fixed">Auto-fixed</option>
                    </select>
                  </label>
                </div>
                <p className="sr-only" role="status">{saveMessage}</p>
                {current && result.currencySplit?.length ? <CurrencySplit groups={result.currencySplit} platform={result.platform} /> : null}
                {current && (result.duplicateTransactions || result.taxReconciliation) ? <BookkeeperChecks result={result} /> : null}
                <ReviewList key={filter} worker={worker} result={result} current={current} filter={filter} onEdit={saveEdit} />
              </>
            ) : null}
            {tab === item.id && item.id === 'preview' ? (
              <Suspense fallback={<p role="status">Opening preview…</p>}>
                <Preview worker={worker} result={result} current={current} />
              </Suspense>
            ) : null}
            {tab === item.id && item.id === 'removed' ? <RemovedRows worker={worker} result={result} current={current} /> : null}
          </div>
        ))}
        <ExportActions result={result} current={current} busy={busy} guardEnabled={guardEnabled} onGuard={onGuard} onDownload={onDownload} />
      </section>
      <Inquiry />
    </>
  );
}

function BookkeeperChecks({ result: { duplicateTransactions, taxReconciliation } }: { result: RepairSummary }) {
  const id = useId();
  const taxVerified = taxReconciliation?.status === 'VERIFIED';
  return (
    <div className="bookkeeper-checks">
      {duplicateTransactions ? (
        <section aria-labelledby={`${id}-duplicate`} data-testid="duplicate-transaction-alerts">
          <header>
            <h4 id={`${id}-duplicate`}>Duplicate Transaction Alerts</h4>
            <strong className={`issue-badge ${duplicateTransactions.groupCount ? 'badge-review' : 'badge-fixed'}`}>
              {duplicateTransactions.groupCount ? 'Needs review' : 'No exact duplicates'}
            </strong>
          </header>
          {duplicateTransactions.groupCount ? <p className="field-help">
            {duplicateTransactions.groupCount.toLocaleString('en-US')} duplicate {duplicateTransactions.groupCount === 1 ? 'group' : 'groups'} · {duplicateTransactions.affectedRows.toLocaleString('en-US')} affected source lines.
          </p> : null}
        </section>
      ) : null}
      {taxReconciliation ? (
        <section aria-labelledby={`${id}-tax`} data-testid="tax-reconciliation" data-tax-status={taxReconciliation.status}>
          <header>
            <h4 id={`${id}-tax`}>Tax Reconciliation (Net + Tax == Gross)</h4>
            <strong className={`issue-badge ${taxVerified ? 'badge-fixed' : 'badge-review'}`}>
              {taxVerified ? 'Verified' : taxReconciliation.mismatchCount ? 'Mismatch found' : 'Unverifiable'}
            </strong>
          </header>
          <p className="field-help">
            {taxReconciliation.checkedRows.toLocaleString('en-US')} {taxReconciliation.checkedRows === 1 ? 'row' : 'rows'} checked in exact cents.
            {taxReconciliation.mismatchCount ? ` ${taxReconciliation.mismatchCount.toLocaleString('en-US')} ${taxReconciliation.mismatchCount === 1 ? 'mismatch' : 'mismatches'}.` : ''}
            {taxReconciliation.unverifiableCount ? ` ${taxReconciliation.unverifiableCount.toLocaleString('en-US')} unverifiable.` : ''}
          </p>
        </section>
      ) : null}
    </div>
  );
}

function CurrencySplit({ groups, platform }: {
  groups: NonNullable<RepairSummary['currencySplit']>;
  platform: RepairSummary['platform'];
}) {
  const id = useId();
  const page = usePagination(groups.length);
  const destination = platform === 'freshbooks-expenses' ? 'FreshBooks' : platform === 'xero-bank' ? 'Xero' : 'QuickBooks';
  return (
    <section className="currency-split" aria-label="Currency split">
      <h4>Mixed currencies block {destination} export</h4>
      <p>{platform === 'freshbooks-expenses' ? 'Use a separate CSV for each currency and confirm it matches the account currency.' : 'Use a separate bank CSV for each currency.'}</p>
      <ul>
        {groups.slice(page.start, page.end).map(({ currency, lines }) => (
          <li key={currency} data-currency={currency}>
            <CurrencySourceLines currency={currency} lines={lines} group={id} />
          </li>
        ))}
      </ul>
      <Pagination state={page} total={groups.length} label="Currency group pages" />
    </section>
  );
}

function CurrencySourceLines({ currency, lines, group }: { currency: string; lines: readonly number[]; group: string }) {
  const [open, setOpen] = useState(false);
  const page = usePagination(lines.length);
  return (
    <details name={group} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{currency} · {lines.length.toLocaleString('en-US')} {lines.length === 1 ? 'line' : 'lines'}</summary>
      {open ? (
        <div>
          <p>Source lines <code data-testid="currency-source-lines">{lines.slice(page.start, page.end).join(', ')}</code></p>
          <Pagination state={page} total={lines.length} label={`Source line pages for ${currency}`} />
        </div>
      ) : null}
    </details>
  );
}

function ReviewList({ worker, result, current, filter, onEdit }: ResultPage & {
  filter: IssueFilter;
  onEdit: (issue: RepairIssue, value: string) => void;
}) {
  const [requestedPage, setPage] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const total = filter === 'all' ? result.issueCount : filter === 'fixed' ? result.fixed : result.issueCount - result.fixed;
  const page = pagination(total, requestedPage, setPage);
  const read = useCallback(() => worker.request({ type: 'repairIssues', filter, page: page.page, pageSize: PAGE_SIZE }), [worker, result, filter, page.page]);
  const data = useWorkerPage(current && total ? read : null);
  if (!current) return <p className="empty-panel">Review refreshes after processing finishes.</p>;
  if (!total) return <p className="empty-panel">{filter === 'all' ? 'No issues detected.' : 'No issues match this filter.'}</p>;
  return (
    <>
      {data?.error ? <p role="alert">{data.error}</p> : null}
      {data?.page ? (
        <ul className="issue-list">
          {data.page.rows.map((issue) => (
            <IssueItem
              key={issue.id}
              issue={issue}
              editing={editing === issue.id}
              onStart={() => setEditing(issue.id)}
              onCancel={() => setEditing(null)}
              onSave={(value) => {
                onEdit(issue, value);
                setEditing(null);
              }}
            />
          ))}
        </ul>
      ) : null}
      <Pagination state={page} total={total} />
    </>
  );
}

function IssueItem({
  issue,
  editing,
  onStart,
  onCancel,
  onSave,
}: {
  issue: RepairIssue;
  editing: boolean;
  onStart: () => void;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const titleElement = useRef<HTMLHeadingElement>(null);
  const title = `Line ${issue.row} · ${issue.column}`;
  const rulePath = issue.ruleDocSlug.startsWith('/fix/') ? issue.ruleDocSlug : null;
  const { reconciliation, taxReconciliation, relatedLines } = issue;
  return (
    <li className="issue-item" aria-label={title} data-issue-code={issue.code} data-source-row={issue.row}>
      <div className="issue-main">
        <div className="issue-title">
          <h4 ref={titleElement} tabIndex={-1}>{title}</h4>
          <span className={issue.autoFixed ? 'issue-badge badge-fixed' : 'issue-badge badge-review'}>
            {issue.autoFixed ? 'Auto-fixed' : issue.severity === 'error' ? 'Needs review' : 'Warning'}
          </span>
        </div>
        <p>{issue.message}</p>
        {reconciliation ? (
          <dl className="reconciliation-details" data-testid="reconciliation-details" aria-label="Reconciliation mismatch">
            <div><dt>Gross</dt><dd><code>{reconciliation.gross}</code></dd></div>
            <div><dt>Fee</dt><dd><code>{reconciliation.fee}</code></dd></div>
            <div><dt>Net</dt><dd><code>{reconciliation.net}</code></dd></div>
            <div>
              <dt>Expected Net</dt>
              <dd><code>{reconciliation.expectedNet}</code> <span>Gross {reconciliation.feeConvention === 'deduction' ? '−' : '+'} Fee</span></dd>
            </div>
          </dl>
        ) : null}
        {taxReconciliation ? (
          <dl className="reconciliation-details" data-testid="tax-reconciliation-details" aria-label="Tax reconciliation mismatch">
            <div><dt>Net</dt><dd><code>{taxReconciliation.net}</code></dd></div>
            <div><dt>Tax</dt><dd><code>{taxReconciliation.tax}</code></dd></div>
            <div><dt>Gross</dt><dd><code>{taxReconciliation.gross}</code></dd></div>
            <div><dt>Expected Gross</dt><dd><code>{taxReconciliation.expectedGross}</code></dd></div>
            <div><dt>Gross discrepancy</dt><dd><code>{taxReconciliation.delta}</code></dd></div>
          </dl>
        ) : null}
        {relatedLines?.length ? (
          <p className="duplicate-source-lines" data-testid="duplicate-source-lines">
            <strong>Matching source lines</strong> <code>{[issue.row, ...relatedLines].sort((left, right) => left - right).join(', ')}</code>
          </p>
        ) : null}
        <div className="cell-pair">
          <div><span>Before</span><code>{issue.rawValue || '(empty)'}</code></div>
          {issue.fixedValue !== undefined ? (
            <div><span>After</span><code>{issue.fixedValue || '(empty)'}</code></div>
          ) : null}
        </div>
      </div>
      <div className="issue-actions">
        {issue.editable && !issue.autoFixed && !editing ? (
          <button className="button button-secondary button-small" type="button" onClick={onStart}>Edit</button>
        ) : null}
        {rulePath ? (
          <a href={rulePath} target="_blank" rel="noopener">Rule details<span className="sr-only"> (opens in a new tab)</span></a>
        ) : null}
      </div>
      {editing ? <CellEditor key={issue.rawValue} value={issue.rawValue} onCancel={() => {
        titleElement.current?.focus();
        onCancel();
      }} onSave={onSave} /> : null}
    </li>
  );
}

function CellEditor({ value, onCancel, onSave }: { value: string; onCancel: () => void; onSave: (value: string) => void }) {
  const [edited, setEdited] = useState(value);
  return (
    <form className="cell-editor" onSubmit={(event) => {
      event.preventDefault();
      onSave(edited);
    }}>
      <label>Corrected value
        <textarea rows={1} autoFocus value={edited} onChange={(event) => setEdited(event.currentTarget.value)} />
      </label>
      <button className="button button-primary button-small" type="submit">Save</button>
      <button className="button button-secondary button-small" type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}

function RemovedRows({ worker, result, current }: ResultPage) {
  const [requestedPage, setPage] = useState(0);
  const total = result.removedRowCount;
  const page = pagination(total, requestedPage, setPage);
  const read = useCallback(() => worker.request({ type: 'repairRemoved', page: page.page, pageSize: PAGE_SIZE }), [worker, result, page.page]);
  const data = useWorkerPage(current && total ? read : null);
  return (
    <>
      <div className="panel-heading"><h3>Removed source rows</h3></div>
      {!current ? <p className="empty-panel">Review refreshes after processing finishes.</p> : null}
      {current && !total ? <p className="empty-panel">No rows were removed.</p> : null}
      {data?.error ? <p role="alert">{data.error}</p> : null}
      {data?.page ? (
        <ul className="removed-list">
          {data.page.rows.map((row) => (
            <li key={row.row}>
              <strong>Line {row.row}</strong>
              <p>{row.reason}</p>
              <code>{row.rawPreview || '(empty row)'}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {current ? <Pagination state={page} total={total} /> : null}
    </>
  );
}
