import { useId } from 'react';
import type { DiffSummary } from '../../core/worker/protocol';
import { Pagination, usePagination } from './Pagination';
import { PriceDiffIssues } from './PriceDiffIssues';
import { formatMarginPercent } from './priceDisplay';

type Rollup = NonNullable<DiffSummary['bom']>;
type Kit = Rollup['kits'][number];
const sourceNames = { supplier: 'Updated supplier cost', baseline: 'Baseline cost fallback', bundle: 'Nested bundle rollup' };

export function BundleCostRollup({ bom, market }: { bom: Rollup; market: boolean }) {
  const heading = useId();
  const page = usePagination(bom.kits.length);
  return (
    <section className="bom-rollup" id={heading} data-testid="bundle-cost-rollup" aria-labelledby={`${heading}-title`}>
      <h3 id={`${heading}-title`}>Bundle Cost Rollup</h3>
      <p className="field-help">
        <strong>{bom.filename}</strong>{bom.worksheet ? ` · Worksheet ${bom.worksheet}` : ''}
        {' · '}{bom.currency ?? (market ? 'Target market currency' : 'Store currency')}
      </p>
      {bom.issues.some(({ blocking }) => blocking)
        ? <p className="bom-hold" role="alert">Bundle BOM checks blocked the native update and rollback CSVs.</p> : null}
      <PriceDiffIssues issues={bom.issues} title="Bundle BOM checks" />
      {bom.kits.length ? (
        <>
          <div className="bom-kits">
            {bom.kits.slice(page.start, page.end).map((kit) => <KitDetail kit={kit} key={kit.sku} />)}
          </div>
          <Pagination state={page} total={bom.kits.length} label="Bundle rollup pages" />
        </>
      ) : null}
    </section>
  );
}

function KitDetail({ kit }: { kit: Kit }) {
  const heading = useId();
  const page = usePagination(kit.components.length);
  return (
    <article className="bom-kit" aria-labelledby={heading} data-testid="bundle-kit">
      <h4 id={heading}>{kit.sku}</h4>
      <p className="field-help">
        {kit.baselineLine === null ? 'Baseline row unavailable' : `Baseline line ${kit.baselineLine}`}
        {' · '}BOM {kit.lines.length === 1 ? 'line' : 'lines'} {kit.lines.join(', ')}
      </p>
      <dl className="bom-metrics">
        <div>
          <dt>Previous kit cost</dt>
          <dd>{kit.oldCost ?? 'Unknown'}{kit.oldCostSource
            ? <small>{kit.oldCostSource === 'baseline' ? 'Baseline cost' : 'Recomputed from baseline component costs'}</small> : null}</dd>
        </div>
        <div><dt>Rolled-up kit cost</dt><dd>{kit.newCost ?? 'Unknown'}</dd></div>
        <div><dt>Projected kit retail</dt><dd>{kit.newRetail ?? 'Unknown'}</dd></div>
        <div><dt>Projected gross margin</dt><dd title={kit.grossMarginPercent === null ? undefined : `${kit.grossMarginPercent}%`}>{formatMarginPercent(kit.grossMarginPercent)}</dd></div>
        <div><dt>Assembly cost</dt><dd>{kit.assemblyCost}{kit.assemblyLine === null ? null : <small>BOM line {kit.assemblyLine}</small>}</dd></div>
      </dl>
      <ul className="bom-components" aria-label={`Components of ${kit.sku}`}>
        {kit.components.slice(page.start, page.end).map(({ sku, line, quantity, unitCost, previousUnitCost, extendedCost, source }) => (
          <li key={line} data-testid="bom-component">
            <div>
              <strong><code>{sku}</code></strong>
              <small>BOM line {line}</small>
            </div>
            <dl className="bom-component-costs">
              <div><dt>Quantity</dt><dd>{quantity}</dd></div>
              <div><dt>Unit cost</dt><dd>{unitCost ?? 'Unknown'}{previousUnitCost !== null && previousUnitCost !== unitCost
                ? <small>Before {previousUnitCost}</small> : null}</dd></div>
              <div><dt>Extended cost</dt><dd>{extendedCost ?? 'Unknown'}</dd></div>
            </dl>
            <p className="bom-component-source">
              {source ? <>
                <strong>{sourceNames[source.kind]}</strong>
                <small>{source.filename}{source.worksheet ? ` · ${source.worksheet}` : ''} · line {source.line} · {source.column}
                  {source.fx ? ` · ${source.fx.sourceCurrency} → ${source.fx.storeCurrency} @ ${source.fx.fxRate}` : source.currency ? ` · ${source.currency}` : ''}</small>
              </> : <strong>Cost source unavailable</strong>}
            </p>
          </li>
        ))}
      </ul>
      <Pagination state={page} total={kit.components.length} label={`Component pages for ${kit.sku}`} />
    </article>
  );
}
