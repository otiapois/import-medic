import { useCallback, useId } from 'react';
import type { ImportDiffRow } from '../../core/verify-import/inspector';
import type { WorkbenchWorker } from '../../core/worker/client';
import { PAGE_SIZE, Pagination, usePagination } from './Pagination';
import { useWorkerPage } from './useWorkerPage';

const ISSUE_SOURCES = { baseline: 'Baseline', candidate: 'Candidate', update: 'Paired update' } as const;

interface InspectionPage {
  worker: WorkbenchWorker;
  total: number;
  build?: boolean;
}

export function InspectionIssues({ worker, total, build }: InspectionPage) {
  const id = useId();
  const page = usePagination(total);
  const read = useCallback(() => worker.request({
    type: build ? 'amazonPriceIssues' : 'inspectionIssues', page: page.page, pageSize: PAGE_SIZE,
  }), [worker, build, page.page]);
  const data = useWorkerPage(total ? read : null);
  if (!total) return null;

  const candidate = build ? 'Proposal' : 'Candidate';
  return (
    <section className="verify-result-detail" aria-labelledby={id} data-testid={build ? 'amazon-build-issues' : 'verify-issues'}>
      <h3 id={id}>{build ? 'Amazon file and price corridor checks' : 'Safety issues'} ({total.toLocaleString('en-US')})</h3>
      {data?.error ? <p className="file-error" role="alert">{data.error}</p> : data?.page ? (
        <ul className="verify-issues">
          {data.page.rows.map(({ source, code, message, line, column, baselineLine, candidateLine }, index) => {
            const showBaseline = baselineLine !== undefined && (source !== 'baseline' || baselineLine !== line);
            const showCandidate = candidateLine !== undefined && (source === 'baseline' || candidateLine !== line);
            const candidateLabel = source === 'baseline' && !build ? 'Compared file' : source === 'update' ? ISSUE_SOURCES.update : candidate;
            return (
              <li key={page.start + index} data-issue-code={code}>
                <p>
                  <strong>{source === 'candidate' ? candidate : ISSUE_SOURCES[source]}{line === undefined ? '' : ` line ${line}`}</strong>
                  {column ? <> · <code>{column}</code></> : null}
                </p>
                <p>{message}</p>
                {showBaseline || showCandidate ? (
                  <p className="inspection-issue-lines">
                    {showBaseline ? <span>Baseline line {baselineLine}</span> : null}
                    {showCandidate ? <span>{candidateLabel} line {candidateLine}</span> : null}
                  </p>
                ) : null}
                <code className="field-help">{code}</code>
              </li>
            );
          })}
        </ul>
      ) : <p className="empty-panel" role="status">Loading safety issues…</p>}
      <Pagination state={page} total={total} label="Safety issue pages" />
    </section>
  );
}

export function InspectionRows({ worker, total, build, amazon }: InspectionPage & { amazon?: boolean }) {
  const id = useId();
  const page = usePagination(total);
  const read = useCallback(() => worker.request({
    type: build ? 'amazonPriceRows' : 'inspectionRows', page: page.page, pageSize: PAGE_SIZE,
  }), [worker, build, page.page]);
  const data = useWorkerPage(total ? read : null);

  return (
    <section className="verify-result-detail" aria-labelledby={id} data-testid={build ? 'amazon-build-rows' : 'verify-rows'}>
      <h3 id={id}>Exact diff rows ({total.toLocaleString('en-US')})</h3>
      {data?.error ? <p className="file-error" role="alert">{data.error}</p> : data?.page ? (
        amazon ? <AmazonRows rows={data.page.rows} candidate={build ? 'Proposal' : 'Candidate'} /> : (
          <div className="preview-card">
            <div className="table-scroll" role="region" aria-labelledby={id} tabIndex={0}>
              <table className="verify-table" aria-labelledby={id}>
                <thead>
                  <tr><th scope="col">SKU / Product</th><th scope="col">Baseline line</th><th scope="col">Candidate line</th><th scope="col">Changed cells</th></tr>
                </thead>
                <tbody>
                  {data.page.rows.map(({ sku, product, baselineLine, candidateLine, changes }) => (
                    <tr key={candidateLine}>
                      <th scope="row"><code>{sku || 'No SKU'}</code><span className="price-row-detail">{product}</span></th>
                      <td>{baselineLine}</td>
                      <td>{candidateLine}</td>
                      <td><ChangedCells changes={changes} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : <p className="empty-panel" role="status">{total ? 'Loading diff rows…' : 'No changed rows to display.'}</p>}
      <Pagination state={page} total={total} label="Exact diff row pages" />
    </section>
  );
}

function AmazonRows({ rows, candidate }: { rows: readonly ImportDiffRow[]; candidate: string }) {
  return (
    <ul className="amazon-diff-rows">
      {rows.map(({ sku, baselineLine, candidateLine, changes }) => (
        <li key={candidateLine}>
          <div>
            <strong>SKU <code>{sku}</code></strong>
            <p className="field-help">Baseline line {baselineLine} · {candidate} line {candidateLine}</p>
          </div>
          <ChangedCells changes={changes} />
        </li>
      ))}
    </ul>
  );
}

function ChangedCells({ changes }: { changes: ImportDiffRow['changes'] }) {
  return (
    <ul className="verify-changes">
      {changes.map(({ column, before, after, delta }) => (
        <li key={column}>
          <strong>{column}</strong>
          <dl>
            <div><dt>Before</dt><dd><CsvCell value={before} /></dd></div>
            <div><dt>After</dt><dd><CsvCell value={after} /></dd></div>
            <div><dt>Delta</dt><dd><CsvCell value={delta} missing="Unavailable" /></dd></div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function CsvCell({ value, missing = 'Column absent' }: { value: string | null; missing?: string }) {
  if (value === null || value === '') return <span className="blank-cell">{value === null ? missing : 'Empty'}</span>;
  return <code>{value}</code>;
}
