import { useCallback, useDeferredValue, useState } from 'react';
import { costCreepSparkline } from '../../../core/cost-creep/math';
import type { CostCreepRow } from '../../../core/cost-creep/types';
import { CustodyFingerprints } from '../CustodyFingerprints';
import { PAGE_SIZE, pagination, Pagination } from '../Pagination';
import { useWorkerPage } from '../useWorkerPage';
import type { CostCreepFilter, CostCreepRunSummary, CostCreepWorker } from './costCreepWorker';

export interface CostCreepReport {
  id: number;
  result: CostCreepRunSummary;
  worker: CostCreepWorker;
}

const FILTERS: { value: CostCreepFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'threshold', label: 'At or above threshold' },
  { value: 'consecutive', label: 'Consecutive hikes' },
  { value: 'lifecycle', label: 'Lifecycle changes' },
  { value: 'margin', label: 'Margin available' },
];

const LIFECYCLE_LABELS: Record<CostCreepRow['lifecycle'], string> = {
  'active-all-periods': 'Active all periods',
  'added-later': 'Added later',
  discontinued: 'Discontinued',
  reappeared: 'Reappeared',
};

const COLUMNS = ['SKU', 'Period trend', 'First to latest cost', 'Price behavior', 'Retail margin'];

function CostCreepRowView({ row, labels }: { row: CostCreepRow; labels: string[] }) {
  const { sku, observations, currency, firstObservedCost, latestObservedCost, cumulativeDelta, cumulativeDeltaPercent,
    consecutiveHikes, hikeCount, dropCount, volatility, lifecycle, meetsThreshold, margin } = row;
  const trendLabel = observations.map((observation, index) =>
    `${labels[index]}: ${observation ? `${currency ? `${currency} ` : ''}${observation.cost}` : 'no observation'}`).join(', ');
  const trend = costCreepSparkline(observations);
  const signedDelta = /^-/.test(cumulativeDelta) || /^0(?:\.0+)?$/.test(cumulativeDelta) ? cumulativeDelta : `+${cumulativeDelta}`;
  return (
    <tr role="row" data-lifecycle={lifecycle} data-threshold={meetsThreshold}>
      <th scope="row" role="rowheader">
        <code>{sku}</code>
        <small>{LIFECYCLE_LABELS[lifecycle]}</small>
        <details className="creep-row-sources">
          <summary>Source rows</summary>
          <ul>
            {observations.flatMap((observation, index) => observation?.sourceRows.map(({ row, rawCost }) => (
              <li key={`${index}:${row}`}>{labels[index]} · row {row} · <code>{rawCost}</code></li>
            )) ?? [])}
            {margin?.sourceRows.map(({ row, rawRetail }) => <li key={`retail:${row}`}>Baseline · row {row} · <code>{rawRetail}</code></li>)}
          </ul>
        </details>
      </th>
      <td role="cell">
        <span className="delta-mobile-label" aria-hidden="true">Period trend</span>
        <svg className="creep-sparkline" viewBox="0 0 160 48" role="img" aria-label={trendLabel}>
          <path className="creep-sparkline-axis" d="M0 44H160" />
          {trend.map((segment, index) => (
            <g key={index}>
              {segment.length > 1 ? <polyline points={segment.map(({ x, y }) => `${x.toFixed(2)},${y}`).join(' ')} /> : null}
              {segment.map(({ x, y }) => <circle key={x} cx={x} cy={y} r={2.6} />)}
            </g>
          ))}
        </svg>
      </td>
      <td role="cell">
        <span className="delta-mobile-label" aria-hidden="true">First to latest cost</span>
        <code>{currency ? `${currency} ` : ''}{firstObservedCost} → {latestObservedCost}</code>
        <small>
          Change <code>{signedDelta}</code>{cumulativeDeltaPercent === null ? ' · % unavailable' : ` · ${cumulativeDeltaPercent}%`}
        </small>
        {meetsThreshold ? <span className="delta-row-status creep-at-threshold">At or above threshold</span> : null}
      </td>
      <td role="cell">
        <span className="delta-mobile-label" aria-hidden="true">Price behavior</span>
        <span>{hikeCount} {hikeCount === 1 ? 'hike' : 'hikes'} · {dropCount} {dropCount === 1 ? 'drop' : 'drops'}</span>
        <small>Longest hike streak {consecutiveHikes}</small>
        <small>Volatility <code>{volatility}</code></small>
      </td>
      <td role="cell">
        <span className="delta-mobile-label" aria-hidden="true">Retail margin</span>
        {margin ? (
          <>
            <code>{margin.oldGrossMarginPercent}% → {margin.newGrossMarginPercent}%</code>
            <small>{margin.compressionPoints} pp compression · Retail {currency ? `${currency} ` : ''}<code>{margin.retail}</code></small>
          </>
        ) : '—'}
      </td>
    </tr>
  );
}

