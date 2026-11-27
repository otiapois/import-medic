import { useCallback, useState } from 'react';
import type { WorkbenchWorker } from '../../core/worker/client';
import type { RepairPreviewRow, RepairSummary } from '../../core/worker/protocol';
import { PAGE_SIZE, Pagination, pagination } from './Pagination';
import { useWorkerPage } from './useWorkerPage';

export function Preview({ worker, result, current }: { worker: WorkbenchWorker; result: RepairSummary; current: boolean }) {
  const [requestedPage, setPage] = useState(0);
  const page = pagination(result.rowCount, requestedPage, setPage);
  const read = useCallback(() => worker.request({ type: 'repairRows', page: page.page, pageSize: PAGE_SIZE }), [worker, result, page.page]);
  const data = useWorkerPage(current && result.rowCount ? read : null);

  return (
    <>
      <div className="panel-heading preview-heading">
        <div>
          <h3>Before / after comparison</h3>
          <p>Line numbers refer to the original CSV.</p>
        </div>
        <ul className="preview-legend" aria-label="Cell highlights">
          <li><span className="legend-dot legend-change" aria-hidden="true" />Changed</li>
          <li><span className="legend-dot legend-review" aria-hidden="true" />Needs review</li>
        </ul>
      </div>
      {!current ? <p className="empty-panel">Preview refreshes after processing finishes.</p> : null}
      {current && !result.rowCount ? <p className="empty-panel">No retained rows to preview.</p> : null}
      {data?.error ? <p role="alert">{data.error}</p> : null}
      {data?.page ? (
        <div className="preview-grid">
          <PreviewTable title="Original CSV" headers={result.sourceHeaders} rows={data.page.rows} side="before" headerMarks={result.beforeHeaderMarks} />
          <PreviewTable title="Repaired CSV" headers={result.headers} rows={data.page.rows} side="after" headerMarks={result.afterHeaderMarks} />
        </div>
      ) : null}
      {current ? <Pagination state={page} total={result.rowCount} /> : null}
    </>
  );
}

function PreviewTable({
  title,
  headers,
  rows,
  side,
  headerMarks,
}: {
  title: string;
  headers: readonly string[];
  rows: readonly RepairPreviewRow[];
  side: 'before' | 'after';
  headerMarks: readonly string[];
}) {
  const width = Math.max(headers.length, ...rows.map((row) => row[side].length));
  const columns = Array.from({ length: width }, (_, index) => headers[index]);
  return (
    <div className="preview-card">
      <h4>{title}</h4>
      {columns.length ? (
        <div className="table-scroll" tabIndex={0} role="region" aria-label={`${title} scrollable table`}>
          <table aria-label={title}>
            <thead>
              <tr>
                <th scope="col" className="line-cell">Line</th>
                {columns.map((header, index) => {
                  const changed = header !== undefined && headerMarks.includes(header);
                  return (
                    <th scope="col" key={index} data-cell-status={changed ? 'changed' : undefined}>
                      {header || `${header === undefined ? 'Extra column' : 'Column'} ${index + 1}`}
                      {changed ? <span className="sr-only"> · Changed</span> : null}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const rowMarks = side === 'before' ? row.beforeMarks : row.afterMarks;
                const rowStatus = rowMarks.review.includes('') ? 'review' : rowMarks.changed.includes('') ? 'changed' : undefined;
                return (
                  <tr key={row.row}>
                    <th scope="row" className="line-cell" data-cell-status={rowStatus}>
                      {row.row}
                      {rowStatus ? <span className="sr-only"> · {rowStatus === 'review' ? 'Needs review' : 'Changed'}</span> : null}
                    </th>
                    {columns.map((header, index) => {
                      const value = row[side][index] ?? '';
                      const status = header
                        ? rowMarks.review.includes(header) ? 'review' : rowMarks.changed.includes(header) ? 'changed' : undefined
                        : undefined;
                      return (
                        <td key={index} data-cell-status={status}>
                          <code title={value}>{value || <span className="blank-cell">(empty)</span>}</code>
                          {status ? <span className="sr-only"> · {status === 'review' ? 'Needs review' : 'Changed'}</span> : null}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="empty-panel">No columns to preview.</p>}
    </div>
  );
}
