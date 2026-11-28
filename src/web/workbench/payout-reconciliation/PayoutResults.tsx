import { useCallback, useId } from 'react';
import { formatMinorUnits } from '../../../core/values';
import { downloadFile } from '../downloads';
import { PAGE_SIZE, Pagination, usePagination } from '../Pagination';
import { useWorkerPage } from '../useWorkerPage';
import type { ReconciliationException, ReconciliationPreview, ReconciliationWorker } from './reconciliationWorker';

const COUNT = new Intl.NumberFormat('en-US');
const DOWNLOADS = [
  { key: 'pairsCsv', label: 'Download Reconciled Pairs CSV', mime: 'text/csv;charset=utf-8' },
  { key: 'exceptionsCsv', label: 'Download Exceptions CSV', mime: 'text/csv;charset=utf-8' },
  { key: 'auditJson', label: 'Download Audit JSON', mime: 'application/json;charset=utf-8' },
  { key: 'signoffHtml', label: 'Download Branded Month-End Sign-Off (.html)', mime: 'text/html;charset=utf-8' },
] as const;

const EXCEPTION_NAMES: Record<ReconciliationException['code'], string> = {
  UNMATCHED_PAYOUT: 'Unmatched payout',
  UNMATCHED_BANK_DEPOSIT: 'Unmatched bank deposit',
  AMBIGUOUS_TIE: 'Ambiguous tie',
  UNMATCHED_NEAR_AMOUNT: 'Near-amount discrepancy',
  INVALID_SOURCE: 'Check source file',
  INVALID_ROW: 'Check source row',
  DUPLICATE_PAYOUT_ID: 'Duplicate payout ID',
  PAYOUT_TOTAL_MISMATCH: 'Payout total mismatch',
};

function amount(cents: string) {
  return formatMinorUnits(BigInt(cents), 2);
}

function MatchedPairs({ total, worker }: { total: number; worker: ReconciliationWorker }) {
  const page = usePagination(total);
  const pageNumber = page.page;
  const read = useCallback(() => worker.request({ type: 'pairs', page: pageNumber, pageSize: PAGE_SIZE }), [worker, pageNumber]);
  const data = useWorkerPage(total ? read : null);
  return (
    <section className="preview-card payout-preview" aria-label="Matched pair review">
      <h4>Matched pairs</h4>
      <div className="table-scroll" role="region" aria-label="Scrollable matched pairs" tabIndex={0}>
        <table className="payout-pairs-table" aria-label="Matched pairs">
          <thead><tr>
            <th scope="col">Payout</th><th scope="col">Bank deposit</th><th scope="col">Amount</th><th scope="col">Lag</th>
          </tr></thead>
          <tbody>
            {data?.page?.rows.map((row) => (
              <tr key={row.payoutLine}>
                <th scope="row"><code>{row.payoutId}</code><span className="payout-table-meta">Line {row.payoutLine} · {row.payoutDate}</span></th>
                <td><span className="payout-bank-description">{row.bankDescription}</span>
                  {row.bankReference ? <span className="payout-bank-description payout-table-meta">Ref {row.bankReference}</span> : null}
                  <span className="payout-table-meta">Line {row.bankLine} · {row.bankDate}</span></td>
                <td className="payout-amount">{row.currency} {amount(row.amountCents)}</td>
                <td className="payout-number">{row.lagDays} {row.lagDays === 1 ? 'day' : 'days'}</td>
              </tr>
            ))}
            {!total ? <tr><td colSpan={4}>No exact pairs in this run.</td></tr> : null}
            {total > 0 && !data ? <tr><td colSpan={4}>Loading this page…</td></tr> : null}
            {data?.error ? <tr><td colSpan={4}><p className="file-error" role="alert">{data.error}</p></td></tr> : null}
          </tbody>
        </table>
      </div>
      <Pagination state={page} total={total} label="Matched pairs pagination" />
    </section>
  );
}

