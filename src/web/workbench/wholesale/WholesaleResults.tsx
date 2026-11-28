import { useCallback, useId } from 'react';
import { SIGNOFF_ACCENTS } from '../../../core/branding/signoff-brand';
import type { SignoffBrand } from '../../../core/branding/signoff-brand';
import { CustodyFingerprints } from '../CustodyFingerprints';
import { PAGE_SIZE, Pagination, usePagination } from '../Pagination';
import { useWorkerPage } from '../useWorkerPage';
import type { WholesaleArtifact, WholesaleSummary, WholesaleWorker } from './wholesaleWorker';

export type WholesaleRun = { summary: WholesaleSummary; worker: WholesaleWorker };

const issueSource = { baseline: 'Catalog', 'cost-sheet': 'Cost sheet', options: 'Setup', pricing: 'Pricing', native: 'Shopify B2B' };
const buyerDownloads = [
  ['buyer', 'Download Buyer Matrix CSV'],
  ['shopify', 'Download Shopify B2B CSV'],
  ['lineSheet', 'Download Printable Buyer Line-Sheet (.html)'],
] as const;

export function WholesaleBuyerExports({ summary, onDownload }: {
  summary?: WholesaleSummary;
  onDownload: (artifact: WholesaleArtifact) => void;
}) {
  const id = useId();
  return (
    <section className="wholesale-output wholesale-buyer-output" aria-labelledby={id}>
      <h3 id={id}>Buyer-safe downloads</h3>
      <div className="export-buttons">
        {buyerDownloads.map(([artifact, label]) => <button key={artifact} className={`button ${artifact === 'buyer' ? 'button-primary' : 'button-secondary'}`}
          type="button" data-testid={`wholesale-download-${artifact}`} disabled={!summary?.canExport} onClick={() => onDownload(artifact)}>{label}</button>)}
      </div>
      {summary?.canExport ? <CustodyFingerprints entries={[
        { field: 'buyer', label: 'Buyer Matrix CSV', sha256: summary.custody.buyerSha256 ?? undefined },
        { field: 'shopify', label: 'Shopify B2B CSV', sha256: summary.custody.shopifySha256 ?? undefined },
        { field: 'lineSheet', label: 'Printable Buyer Line-Sheet', sha256: summary.custody.lineSheetSha256 ?? undefined },
      ]} /> : null}
    </section>
  );
}

export function WholesaleInternalReview({ run, tierNames, onDownload }: {
  run?: WholesaleRun;
  tierNames: readonly string[];
  onDownload: (artifact: WholesaleArtifact) => void;
}) {
  const id = useId();
  const summary = run?.summary;
  return (
    <section className="wholesale-internal" aria-labelledby={id} data-testid="wholesale-internal-review">
      <h3 id={id}>Internal margin review</h3>
      <p className="field-help">Merchant use only. The table and internal files contain landed costs, guardrail checks and margins.</p>
      {run?.summary.issueCount ? <WholesaleIssues run={run} /> : null}
      {run?.summary.internalCount ? <InternalMatrix run={run} tierNames={tierNames} /> : null}
      <div className="wholesale-output">
        <h4>Merchant-only downloads</h4>
        <div className="export-buttons">
          <button className="button button-secondary" type="button" data-testid="wholesale-download-audit" disabled={!summary}
            onClick={() => onDownload('audit')}>Download Internal Margin Audit JSON</button>
          <button className="button button-secondary" type="button" data-testid="wholesale-download-internal" disabled={!summary?.hasInternalCsv}
            onClick={() => onDownload('internal')}>Download Internal Margin Matrix CSV</button>
        </div>
        {summary ? <CustodyFingerprints entries={[
          { field: 'baseline', label: 'Store catalog CSV', sha256: summary.custody.baselineSha256 ?? undefined },
          { field: 'cost-sheet', label: 'Landed cost and MAP file', sha256: summary.custody.costSheetSha256 ?? undefined },
          { field: 'internal', label: 'Internal Margin Matrix CSV', sha256: summary.custody.internalSha256 ?? undefined },
        ]} /> : null}
      </div>
    </section>
  );
}

function WholesaleIssues({ run: { summary, worker } }: { run: WholesaleRun }) {
  const id = useId();
  const page = usePagination(summary.issueCount);
  const read = useCallback(() => worker.request({ type: 'issues', page: page.page, pageSize: PAGE_SIZE }), [worker, page.page]);
  const data = useWorkerPage(read);
  return (
    <section className="verify-result-detail wholesale-issues" aria-labelledby={id} data-testid="wholesale-issues">
      <h4 id={id}>Wholesale checks ({summary.issueCount.toLocaleString('en-US')})</h4>
      {data?.error ? <p className="file-message file-error" role="alert">{data.error}</p> : data?.page ? (
        <ul className="verify-issues">
          {data.page.rows.map(({ code, source, message, line, lines, sku, tierName, baselineLine, costLine, column }, index) => <li key={page.start + index} data-issue-code={code}>
            <strong>{issueSource[source]}{line == null ? '' : ` line ${line}`}
              {sku ? <> · SKU <code>{sku}</code></> : null}{tierName ? ` · Tier ${tierName}` : ''}</strong>
            <p>{message}</p>
            {column ? <p className="field-help">Field <code>{column}</code></p> : null}
            {baselineLine != null && (source !== 'baseline' || baselineLine !== line) ? <p className="field-help">Catalog line {baselineLine}</p> : null}
            {costLine != null && (source !== 'cost-sheet' || costLine !== line) ? <p className="field-help">Cost sheet line {costLine}</p> : null}
            {lines?.length ? <p className="field-help">Source lines {lines.join(', ')}</p> : null}
          </li>)}
        </ul>
      ) : <p className="field-help" role="status">Loading wholesale checks…</p>}
      <Pagination state={page} total={summary.issueCount} label="Wholesale check pages" />
    </section>
  );
}

