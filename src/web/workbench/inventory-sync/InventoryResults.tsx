import { useCallback, useState } from 'react';
import type { InventoryIssue, InventorySyncRow } from '../../../core/inventory-sync/types';
import { CustodyFingerprints } from '../CustodyFingerprints';
import { Pagination, pagination, PAGE_SIZE } from '../Pagination';
import { useWorkerPage } from '../useWorkerPage';
import type { InventoryFilter, InventorySummary, InventoryWorker } from './inventoryWorker';

const FILTERS: Record<InventoryFilter, string> = {
  all: 'All rows', changed: 'Changed', review: 'Needs review', 'no-supplier-match': 'No supplier match',
};
const STATUSES: Record<InventorySyncRow['status'], string> = {
  changed: 'Changed', unchanged: 'Unchanged', 'no-supplier-match': 'No supplier match',
  'approval-required': 'Approval required', blocked: 'Blocked',
};
const COLUMNS = ['SKU', 'On hand before', 'Supplier stock', 'On hand after', 'Change', 'Buffer withheld', 'Status'];
const COUNT = new Intl.NumberFormat('en-US');
const SIGNED = new Intl.NumberFormat('en-US', { signDisplay: 'exceptZero' });

export function InventoryDiagnostics({ issues, sourceLabel }: { issues: readonly InventoryIssue[]; sourceLabel?: string }) {
  return (
    <ul className="inventory-issues" aria-label="Inventory diagnostics">
      {issues.map(({ code, message, source, line, lines, supplierIndex, sku, column, value, offers }, index) => {
        const name = sourceLabel ?? (source === 'supplier' ? `Supplier ${(supplierIndex ?? 0) + 1}` : source === 'baseline' ? 'Shopify inventory' : 'Inventory check');
        const physicalLines = lines?.length ? lines : line == null ? [] : [line];
        return (
          <li key={index} data-inventory-issue={code}>
            <p><strong>{name}{physicalLines.length ? ` · ${physicalLines.length === 1 ? 'line' : 'lines'} ${physicalLines.join(', ')}` : ''}</strong> {message}</p>
            {sku !== undefined || column !== undefined || value !== undefined ? (
              <p className="inventory-issue-evidence">
                {sku !== undefined ? <span>SKU <code>{sku || '(blank)'}</code></span> : null}
                {column !== undefined ? <span>Column <code>{column}</code></span> : null}
                {value !== undefined ? <span>Value <code>{value || '(blank)'}</code></span> : null}
              </p>
            ) : null}
            {offers?.length ? (
              <ul className="inventory-offers" aria-label="Supplier quantities">
                {offers.map(({ supplierIndex, line, rawQuantity }, index) => (
                  <li key={index}>Supplier {supplierIndex + 1} · line {line} · <code>{rawQuantity}</code></li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function InventoryRowView({ row }: { row: InventorySyncRow }) {
  const { sku, baselineLine, currentRaw, currentQty, proposedQty, bufferWithheld, status, supplierQty } = row;
  const values = [
    currentRaw || '—',
    supplierQty === null ? '—' : COUNT.format(supplierQty),
    proposedQty === null ? '—' : COUNT.format(proposedQty),
    proposedQty === null || currentQty === null ? '—' : SIGNED.format(BigInt(proposedQty) - BigInt(currentQty)),
    bufferWithheld === null ? '—' : COUNT.format(bufferWithheld),
  ];
  return (
    <tr role="row" data-inventory-row-status={status}>
      <th scope="row" role="rowheader">
        <span className="delta-mobile-label" aria-hidden="true">SKU</span>
        <code>{sku || '—'}</code><small>Shopify line {baselineLine}</small>
      </th>
      {values.map((value, index) => (
        <td role="cell" key={COLUMNS[index + 1]}>
          <span className="delta-mobile-label" aria-hidden="true">{COLUMNS[index + 1]}</span><code>{value}</code>
        </td>
      ))}
      <td role="cell">
        <span className="delta-mobile-label" aria-hidden="true">Status</span>
        <span className="delta-row-status">{STATUSES[status]}</span>
        {row.largeDrop && status === 'changed' ? <small>Large drop approved</small> : null}
      </td>
    </tr>
  );
}

interface RunView {
  id: number;
  worker: InventoryWorker;
  summary: InventorySummary;
}

function InventoryRows({ id, worker, summary, filter, search }: RunView & { filter: InventoryFilter; search: string }) {
  const [view, setView] = useState({ page: 0, total: filter === 'all' && !search.trim() ? summary.rowCount : 0 });
  const read = useCallback(() => worker.request({
    type: 'rows', comparisonId: id, filter, search, page: view.page, pageSize: PAGE_SIZE,
  }), [worker, id, filter, search, view.page]);
  const response = useWorkerPage(read);
  const total = response?.page?.total ?? view.total;
  const state = pagination(total, view.page, (page) => setView({ page, total }));

  return (
    <>
      {response?.error ? <p className="file-message file-error" role="alert">{response.error}</p> : (
        <div className="delta-table-region inventory-table-region" role="region" aria-label="Inventory rows" tabIndex={0}>
          <table className="delta-table inventory-table" role="table" aria-label="Inventory before and after" aria-busy={!response?.page}>
            <thead role="rowgroup"><tr role="row">{COLUMNS.map((column) => <th key={column} scope="col" role="columnheader">{column}</th>)}</tr></thead>
            <tbody role="rowgroup">{response?.page?.rows.map((row) => <InventoryRowView key={row.baselineLine} row={row} />)}</tbody>
          </table>
          {!response?.page ? <p className="field-help" role="status">Loading inventory rows…</p> :
            !total ? <p className="field-help" role="status">No inventory rows match this view.</p> : null}
        </div>
      )}
      <Pagination state={state} total={total} label="Inventory row pagination" />
    </>
  );
}

export function InventoryResults({ id, worker, summary, characterKeys }: RunView & { characterKeys: boolean }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<InventoryFilter>('all');
  const [issuePage, setIssuePage] = useState(0);
  const { totals, targetLocation, custody, issueCount, rowCount, status, verification } = summary;
  const issuePagination = pagination(issueCount, issuePage, setIssuePage);
  const readIssues = useCallback(() => worker.request({ type: 'issues', comparisonId: id, page: issuePagination.page, pageSize: PAGE_SIZE }),
    [worker, id, issuePagination.page]);
  const issues = useWorkerPage(issueCount ? readIssues : null);
  const metrics = [
    ['Rows changing', COUNT.format(totals.changedCount)],
    ['Units added', SIGNED.format(BigInt(totals.unitsAdded))],
    ['Units removed', SIGNED.format(-BigInt(totals.unitsRemoved))],
    ['Zeroed by buffer', COUNT.format(totals.bufferZeroedCount)],
    ['Out of stock', COUNT.format(totals.outOfStockCount)],
  ] as const;

  return (
    <>
      {targetLocation ? <p className="inventory-scope">Target location <strong>{targetLocation}</strong></p> : null}
      {rowCount > 0 ? (
        <>
          <dl className="delta-metrics" aria-label="Inventory impact">
            {metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <div className="inventory-filters">
            <label className="price-search">
              Search inventory by SKU
              <input data-price-row-search type="search" value={search} maxLength={300}
                aria-keyshortcuts={characterKeys ? '/' : undefined} onChange={(event) => setSearch(event.currentTarget.value)} />
            </label>
            <label className="filter-label">
              Filter inventory rows
              <select value={filter} onChange={(event) => setFilter(event.currentTarget.value as InventoryFilter)}>
                {Object.entries(FILTERS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
          </div>
          <InventoryRows key={JSON.stringify([filter, search])} id={id} worker={worker} summary={summary} filter={filter} search={search} />
        </>
      ) : null}
      {issueCount ? (
        <details className="delta-issues" open={status === 'blocked' ? true : undefined}>
          <summary>Inventory source checks ({COUNT.format(issueCount)})</summary>
          {issues?.error ? <p className="file-message file-error" role="alert">{issues.error}</p> :
            issues?.page ? <InventoryDiagnostics issues={issues.page.rows} /> : <p className="field-help" role="status">Reading inventory diagnostics…</p>}
          <Pagination state={issuePagination} total={issueCount} label="Inventory diagnostics pagination" />
        </details>
      ) : null}
      {verification.checked ? <p className="field-help">
        Rollback replay restored {COUNT.format(verification.restoredRows)} {verification.restoredRows === 1 ? 'row' : 'rows'}.
        {' '}{COUNT.format(verification.otherLocationRowsUntouched)} {verification.otherLocationRowsUntouched === 1 ? 'row at other locations was' : 'rows at other locations were'} untouched.
      </p> : null}
      <CustodyFingerprints entries={[
        { field: 'baseline', label: 'Shopify Inventory CSV', sha256: custody.baseline.sha256, detail: custody.baseline.filename },
        ...custody.suppliers.map(({ filename, sheetName, byteLength, sha256 }, index) => ({
          field: `supplier-${index + 1}`, label: `Supplier ${index + 1}`, sha256,
          detail: [filename, sheetName, `${COUNT.format(byteLength)} bytes`].filter(Boolean).join(' · '),
        })),
        { field: 'update', label: 'Inventory Update CSV', sha256: status === 'ready' ? custody.updateCsvSha256 : undefined },
        { field: 'rollback', label: 'Inventory Rollback CSV', sha256: status === 'ready' ? custody.rollbackCsvSha256 : undefined },
      ]} />
    </>
  );
}
