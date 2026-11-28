import { useCallback, useId } from 'react';
import { PAGE_SIZE, Pagination, usePagination } from '../Pagination';
import { useWorkerPage } from '../useWorkerPage';
import type { LandedCostSummary, LandedCostWorker } from './landedCostWorker';

export function formatLandedCents(cents: bigint): string {
  const absolute = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

export function LandedCostMetrics({ totals, currency }: { totals: NonNullable<LandedCostSummary['totals']>; currency: string }) {
  const shared = totals.freightCents + totals.insuranceCents + totals.handlingCents + totals.otherChargesCents;
  const amounts = [
    ['fob', 'Total FOB', totals.fobCents],
    ['shared', 'Shared Freight & Fees', shared],
    ['duty', 'Total Customs Duty', totals.dutyCents],
    ['grand', 'Grand Landed Total', totals.landedExtendedCents],
  ] as const;
  return (
    <dl className="landed-cost-kpis" data-testid="landed-cost-kpis">
      {amounts.map(([field, label, cents]) => (
        <div key={field}>
          <dt>{label}</dt>
          <dd data-testid={`landed-cost-total-${field}`}>{formatLandedCents(cents)} <small>{currency}</small></dd>
        </div>
      ))}
      <div className="landed-penny" data-balanced={totals.driftCents === 0n}>
        <dt>Exact Penny Check</dt>
        <dd data-testid="landed-cost-drift">{formatLandedCents(totals.driftCents)} <small>drift</small></dd>
      </div>
    </dl>
  );
}

export function LandedCostIssues({ worker, count }: { worker: LandedCostWorker; count: number }) {
  const id = useId();
  const page = usePagination(count);
  const read = useCallback(() => worker.request({ type: 'issues', page: page.page, pageSize: PAGE_SIZE }), [worker, page.page]);
  const data = useWorkerPage(read);
  return (
    <section className="verify-result-detail landed-cost-issues" aria-labelledby={id} data-testid="landed-cost-issues">
      <h3 id={id}>Shipment checks ({count.toLocaleString('en-US')})</h3>
      {data?.error ? <p className="file-message file-error" role="alert">{data.error}</p> : data?.page ? (
        <ul className="verify-issues">
          {data.page.rows.map(({ code, message, line, lines, column, sku, value }, index) => (
            <li key={page.start + index} data-issue-code={code}>
              <strong>{line == null ? 'Shipment' : `Shipment line ${line}`}
                {sku ? <> · SKU <code>{sku}</code></> : null}
              </strong>
              <p>{message}</p>
              {column ? <p className="field-help">Field <code>{column}</code>{value === undefined ? null : <> · Source value <code>{JSON.stringify(value)}</code></>}</p> : null}
              {lines?.length ? <p className="field-help">Source lines {lines.join(', ')}</p> : null}
            </li>
          ))}
        </ul>
      ) : <p className="field-help" role="status">Loading shipment checks…</p>}
      <Pagination state={page} total={count} label="Shipment check pages" />
    </section>
  );
}

export function LandedCostRows({ worker, count, currency }: { worker: LandedCostWorker; count: number; currency: string }) {
  const id = useId();
  const page = usePagination(count);
  const read = useCallback(() => worker.request({ type: 'rows', page: page.page, pageSize: PAGE_SIZE }), [worker, page.page]);
  const data = useWorkerPage(read);

  return (
    <section className="landed-cost-breakdown" aria-labelledby={id}>
      <h3 id={id}>Per-SKU allocation</h3>
      <p className="field-help" id={`${id}-units`}>Amounts are in {currency}. The unit cost is shown to four decimals and rounded to two for display. The remainder is what is left after dividing the extended cost into whole cents per unit.</p>
      {data?.error ? <p className="file-message file-error" role="alert">{data.error}</p> : data?.page ? (
        <div className="preview-card">
          <div className="table-scroll landed-cost-table" role="region" aria-labelledby={id} data-testid="landed-cost-rows" tabIndex={0}>
            <table aria-labelledby={id} aria-describedby={`${id}-units`}>
              <thead>
                <tr>
                  <th className="line-cell" scope="col">SKU</th>
                  <th scope="col">Qty</th>
                  <th scope="col">FOB subtotal</th>
                  <th scope="col">Freight</th>
                  <th scope="col">Insurance</th>
                  <th scope="col">Port / Brokerage</th>
                  <th scope="col">Other fees</th>
                  <th scope="col">Customs duty</th>
                  <th scope="col">Landed extended</th>
                  <th scope="col">Landed unit cost</th>
                  <th scope="col">Uplift over FOB</th>
                </tr>
              </thead>
              <tbody>
                {data.page.rows.map((row) => (
                  <tr key={row.line} data-source-line={row.line}>
                    <th className="line-cell" scope="row"><code>{row.sku}</code><small>Line {row.line}</small></th>
                    <td>{row.quantity.toString()}</td>
                    <td>{formatLandedCents(row.fobCents)}</td>
                    <td>{formatLandedCents(row.freightCents)}</td>
                    <td>{formatLandedCents(row.insuranceCents)}</td>
                    <td>{formatLandedCents(row.handlingCents)}</td>
                    <td>{formatLandedCents(row.otherChargesCents)}</td>
                    <td>{formatLandedCents(row.dutyCents)}</td>
                    <td>{formatLandedCents(row.landedExtendedCents)}</td>
                    <td>
                      <strong>{row.landedUnitCost}</strong>
                      <small>{row.landedUnitDisplay} rounded</small>
                      <small>{row.unitRemainderCents.toString()}¢ remainder</small>
                    </td>
                    <td>{row.upliftPercent === null ? '—' : `${row.upliftPercent}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : <p className="field-help" role="status">Loading per-SKU allocations…</p>}
      <Pagination state={page} total={count} label="Shipment row pages" />
    </section>
  );
}