function Exceptions({ total, worker }: { total: number; worker: ReconciliationWorker }) {
  const page = usePagination(total);
  const pageNumber = page.page;
  const read = useCallback(() => worker.request({ type: 'exceptions', page: pageNumber, pageSize: PAGE_SIZE }), [worker, pageNumber]);
  const data = useWorkerPage(total ? read : null);
  return (
    <section className="preview-card payout-preview" aria-label="Reconciliation exception review">
      <h4>Reconciliation exceptions</h4>
      <div className="table-scroll" role="region" aria-label="Scrollable reconciliation exceptions" tabIndex={0}>
        <table className="payout-exceptions-table" aria-label="Reconciliation exceptions">
          <thead><tr>
            <th scope="col">Finding</th><th scope="col">Payout lines</th><th scope="col">Bank lines</th><th scope="col">Amount difference</th>
          </tr></thead>
          <tbody>
            {data?.page?.rows.map((row, index) => (
              <tr key={index} data-exception-code={row.code}>
                <th scope="row">{EXCEPTION_NAMES[row.code]}
                  <code className="payout-table-meta">{row.code}</code>
                  <span className="payout-table-meta payout-exception-message">{row.message}</span>
                  {row.column ? <span className="payout-table-meta payout-exception-message">{row.column}{row.value === undefined ? '' : ` · ${row.value || '(blank)'}`}</span> : null}
                  {row.expectedCents !== undefined && row.actualCents !== undefined ? (
                    <span className="payout-table-meta">Expected {amount(row.expectedCents)} · supplied {amount(row.actualCents)}</span>
                  ) : null}
                </th>
                <td className="payout-source-lines">{row.payoutLines.length ? row.payoutLines.join(', ') : '—'}</td>
                <td className="payout-source-lines">{row.bankLines.length ? row.bankLines.join(', ') : '—'}</td>
                <td className="payout-amount">{row.deltaCents === null ? '—'
                  : `${row.currency ?? ''} ${amount(row.deltaCents)}`.trim()}</td>
              </tr>
            ))}
            {!total ? <tr><td colSpan={4}>No exceptions in this run.</td></tr> : null}
            {total > 0 && !data ? <tr><td colSpan={4}>Loading this page…</td></tr> : null}
            {data?.error ? <tr><td colSpan={4}><p className="file-error" role="alert">{data.error}</p></td></tr> : null}
          </tbody>
        </table>
      </div>
      <Pagination state={page} total={total} label="Reconciliation exceptions pagination" />
    </section>
  );
}

function CurrencyTotals({ totals }: { totals: ReconciliationPreview['summary']['byCurrency'] }) {
  return (
    <details className="payout-currency-totals">
      <summary>Per-currency totals</summary>
      <div className="table-scroll" role="region" aria-label="Scrollable reconciliation totals" tabIndex={0}>
        <table aria-label="Reconciliation totals by currency">
          <colgroup span={1} /><colgroup span={4} /><colgroup span={4} />
          <thead>
            <tr><th scope="col" rowSpan={2}>Currency</th><th scope="colgroup" colSpan={4}>Payouts</th><th scope="colgroup" colSpan={4}>Bank deposits</th></tr>
            <tr>
              <th scope="col">Total</th><th scope="col">Matched</th><th scope="col">Unmatched</th><th scope="col">Ambiguous</th>
              <th scope="col">Total</th><th scope="col">Matched</th><th scope="col">Unmatched</th><th scope="col">Ambiguous</th>
            </tr>
          </thead>
          <tbody>
            {totals.map((row) => (
              <tr key={row.currency}>
                <th scope="row">{row.currency}</th>
                {[row.totalPayoutCents, row.matchedPayoutCents, row.unmatchedPayoutCents, row.ambiguousPayoutCents,
                  row.totalBankInflowCents, row.matchedBankCents, row.unmatchedBankCents, row.ambiguousBankCents].map((cents, index) => (
                    <td className="payout-number" key={index}>{amount(cents)}</td>
                  ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function PayoutResults({ result, worker }: { result: ReconciliationPreview; worker: ReconciliationWorker }) {
  const id = useId();
  const { summary, artifacts } = result;
  return (
    <>
      <dl className="payout-kpis" aria-label="Reconciliation metrics">
        <div><dt>Matched Pairs</dt><dd>{COUNT.format(summary.matchedPairs)}</dd></div>
        <div>
          <dt>Reconciled Total</dt>
          <dd>
            {summary.byCurrency.length ? (
              <ul className="payout-reconciled-amounts">
                {summary.byCurrency.map(({ currency, matchedPayoutCents }) => <li key={currency}>{currency} {amount(matchedPayoutCents)}</li>)}
              </ul>
            ) : '—'}
          </dd>
        </div>
        <div><dt>Unmatched Payouts</dt><dd>{COUNT.format(summary.unmatchedPayouts)}</dd></div>
        <div><dt>Ambiguous / Exceptions</dt><dd>{COUNT.format(summary.ambiguousGroups)} / {COUNT.format(summary.exceptionCount)}</dd></div>
      </dl>
      <div className="preview-grid payout-ledgers">
        <MatchedPairs total={summary.matchedPairs} worker={worker} />
        <Exceptions total={summary.exceptionCount} worker={worker} />
      </div>
      {summary.byCurrency.length ? <CurrencyTotals totals={summary.byCurrency} /> : null}
      <section className="payout-downloads" aria-labelledby={`${id}-downloads`}>
        <h4 id={`${id}-downloads`}>Reconciliation downloads</h4>
        {result.status === 'HOLD' ? <p className="export-warning">Review all exceptions before signing off. The files document the current findings.</p> : null}
        <div className="export-buttons">
          {DOWNLOADS.map(({ key, label, mime }) => (
            <button key={key} type="button" className={`button ${key === 'pairsCsv' ? 'button-primary' : 'button-secondary'}`}
              onClick={() => downloadFile(artifacts[key].filename, artifacts[key].bytes.buffer, mime)}>{label}</button>
          ))}
        </div>
      </section>
    </>
  );
}