export function CostCreepResults({ report }: { report: CostCreepReport }) {
  const { id, worker, result: { summary, custody, issueCount, status } } = report;
  const [filter, setFilter] = useState<CostCreepFilter>('all');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [rowPage, setRowPage] = useState(0);
  const [issuePage, setIssuePage] = useState(0);
  const readRows = useCallback(() => worker.request({
    type: 'rows', runId: id, filter, search: deferredSearch, page: rowPage, pageSize: PAGE_SIZE,
  }), [worker, id, filter, deferredSearch, rowPage]);
  const readIssues = useCallback(() => worker.request({ type: 'issues', runId: id, page: issuePage, pageSize: PAGE_SIZE }),
    [worker, id, issuePage]);
  const rows = useWorkerPage(summary.trackedSkus ? readRows : null);
  const issues = useWorkerPage(issueCount ? readIssues : null);
  const total = rows?.page?.total ?? 0;
  const ready = status === 'ready';
  const labels = custody.periods.map(({ label }) => label);

  return (
    <>
      {ready ? (
        <dl className="delta-metrics creep-metrics" aria-label="Cost creep summary">
          <div><dt>Tracked SKUs</dt><dd>{summary.trackedSkus.toLocaleString('en-US')}</dd></div>
          <div><dt>SKUs &gt;= Threshold</dt><dd>{summary.thresholdSkus.toLocaleString('en-US')}</dd></div>
          <div><dt>Worst Cumulative Hike %</dt><dd>{summary.worstCumulativeHikePercent === null ? '—' : `${summary.worstCumulativeHikePercent}%`}</dd></div>
          <div><dt>Consecutive Multi-Hike SKUs</dt><dd>{summary.consecutiveMultiHikeSkus.toLocaleString('en-US')}</dd></div>
        </dl>
      ) : null}
      {issueCount ? (
        <details className="delta-issues" open={ready ? undefined : true}>
          <summary>Source checks ({issueCount.toLocaleString('en-US')})</summary>
          {issues?.error ? <p className="file-message file-error" role="alert">{issues.error}</p> : null}
          <ul aria-label="Cost creep source issues" aria-busy={!issues?.page && !issues?.error}>
            {issues?.page?.rows.map(({ source, periodLabel, row, rows, column, sku, message, value }, index) => {
              const title = source === 'retail' ? 'Store Baseline' : periodLabel || (source === 'period' ? 'Supplier period' : 'Analysis');
              const lines = rows.length ? rows : row === null ? [] : [row];
              return (
                <li key={index}>
                  <strong>{title}{lines.length ? ` · ${lines.length === 1 ? 'row' : 'rows'} ${lines.join(', ')}` : ''}{column ? ` · ${column}` : ''}{sku ? ` · SKU ${sku}` : ''}</strong>
                  {' '}{message}
                  {value !== null ? <> <code>{value}</code></> : null}
                </li>
              );
            })}
          </ul>
          <Pagination state={pagination(issueCount, issuePage, setIssuePage)} total={issueCount} label="Cost creep source checks pagination" />
        </details>
      ) : null}
      {summary.trackedSkus ? (
        <>
          <div className="creep-review-controls">
            <label>Search SKUs
              <input type="search" value={search} onChange={(event) => { setSearch(event.currentTarget.value); setRowPage(0); }} />
            </label>
            <div className="price-filters" role="group" aria-label="Filter cost creep">
              {FILTERS.map(({ value, label }) => (
                <button key={value} type="button" className="button button-secondary button-small" aria-pressed={filter === value}
                  onClick={() => { setFilter(value); setRowPage(0); }}>{label}</button>
              ))}
            </div>
          </div>
          {rows?.error ? <p className="file-message file-error" role="alert">{rows.error}</p> : (
            <div className="delta-table-region" role="region" aria-label="Cost creep rows" tabIndex={0}>
              <p className="field-help">Trend order: {labels.join(' → ')}</p>
              <table className="delta-table creep-table" role="table" aria-label="Cost creep by SKU" aria-busy={!rows?.page || search !== deferredSearch}>
                <thead role="rowgroup"><tr role="row">{COLUMNS.map((column) => <th scope="col" role="columnheader" key={column}>{column}</th>)}</tr></thead>
                <tbody role="rowgroup">
                  {rows?.page?.rows.map((row) => <CostCreepRowView key={row.sku} row={row} labels={labels} />)}
                </tbody>
              </table>
              {rows?.page && total === 0 ? <p className="field-help" role="status">No SKUs match this filter.</p> : null}
            </div>
          )}
          <Pagination state={pagination(total, rowPage, setRowPage)} total={total} label="Cost creep pagination" />
        </>
      ) : null}
      <CustodyFingerprints entries={[
        ...custody.periods.map(({ label, filename, selectedSheet, sha256 }, index) => ({
          field: `period-${index + 1}`,
          label: label || `Period ${index + 1}`,
          detail: selectedSheet ? `${filename} · ${selectedSheet}` : filename,
          sha256,
        })),
        ...(custody.retail ? [{
          field: 'baseline', label: 'Store Baseline CSV', detail: custody.retail.filename, sha256: custody.retail.sha256,
        }] : []),
        { field: 'cost-creep-csv', label: 'Cost-Creep CSV', sha256: ready ? custody.historyCsvSha256 : undefined },
        { field: 'vendor-brief', label: 'Vendor Negotiation Brief HTML', sha256: ready ? custody.briefHtmlSha256 : undefined },
      ]} />
    </>
  );
}
