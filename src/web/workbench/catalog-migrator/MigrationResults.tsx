import { Fragment, useCallback, useId } from 'react';
import { CustodyFingerprints } from '../CustodyFingerprints';
import { PAGE_SIZE, Pagination, usePagination } from '../Pagination';
import { useWorkerPage } from '../useWorkerPage';
import type { CatalogRun, MigrationWorker } from './migrationWorker';

interface Report {
  worker: MigrationWorker;
  result: CatalogRun;
}

const PREVIEW_ORDER = [
  'Handle', 'Name', 'Title', 'SKU', 'Variant SKU', 'Parent', 'Regular price', 'Price', 'Variant Price',
  'Sale price', 'Sale Price', 'Variant Compare At Price', 'Stock', 'Current Stock', 'Variant Inventory Qty',
];

export function MigrationResults({ report, signoffFingerprint }: { report: Report; signoffFingerprint?: string }) {
  const id = useId();
  const { result } = report;
  const { summary, custody, mapping, unmappedColumns } = result;
  return (
    <>
      <dl className="delta-metrics" aria-label="Catalog counts and variant parity">
        <div><dt>Source products</dt><dd>{summary.sourceProducts.toLocaleString('en-US')}</dd></div>
        <div><dt>Source variants</dt><dd>{summary.sourceVariants.toLocaleString('en-US')}</dd></div>
        <div><dt>Target products</dt><dd>{summary.targetProducts.toLocaleString('en-US')}</dd></div>
        <div><dt>Target variants</dt><dd>{summary.targetVariants.toLocaleString('en-US')}</dd></div>
        <div><dt>Variant parity</dt><dd>{result.ready ? (summary.variantParity ? 'Verified' : 'Mismatch') : 'Held'}</dd></div>
      </dl>
      <section className="migration-card" aria-labelledby={`${id}-mapping`}>
        <h3 id={`${id}-mapping`}>Field Mapping &amp; Unmapped Disclosure</h3>
        <div className="migration-unmapped" data-testid="migration-unmapped-columns">
          <h4>Unmapped source columns</h4>
          {unmappedColumns.length ? (
            <>
              <p>These source columns are omitted from the target CSV.</p>
              <ul className="migration-columns">
                {unmappedColumns.map((column, index) => <li key={index}><code>{column || 'Unnamed column'}</code></li>)}
              </ul>
            </>
          ) : <p>{mapping.length ? 'No unmapped columns.' : 'Column mapping is unavailable for this file.'}</p>}
        </div>
        {mapping.length ? (
          <div className="migration-mapping-scroll" tabIndex={0} role="region" aria-label="Source to target field mapping">
            <table className="migration-mapping-table">
              <thead><tr><th scope="col">Source column</th><th scope="col">Target column</th><th scope="col">Mapping notes</th></tr></thead>
              <tbody>{mapping.map(({ source, target, notes }, index) => (
                <tr key={index}>
                  <th scope="row"><code>{source || 'Unnamed column'}</code></th>
                  <td>{target ? <code>{target}</code> : 'Omitted'}</td>
                  <td>{notes}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : null}
      </section>
      {result.issueCount ? <IssueReview report={report} /> : null}
      <TargetPreview report={report} />
      <section aria-label="Migration file custody">
        <CustodyFingerprints open entries={[
          { field: 'source', label: 'Source CSV', sha256: custody.sourceSha256, detail: result.sourceFilename },
          { field: 'target', label: 'Target CSV', sha256: custody.targetSha256 },
          { field: 'sign-off', label: 'Sign-Off HTML', sha256: signoffFingerprint },
        ]} />
      </section>
    </>
  );
}

function IssueReview({ report: { result, worker } }: { report: Report }) {
  const heading = useId();
  const { issueCount, blockedIssueCount } = result;
  const page = usePagination(issueCount);
  const index = page.page;
  const read = useCallback(() => worker.request({ type: 'issues', page: index, pageSize: PAGE_SIZE }), [worker, index]);
  const data = useWorkerPage(read);
  const disclosures = issueCount - blockedIssueCount;
  return (
    <section className="migration-card" aria-labelledby={heading}>
      <h3 id={heading}>Source row review</h3>
      <p className="field-help">{blockedIssueCount.toLocaleString('en-US')} held issues and {disclosures.toLocaleString('en-US')} disclosures.</p>
      {data?.error ? <p role="alert" className="file-message file-error">{data.error}</p> : data?.page ? (
        <ul className="price-check-list" data-testid="migration-issues">
          {data.page.rows.map(({ code, line, column, level, message }, offset) => (
            <li key={offset}>
              <strong>{level === 'blocked' ? 'Held' : 'Disclosure'} · {line === null ? 'File' : `Source line ${line}`}{column ? ` · ${column}` : ''}</strong>
              <p><code>{code}</code> · {message}</p>
            </li>
          ))}
        </ul>
      ) : <p className="field-help" role="status">Reading source issues…</p>}
      <Pagination state={page} total={issueCount} label="Source issues pagination" />
    </section>
  );
}

function TargetPreview({ report: { result, worker } }: { report: Report }) {
  const heading = useId();
  const { headers, rowCount } = result;
  const page = usePagination(rowCount);
  const index = page.page;
  const read = useCallback(() => worker.request({ type: 'rows', page: index, pageSize: PAGE_SIZE }), [worker, index]);
  const data = useWorkerPage(rowCount ? read : null);
  const columns = [
    ...PREVIEW_ORDER.filter((header) => headers.includes(header)),
    ...headers.filter((header) => !PREVIEW_ORDER.includes(header)),
  ].map((header) => ({ header, index: headers.indexOf(header) }));

  return (
    <section className="migration-card" aria-labelledby={heading}>
      <h3 id={heading}>Target catalog preview</h3>
      {rowCount ? <>
        <p className="field-help">{rowCount.toLocaleString('en-US')} CSV {rowCount === 1 ? 'row' : 'rows'}. Scroll the table to see all target columns.</p>
        <Pagination state={page} total={rowCount} label="Target preview pagination" />
        <div className="table-scroll migration-preview" role="region" aria-label="Target CSV rows" tabIndex={0}>
          <table>
            <thead><tr><th scope="col">Row type</th>{columns.map(({ header }) => <th key={header} scope="col">{header}</th>)}</tr></thead>
            <tbody>
              {data?.error ? <tr><td colSpan={columns.length + 1}><p role="alert">{data.error}</p></td></tr> : data?.page ? (
                data.page.rows.map(({ kind, cells }, offset) => (
                  <tr key={offset}>
                    <th scope="row">{kind}</th>
                    {columns.map(({ header, index }) => (
                      <td key={header}>
                        {header === 'Options' ? <code className="migration-option-expression">
                          {cells[index].split(/(?<=\|)/).map((part, offset) => (
                            <Fragment key={offset}>{part}{part.endsWith('|') ? <wbr /> : null}</Fragment>
                          ))}
                        </code> : <code>{cells[index]}</code>}
                      </td>
                    ))}
                  </tr>
                ))
              ) : <tr><td colSpan={columns.length + 1}><p role="status">Reading target rows…</p></td></tr>}
            </tbody>
          </table>
        </div>
      </> : <p className="field-help">The target preview will be available once the blocking issues are resolved.</p>}
    </section>
  );
}
