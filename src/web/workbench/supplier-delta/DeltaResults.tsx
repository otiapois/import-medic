import { useCallback, useState } from 'react';
import { CustodyFingerprints } from '../CustodyFingerprints';
import { Pagination, pagination, PAGE_SIZE } from '../Pagination';
import { useWorkerPage } from '../useWorkerPage';
import type { DeltaFilter, DeltaRow, DeltaSummary, DeltaWorker } from './deltaWorker';

const FILTERS: readonly { id: DeltaFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'cost-increased', label: 'Cost Hikes' },
  { id: 'cost-decreased', label: 'Cost Drops' },
  { id: 'added-sku', label: 'Added' },
  { id: 'removed-sku', label: 'Removed' },
  { id: 'blocked', label: 'Blocked' },
];

const STATUS_LABELS: Record<DeltaRow['status'], string> = {
  'cost-increased': 'Cost hike',
  'cost-decreased': 'Cost drop',
  'unchanged': 'Unchanged',
  'added-sku': 'Added',
  'removed-sku': 'Removed',
  'blocked-duplicate-sku': 'Duplicate SKU',
  'blocked-invalid-cost': 'Invalid cost',
  'blocked-invalid-sku': 'Invalid SKU',
  'blocked-invalid-inventory': 'Invalid inventory',
  'blocked-currency': 'Currency conflict',
};

const COLUMNS = ['SKU', 'Status', 'Previous cost', 'New cost', 'Change', 'Inventory', 'Source rows'];

function costText(value: string | null, currency: string | null) {
  if (value === null) return '—';
  if (currency !== 'USD' && currency !== '$') return currency ? `${value} ${currency}` : value;
  const sign = value.startsWith('+') || value.startsWith('-') ? value[0] : '';
  return `${sign}$${value.slice(sign.length)}`;
}

function DeltaRowView({ row }: { row: DeltaRow }) {
  const { sku, status, previousRow, newRow, previousCost, newCost, delta, deltaPercent, previousInventory, newInventory, inventoryDelta, currency } = row;
  const zeroBase = status === 'cost-increased' && deltaPercent === null;
  return (
    <tr role="row" data-delta-status={status}>
      <th scope="row" role="rowheader">
        <span className="delta-mobile-label" aria-hidden="true">SKU</span><code>{sku || '—'}</code>
      </th>
      <td role="cell">
        <span className="delta-mobile-label" aria-hidden="true">Status</span><span className="delta-row-status">{STATUS_LABELS[status]}</span>
      </td>
      <td role="cell">
        <span className="delta-mobile-label" aria-hidden="true">Previous cost</span><code>{costText(previousCost, currency)}</code>
      </td>
      <td role="cell">
        <span className="delta-mobile-label" aria-hidden="true">New cost</span><code>{costText(newCost, currency)}</code>
      </td>
      <td role="cell">
        <span className="delta-mobile-label" aria-hidden="true">Change</span><code>{costText(delta, currency)}</code>
        {deltaPercent !== null ? <small>({deltaPercent}%)</small> : zeroBase ? <small>Previous cost was zero. Percentage unavailable.</small> : null}
      </td>
      <td role="cell">
        <span className="delta-mobile-label" aria-hidden="true">Inventory</span>
        {previousInventory !== null || newInventory !== null ? (
          <><code>{previousInventory ?? '—'} → {newInventory ?? '—'}</code>{inventoryDelta !== null ? <small>Change {inventoryDelta}</small> : null}</>
        ) : <span>—</span>}
      </td>
      <td role="cell">
        <span className="delta-mobile-label" aria-hidden="true">Source rows</span>
        {previousRow !== null ? <span className="delta-source-row">Previous {previousRow}</span> : null}
        {newRow !== null ? <span className="delta-source-row">New {newRow}</span> : null}
      </td>
    </tr>
  );
}

