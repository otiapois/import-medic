import { useCallback, useId } from 'react';
import type { PromoCampaignIssue, PromoCampaignRow } from '../../../core/promo-campaign/types';
import type { StorePlatform } from '../../../core/shopify-price-diff/workspace-profile';
import { CustodyFingerprints } from '../CustodyFingerprints';
import { PAGE_SIZE, Pagination, usePagination } from '../Pagination';
import { useWorkerPage } from '../useWorkerPage';
import type { CampaignArtifact, CampaignSummary, CampaignWorker } from './campaignWorker';

const statusLabels: Record<PromoCampaignRow['status'], string> = {
  changed: 'Changed', held: 'Held', skipped: 'Skipped', unchanged: 'Unchanged', 'out-of-scope': 'Out of scope',
};
const issueSources: Record<PromoCampaignIssue['source'], string> = {
  'campaign': 'Campaign', 'baseline': 'Baseline', 'cost-sheet': 'Cost sheet', 'native-verification': 'Local replay',
};

const downloadActions = {
  launch: 'Download Promo Launch CSV',
  revert: 'Download Promo End Revert CSV',
  audit: 'Download JSON Audit',
  signoff: 'Download Campaign Sign-Off (.html)',
} satisfies Record<CampaignArtifact, string>;

export function CampaignExports({ report, onDownload, onVerify }: {
  report?: CampaignSummary;
  onDownload: (artifact: CampaignArtifact) => void;
  onVerify: () => void;
}) {
  const custody = report?.custody;
  return (
    <div className="campaign-downloads">
      <div className="export-buttons">
        {(Object.keys(downloadActions) as CampaignArtifact[]).map((artifact) => (
          <button key={artifact} className={`button ${artifact === 'launch' ? 'button-primary' : 'button-secondary'}`} type="button"
            data-testid={`campaign-download-${artifact}`} disabled={artifact === 'audit' ? !report : !report?.canExport}
            onClick={() => onDownload(artifact)}>{downloadActions[artifact]}</button>
        ))}
        <button className="button button-secondary" type="button" data-testid="campaign-open-verify" disabled={!report?.canExport}
          onClick={onVerify}>Open pair in Verify Before Import</button>
      </div>
      {custody ? <CustodyFingerprints open entries={[
        { field: 'baseline', label: 'Baseline CSV', sha256: custody.baselineSha256 },
        { field: 'cost-sheet', label: 'Cost sheet', sha256: custody.costSheetSha256 },
        { field: 'launch', label: 'Promo Launch CSV', sha256: report.canExport ? custody.launchSha256 ?? undefined : undefined },
        { field: 'revert', label: 'Promo End Revert CSV', sha256: report.canExport ? custody.revertSha256 ?? undefined : undefined },
      ]} /> : null}
    </div>
  );
}

export function CampaignResults({ summary: report, worker, platform, onSkip }: {
  summary: CampaignSummary;
  worker: CampaignWorker;
  platform: StorePlatform;
  onSkip: (line: number, restore: boolean) => void;
}) {
  const { summary, issueCount, rowCount, canExport } = report;
  const totals = [
    ['changed', 'Promo changes', summary.changedRows], ['held', 'Held rows', summary.heldRows],
    ['skipped', 'Skipped rows', summary.skippedRows], ['warnings', 'Rows with warnings', summary.warningRows],
  ] as const;

  return (
    <>
      <dl className="verify-metrics campaign-metrics" data-testid="campaign-summary">
        {totals.map(([key, label, value]) => <div key={key}>
          <dt>{label}</dt><dd data-testid={`campaign-metric-${key}`}>{value.toLocaleString('en-US')}</dd>
        </div>)}
      </dl>
      {canExport && summary.averageDiscountPercent !== null ? <p className="field-help campaign-totals">
        Average discount <strong>{summary.averageDiscountPercent}%</strong> · Total price reduction <strong>{summary.totalPriceReduction}</strong>
      </p> : null}
      {issueCount ? <CampaignIssues worker={worker} total={issueCount} /> : null}
      <CampaignRows worker={worker} total={rowCount} platform={platform} onSkip={onSkip} />
      {canExport ? <p className="field-help campaign-import-note">Import the launch and its matched revert manually. Check the store for intervening price changes before applying the revert.</p> : null}
    </>
  );
}

