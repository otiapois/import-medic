import { useCallback } from 'react';
import type { PurchaseOrderIssue } from '../../../core/purchase-order/types';
import { Pagination, PAGE_SIZE, usePagination } from '../Pagination';
import { useWorkerPage } from '../useWorkerPage';
import type { PurchaseOrderArtifact, PurchaseOrderReport, PurchaseOrderWorker } from './purchaseOrderWorker';

const NUMBER = new Intl.NumberFormat('en-US');
const COLUMNS = ['Supplier', 'SKUs', 'Units', 'PO subtotal'];

function Diagnostics({ issues, labels }: { issues: readonly PurchaseOrderIssue[]; labels: readonly string[] }) {
  return (
    <ul className="inventory-issues" aria-label="Purchase order diagnostics">
      {issues.map(({ source, code, message, line, lines, supplierIndex, sku, column, value, offers }, index) => {
        const label = supplierIndex === undefined ? undefined : labels[supplierIndex];
        const origin = source === 'inventory' ? 'Inventory CSV' : source === 'run' ? 'Purchase order check'
          : supplierIndex === undefined ? 'Supplier catalog' : `Supplier ${supplierIndex + 1}${label ? ` (${label})` : ''}`;
        const physicalLines = lines?.length ? lines : line === undefined ? [] : [line];

        return (
          <li key={index} data-po-issue={code}>
            <p><strong>{origin}{physicalLines.length ? ` · ${physicalLines.length === 1 ? 'line' : 'lines'} ${physicalLines.join(', ')}` : ''}</strong> {message}</p>
            {sku !== undefined || column !== undefined || value !== undefined ? (
              <p className="inventory-issue-evidence">
                {sku !== undefined ? <span>SKU <code>{sku || '(blank)'}</code></span> : null}
                {column !== undefined ? <span>Column <code>{column}</code></span> : null}
                {value !== undefined ? <span>Value <code>{value || '(blank)'}</code></span> : null}
              </p>
            ) : null}
            {offers?.length ? (
              <ul className="inventory-offers" aria-label="Tied supplier offers">
                {offers.map(({ supplierIndex, line }) => (
                  <li key={`${supplierIndex}-${line}`}>Supplier {supplierIndex + 1} ({labels[supplierIndex]}) · line {line}</li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function PurchaseOrderResults({ runId, worker, result, labels, saving, onDownload }: {
  runId: number;
  worker: PurchaseOrderWorker;
  result: PurchaseOrderReport;
  labels: readonly string[];
  saving: boolean;
  onDownload: (artifact: PurchaseOrderArtifact) => void;
}) {
  const { summary, suppliers, issueCount, targetLocation, quantityBasis, currency, status } = result;
  const ready = status === 'ready';
  const page = usePagination(issueCount);
  const readIssues = useCallback(() => worker.request({ type: 'issues', runId, page: page.page, pageSize: PAGE_SIZE }),
    [worker, runId, page.page]);
  const issues = useWorkerPage(!ready && issueCount ? readIssues : null);
  const amount = (value: string) => currency ? `${currency} ${value}` : value;
  const metrics = [
    ['SKUs Below Reorder', NUMBER.format(summary.belowReorder)],
    ['Total Units Ordered', NUMBER.format(summary.unitsOrdered)],
    ['Split Suppliers', NUMBER.format(summary.supplierCount)],
    ['Total PO Spend', amount(summary.totalSpend)],
  ];

  return (
    <>
      {ready ? (
        <>
          {targetLocation || quantityBasis ? (
            <p className="inventory-scope">
              {targetLocation ? <>Target location <strong>{targetLocation}</strong></> : null}
              {targetLocation && quantityBasis ? ' · ' : null}
              {quantityBasis ? <>Inventory quantity <strong>{quantityBasis}</strong></> : null}
            </p>
          ) : null}
          <dl className="delta-metrics po-metrics" aria-label="Purchase order totals">
            {metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          {suppliers.length ? (
            <div className="delta-table-region inventory-table-region">
              <table className="delta-table po-breakdown" role="table" aria-label="Supplier breakdown">
                <thead role="rowgroup"><tr role="row">{COLUMNS.map((label) => <th key={label} scope="col" role="columnheader">{label}</th>)}</tr></thead>
                <tbody role="rowgroup">
                  {suppliers.map(({ supplierIndex, label, skuCount, unitsOrdered, totalSpend }) => (
                    <tr key={supplierIndex} role="row">
                      <th scope="row" role="rowheader">{label}</th>
                      {[NUMBER.format(skuCount), NUMBER.format(unitsOrdered), amount(totalSpend)].map((value, index) => (
                        <td key={COLUMNS[index + 1]} role="cell"><span className="delta-mobile-label" aria-hidden="true">{COLUMNS[index + 1]}</span>{value}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {suppliers.length ? (
            <div className="po-export-group">
              <h4>Supplier purchase orders</h4>
              <div className="export-buttons" role="group" aria-label="Supplier purchase orders">
                {suppliers.map(({ supplierIndex, label }) => (
                  <button key={supplierIndex} type="button" className="button button-primary" disabled={saving}
                    onClick={() => onDownload(supplierIndex)}>Download PO CSV for {label}</button>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : issueCount ? (
        <div className="delta-issues po-diagnostics">
          <h4>Review source checks ({NUMBER.format(issueCount)})</h4>
          {issues?.error ? <p className="file-message file-error" role="alert">{issues.error}</p> : issues?.page
            ? <Diagnostics issues={issues.page.rows} labels={labels} /> : <p className="field-help" role="status">Reading purchase order diagnostics…</p>}
          <Pagination state={page} total={issueCount} label="Purchase order diagnostics pagination" />
        </div>
      ) : null}
      <div className="po-export-group">
        <h4>Purchase order reports</h4>
        <div className="export-buttons" role="group" aria-label="Purchase order reports">
          {ready ? <button type="button" className="button button-secondary" disabled={saving}
            onClick={() => onDownload('summary')}>Download Consolidated Summary CSV</button> : null}
          <button type="button" className="button button-secondary" disabled={saving}
            onClick={() => onDownload('audit')}>Download PO Audit JSON</button>
          {ready ? <button type="button" className="button button-secondary" disabled={saving}
            onClick={() => onDownload('html')}>Download Branded Offline PO Pack (.html)</button> : null}
        </div>
      </div>
    </>
  );
}
