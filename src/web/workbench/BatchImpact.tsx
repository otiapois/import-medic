import { memo, useId } from 'react';
import type { StorePlatform } from '../../core/shopify-price-diff/workspace-profile';
import type { DiffSummary } from '../../core/worker/protocol';

const counts = new Intl.NumberFormat('en-US');

export const BatchImpact = memo(function BatchImpact({ impact, platform, market, active, queueId, onToggle }: {
  impact: DiffSummary['analytics'];
  platform: StorePlatform;
  market?: string;
  active: boolean;
  queueId: string;
  onToggle: () => void;
}) {
  const id = useId();
  const { histogram, priceExcluded, margin, inventory } = impact;
  const largestBucket = Math.max(1, ...histogram.map(({ count }) => count));
  const compared = histogram.reduce((total, { count }) => total + count, 0);
  const excluded = Object.values(priceExcluded).reduce((total, count) => total + count, 0);
  const affected = margin.watchlistCount;

  return (
    <section className="batch-impact" aria-labelledby={id}>
      <h3 id={id}>Batch Impact &amp; Margin Summary</h3>
      <div className="batch-impact-grid">
        <div className="batch-impact-distribution">
          <h4>Retail price movement</h4>
          <ul className="batch-impact-histogram" aria-label="Retail price movement buckets">
            {histogram.map(({ key, label, count }) => (
              <li key={key} aria-label={`${label}: ${counts.format(count)}`} data-bucket={key}>
                <span>{label}</span>
                <svg className="batch-impact-track" aria-hidden="true" viewBox="0 0 1000 8" preserveAspectRatio="none">
                  <rect width={count ? Math.max(3, Math.round(count / largestBucket * 1000)) : 0} height="8" />
                </svg>
                <strong>{counts.format(count)}</strong>
              </li>
            ))}
          </ul>
          <p className="field-help">{counts.format(compared)} compared · {counts.format(excluded)} excluded.
            {' '}Uses matched rows with a positive baseline and {market ? <>an accepted amount in <code>{market}</code>.</> : `an accepted ${platform === 'shopify' ? 'variant' : 'regular'} price.`}</p>
        </div>
        <div className="batch-impact-metrics">
          <h4>Gross margin</h4>
          <dl className="batch-impact-kpis">
            <div><dt>Average</dt><dd>{margin.averagePercent === null ? 'Unknown' : `${margin.averagePercent}%`}</dd></div>
            <div><dt>Lowest</dt><dd>{margin.lowestPercent === null ? 'Unknown' : `${margin.lowestPercent}%`}</dd></div>
            <div><dt>Highest</dt><dd>{margin.highestPercent === null ? 'Unknown' : `${margin.highestPercent}%`}</dd></div>
          </dl>
          <p className="field-help">{margin.count
            ? `${counts.format(margin.count)} calculable ${margin.count === 1 ? 'margin' : 'margins'}.`
            : 'No calculable margins in this batch.'}
            {' '}(Final retail − landed supplier cost) ÷ final retail. Uses {market ? 'the target market’s' : 'store'} currency and any confirmed FX.
            {platform === 'woocommerce' ? ' Uses sale prices when present.' : platform === 'bigcommerce' ? ' Uses product sale prices when present.' : null} The average weights each known margin equally.</p>
          <button type="button" className="button button-secondary button-small batch-impact-alert"
            aria-pressed={active} aria-controls={queueId} disabled={!active && affected === 0} data-has-alert={affected > 0} onClick={onToggle}>
            Zero / Negative Margin Alert <span>{counts.format(affected)}</span>
          </button>
          {inventory ? (
            <div className="batch-impact-inventory">
              <h4>Mapped stock impact</h4>
              <dl className="batch-impact-kpis">
                <div><dt>Units before</dt><dd>{counts.format(BigInt(inventory.totalQtyBefore))}</dd></div>
                <div><dt>Units after</dt><dd>{counts.format(BigInt(inventory.totalQtyAfter))}</dd></div>
                <div><dt>Net unit change</dt><dd>{inventory.netQtyDelta === '0' || inventory.netQtyDelta.startsWith('-') ? '' : '+'}{counts.format(BigInt(inventory.netQtyDelta))}</dd></div>
                <div><dt>Newly zeroed</dt><dd>{counts.format(inventory.newlyZeroedCount)}</dd></div>
              </dl>
              {inventory.unknownQtyCount ? <p className="field-help">{counts.format(inventory.unknownQtyCount)} with unknown stock excluded.</p> : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
});