function CampaignIssues({ worker, total }: { worker: CampaignWorker; total: number }) {
  const id = useId();
  const page = usePagination(total);
  const read = useCallback(() => worker.request({ type: 'issues', page: page.page, pageSize: PAGE_SIZE }), [worker, page.page]);
  const data = useWorkerPage(read);
  return (
    <section className="verify-result-detail" aria-labelledby={id} data-testid="campaign-issue-list">
      <h4 id={id}>Campaign checks ({total.toLocaleString('en-US')})</h4>
      {data?.error ? <p className="file-error" role="alert">{data.error}</p> : data?.page ? (
        <ul className="verify-issues">
          {data.page.rows.map(({ code, source, severity, line, column, message }, index) => (
            <li key={page.start + index} data-issue-code={code}>
              <strong>{severity === 'hold' ? 'Held' : 'Warning'} · {issueSources[source]}{line === undefined ? '' : ` line ${line}`}</strong>
              {column ? <> · <code>{column}</code></> : null}
              <p>{message}</p>
            </li>
          ))}
        </ul>
      ) : <p className="empty-panel" role="status">Loading campaign checks…</p>}
      <Pagination state={page} total={total} label="Campaign check pages" />
    </section>
  );
}

function CampaignRows({ worker, total, platform, onSkip }: {
  worker: CampaignWorker;
  total: number;
  platform: StorePlatform;
  onSkip: (line: number, restore: boolean) => void;
}) {
  const id = useId();
  const page = usePagination(total);
  const read = useCallback(() => worker.request({ type: 'rows', page: page.page, pageSize: PAGE_SIZE }), [worker, page.page]);
  const data = useWorkerPage(total ? read : null);
  const isShopify = platform === 'shopify';
  const secondary = isShopify ? 'Compare-at' : 'Sale price';
  if (!total) return null;
  return (
    <section className="verify-result-detail" aria-labelledby={id} data-testid="campaign-rows">
      <h4 id={id}>Before, promo and revert ({total.toLocaleString('en-US')} rows)</h4>
      {data?.error ? <p className="file-error" role="alert">{data.error}</p> : data?.page ? (
        <div className="preview-card">
          <div className="table-scroll" role="region" aria-labelledby={id} tabIndex={0}>
            <table className="campaign-table" aria-labelledby={id}>
              <thead>
                <tr><th scope="col">SKU / Product</th><th scope="col">Before</th><th scope="col">Promo</th><th scope="col">Revert</th><th scope="col">Review</th></tr>
              </thead>
              <tbody>
                {data.page.rows.map((row) => (
                  <tr key={row.line} data-campaign-line={row.line} data-campaign-sku={row.sku} data-campaign-status={row.status}>
                    <th scope="row">
                      {row.sku ? <code>{row.sku}</code> : <span>No SKU</span>}
                      {row.product ? <span className="price-row-detail">{row.product}</span> : null}
                      <span className="price-row-detail">Line {row.line}</span>
                      {!isShopify && row.regularPrice ? <span className="price-row-detail">Regular <code>{row.regularPrice}</code></span> : null}
                    </th>
                    <CampaignPrice field="before" price={row.beforePrice} secondaryLabel={secondary} secondary={row.beforeCompareAtOrSalePrice} />
                    <CampaignPrice field="promo" price={row.promoPrice} secondaryLabel={secondary} secondary={row.promoCompareAtOrSalePrice} />
                    <CampaignPrice field="revert" price={row.revertPrice} secondaryLabel={secondary} secondary={row.revertCompareAtOrSalePrice} />
                    <td>
                      <strong className={`issue-badge ${row.status === 'held' ? 'badge-review' : row.status === 'changed' ? 'badge-fixed' : ''}`}>{statusLabels[row.status]}</strong>
                      {row.cost !== null ? <span className="price-row-detail">Cost <code>{row.cost}</code></span> : null}
                      {row.issues.length ? <ul className="campaign-row-issues">
                        {row.issues.map(({ code, column, message }, index) => <li key={index} data-issue-code={code}>{column ? <strong>{column} · </strong> : null}{message}</li>)}
                      </ul> : null}
                      {row.status === 'held' || row.status === 'skipped' ? (
                        <button className="button button-secondary button-small" type="button" onClick={() => onSkip(row.line, row.status === 'skipped')}>
                          {row.status === 'skipped' ? 'Restore' : 'Skip'} line {row.line}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : <p className="empty-panel" role="status">Loading campaign rows…</p>}
      <Pagination state={page} total={total} label="Campaign preview pages" />
    </section>
  );
}

function CampaignPrice({ field, price, secondaryLabel, secondary }: {
  field: 'before' | 'promo' | 'revert';
  price: string | null;
  secondaryLabel: string;
  secondary: string | null;
}) {
  return (
    <td data-campaign-cell={field}>
      {price === null ? <span className="blank-cell">Unavailable</span> : <ExactAmount value={price} />}
      {secondary !== null ? <span className="price-row-detail">{secondaryLabel} <ExactAmount value={secondary} /></span> : null}
    </td>
  );
}

function ExactAmount({ value }: { value: string }) {
  return value ? <code>{value}</code> : <span className="blank-cell">Empty</span>;
}