export function DeltaResults({ report, previous, next, signoffFingerprint }: {
  signoffFingerprint?: string;
  report: { summary: DeltaSummary; id: number; worker: DeltaWorker };
  previous: { file: File; sheetName?: string | null };
  next: { file: File; sheetName?: string | null };
}) {
  const { summary: { counts, maxHikePercent, rowCount, issueCount, custody, status }, id, worker } = report;
  const [filter, setFilter] = useState<DeltaFilter>('all');
  const [rowPage, setRowPage] = useState(0);
  const [issuePage, setIssuePage] = useState(0);
  const filterCounts = {
    all: rowCount,
    'cost-increased': counts['cost-increased'],
    'cost-decreased': counts['cost-decreased'],
    'added-sku': counts['added-sku'],
    'removed-sku': counts['removed-sku'],
    blocked: counts['blocked-duplicate-sku'] + counts['blocked-invalid-cost'] + counts['blocked-invalid-sku'] +
      counts['blocked-invalid-inventory'] + counts['blocked-currency'],
  } satisfies Record<DeltaFilter, number>;
  const total = filterCounts[filter];
  const rowPagination = pagination(total, rowPage, setRowPage);
  const issuePagination = pagination(issueCount, issuePage, setIssuePage);
  const readRows = useCallback(() => worker.request({ type: 'rows', comparisonId: id, filter, page: rowPagination.page, pageSize: PAGE_SIZE }),
    [worker, id, filter, rowPagination.page]);
  const readIssues = useCallback(() => worker.request({ type: 'issues', comparisonId: id, page: issuePagination.page, pageSize: PAGE_SIZE }),
    [worker, id, issuePagination.page]);
  const rows = useWorkerPage(total ? readRows : null);
  const issues = useWorkerPage(issueCount ? readIssues : null);
  return (
    <>
      <dl className="delta-metrics" aria-label="Supplier delta summary">
        {FILTERS.slice(1, 5).map(({ id, label }) => <div key={id}><dt>{label}</dt><dd>{filterCounts[id].toLocaleString('en-US')}</dd></div>)}
        <div><dt>Max Hike %</dt><dd>{maxHikePercent !== null ? `${maxHikePercent}%` : '—'}</dd></div>
      </dl>
      {maxHikePercent === null && counts['cost-increased'] > 0 ? (
        <p className="field-help">The previous costs for these hikes were zero. A percentage increase is unavailable.</p>
      ) : null}
      <div className="price-filters" role="group" aria-label="Filter supplier delta">
        {FILTERS.map(({ id, label }) => (
          <button key={id} type="button" className="button button-secondary button-small" aria-pressed={filter === id}
            onClick={() => { setFilter(id); setRowPage(0); }}>
            {label} <span aria-hidden="true">{filterCounts[id].toLocaleString('en-US')}</span>
          </button>
        ))}
      </div>
      {rows?.error ? <p className="file-message file-error" role="alert">{rows.error}</p> :
        <div className="delta-table-region" role="region" aria-label="Supplier cost delta rows" tabIndex={0}>
          <table className="delta-table" role="table" aria-label="Supplier cost delta" aria-busy={Boolean(total && !rows?.page)}>
            <thead role="rowgroup"><tr role="row">{COLUMNS.map((column) => <th scope="col" role="columnheader" key={column}>{column}</th>)}</tr></thead>
            <tbody role="rowgroup">
              {rows?.page?.rows.map((row) => <DeltaRowView key={`${row.previousRow ?? ''}:${row.newRow ?? ''}`} row={row} />)}
            </tbody>
          </table>
          {!total ? <p className="field-help" role="status">No rows in this filter.</p> : null}
        </div>}
      <Pagination state={rowPagination} total={total} label="Supplier delta pagination" />
      {issueCount ? (
        <details className="delta-issues" open={status === 'blocked' ? true : undefined}>
          <summary>Source checks ({issueCount.toLocaleString('en-US')})</summary>
          {issues?.error ? <p className="file-message file-error" role="alert">{issues.error}</p> : null}
          <ul aria-label="Supplier delta issues" aria-busy={!issues?.page}>
            {issues?.page?.rows.map(({ side, row, rows, message }, index) => {
              const source = side === 'previous' ? 'Previous sheet' : side === 'next' ? 'New sheet' : 'Comparison';
              const lines = rows?.length ? rows : row == null ? [] : [row];
              return <li key={index}><strong>{source}{lines.length ? ` · ${lines.length === 1 ? 'row' : 'rows'} ${lines.join(', ')}` : ''}</strong> {message}</li>;
            })}
          </ul>
          <Pagination state={issuePagination} total={issueCount} label="Supplier delta source checks pagination" />
        </details>
      ) : null}
      <CustodyFingerprints open entries={[
        { field: 'previous', label: 'Previous supplier sheet', sha256: custody.previousSha256, detail: previous.sheetName ? `${previous.file.name} · ${previous.sheetName}` : previous.file.name },
        { field: 'new', label: 'New supplier sheet', sha256: custody.newSha256, detail: next.sheetName ? `${next.file.name} · ${next.sheetName}` : next.file.name },
        { field: 'delta-csv', label: 'Supplier Delta CSV', sha256: status === 'ready' ? custody.deltaCsvSha256 : undefined },
        { field: 'signoff', label: 'Delta Sign-Off HTML', sha256: status === 'ready' ? signoffFingerprint : undefined },
      ]} />
    </>
  );
}