function InternalMatrix({ run: { summary, worker }, tierNames }: { run: WholesaleRun; tierNames: readonly string[] }) {
  const id = useId();
  const page = usePagination(summary.internalCount);
  const read = useCallback(() => worker.request({ type: 'internalRows', page: page.page, pageSize: PAGE_SIZE }), [worker, page.page]);
  const data = useWorkerPage(read);
  return (
    <div className="wholesale-matrix">
      <h4 id={id}>Internal margin matrix</h4>
      {data?.error ? <p className="file-message file-error" role="alert">{data.error}</p> : data?.page ? (
        <div className="preview-card">
          <div className="table-scroll" role="region" aria-labelledby={id} data-testid="wholesale-internal-table" tabIndex={0}>
            <table aria-labelledby={id}>
              <thead><tr><th scope="col">SKU / Product</th><th scope="col">Retail price</th><th scope="col">Landed cost</th>
                <th scope="col">MAP</th><th scope="col">Case pack / MOQ</th>
                {tierNames.map((name, index) => <th key={index} scope="col">{name}</th>)}
              </tr></thead>
              <tbody>
                {data.page.rows.map(({ sku, product, line, costLine, retailPrice, landedCost, map, casePack, moq, tiers }, index) => (
                  <tr key={page.start + index} data-wholesale-sku={sku}>
                    <th scope="row"><code>{sku}</code><span className="price-row-detail">{product}</span><span className="price-row-detail">Catalog line {line}</span></th>
                    <td><Amount value={retailPrice} /></td>
                    <td><Amount value={landedCost} />{costLine == null ? null : <span className="price-row-detail">Cost line {costLine}</span>}</td>
                    <td><Amount value={map} /></td>
                    <td><Amount value={casePack} /><span className="price-row-detail">MOQ {moq ?? 'Unavailable'}</span></td>
                    {tierNames.map((_, tierIndex) => {
                      const tier = tiers[tierIndex];
                      return <td key={tierIndex}><Amount value={tier?.unitPrice} />
                        <span className="price-row-detail">MOQ {tier?.minOrderQty ?? 'Unavailable'}</span>
                        <span className="price-row-detail">Margin {tier?.marginPercent == null ? 'Unavailable' : `${tier.marginPercent}%`}</span>
                        <span className="price-row-detail">Profit {tier?.profit ?? 'Unavailable'}</span>
                      </td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : <p className="field-help" role="status">Loading the internal margin matrix…</p>}
      <Pagination state={page} total={summary.internalCount} label="Internal margin matrix pages" />
    </div>
  );
}

function Amount({ value }: { value?: string | null }) {
  return value == null ? <span className="blank-cell">Unavailable</span> : <code>{value}</code>;
}

export function WholesaleBuyerPreview({ run: { summary, worker }, brandLabel, currency, effectiveDate, branding }: {
  run: WholesaleRun;
  brandLabel: string;
  currency: string;
  effectiveDate: string;
  branding?: SignoffBrand;
}) {
  const id = useId();
  const page = usePagination(summary.buyerCount);
  const read = useCallback(() => worker.request({ type: 'buyerRows', page: page.page, pageSize: PAGE_SIZE }), [worker, page.page]);
  const data = useWorkerPage(read);
  const rows = data?.page?.rows;
  const accent = branding ? SIGNOFF_ACCENTS[branding.accentKey] : SIGNOFF_ACCENTS.forest;
  return (
    <section className="wholesale-buyer" aria-labelledby={id} data-testid="wholesale-buyer-preview">
      <div className="wholesale-buyer-header" style={{ backgroundColor: accent.background, color: accent.foreground }}>
        <div><h3 id={id}>Buyer line-sheet preview</h3><p className="wholesale-seller">{brandLabel}</p></div>
        <dl><div><dt>Currency</dt><dd>{currency}</dd></div><div><dt>Effective</dt><dd><time dateTime={effectiveDate}>{effectiveDate}</time></dd></div></dl>
        {branding ? <div className="wholesale-buyer-brand">
          <strong>Prepared by {branding.agencyName}</strong>
          {branding.preparedFor ? <span>Prepared for {branding.preparedFor}</span> : null}
          {branding.contactNote ? <span>{branding.contactNote}</span> : null}
        </div> : null}
      </div>
      {data?.error ? <p className="file-message file-error" role="alert">This buyer preview could not be read.</p> : rows?.length ? (
        <div className="preview-card">
          <div className="table-scroll" role="region" aria-label="Buyer price matrix" data-testid="wholesale-buyer-table" tabIndex={0}>
            <table aria-label="Buyer price matrix">
              <thead><tr><th scope="col">SKU</th><th scope="col">Product</th><th scope="col">Case pack</th>
                {rows[0].tiers.map(({ tierName }) => <th scope="col" key={tierName}>{tierName}<span className="price-row-detail">Unit price / MOQ</span></th>)}
              </tr></thead>
              <tbody>
                {rows.map(({ sku, product, casePack, tiers }) => <tr key={sku} data-wholesale-sku={sku}>
                  <th scope="row"><code>{sku}</code></th><td>{product}</td><td><code>{casePack}</code></td>
                  {tiers.map(({ tierName, unitPrice, minOrderQty }) => <td key={tierName}><code>{unitPrice}</code><span className="price-row-detail">MOQ {minOrderQty}</span></td>)}
                </tr>)}
              </tbody>
            </table>
          </div>
        </div>
      ) : <p className="field-help" role="status">Loading buyer prices…</p>}
      <Pagination state={page} total={summary.buyerCount} label="Buyer price pages" />
    </section>
  );
}
