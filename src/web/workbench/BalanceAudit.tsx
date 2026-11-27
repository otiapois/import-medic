import { useId } from 'react';
import type { RepairSummary } from '../../core/worker/protocol';

export function BalanceAudit({ chain }: { chain: RepairSummary['balanceChain'] }) {
  const id = useId();
  const firstBreak = chain?.breaks[0];
  const firstReason = chain?.reasons[0];
  const status = firstBreak
    ? `Balance break at Line ${firstBreak.row}`
    : chain?.status === 'VERIFIED'
      ? `Verified (${chain.verifiedLinks.toLocaleString('en-US')}/${chain.totalLinks.toLocaleString('en-US')} links)`
      : chain ? 'Chain unverified' : 'Balance chain unavailable';

  return (
    <section className="balance-audit" aria-labelledby={id} data-balance-status={chain?.status}>
      <header>
        <h3 id={id}>Running-Balance Chain Audit</h3>
        <p className="balance-status" role="status">{status}</p>
      </header>
      {chain ? (
        <>
          <dl className="balance-metrics">
            <div><dt>Opening balance</dt><dd>{chain.openingBalance ?? 'Unavailable'}</dd></div>
            <div><dt>Net movement</dt><dd>{chain.netMovement ?? 'Unavailable'}</dd></div>
            <div><dt>Closing balance</dt><dd>{chain.closingBalance ?? 'Unavailable'}</dd></div>
          </dl>
          <p className="balance-details">
            {chain.currency ? <>Source currency <strong>{chain.currency}</strong>.</> : 'Confirm the account currency before importing. The source does not identify one currency.'}
            {chain.direction ? ` Source rows are ${chain.direction === 'ascending' ? 'oldest first' : 'newest first'}.` : null}
          </p>
          {chain.status === 'VERIFIED' && chain.totalLinks === 0 ? (
            <p className="balance-details">The source has one transaction and no adjacent rows to compare.</p>
          ) : null}
          {firstBreak ? (
            <div className="balance-break">
              <dl className="balance-metrics" aria-label={`Balance discrepancy at Line ${firstBreak.row}`}>
                <div><dt>Expected balance</dt><dd>{firstBreak.expected}</dd></div>
                <div><dt>Actual balance</dt><dd>{firstBreak.actual}</dd></div>
                <div><dt>Signed discrepancy</dt><dd>{firstBreak.delta.startsWith('-') || firstBreak.delta.startsWith('+') ? firstBreak.delta : `+${firstBreak.delta}`}</dd></div>
              </dl>
              <p>Check the source statement for missing transactions or incorrect signs. The discrepancy is actual minus expected.</p>
              {chain.breaks.length > 1 ? (
                <p>{chain.breaks.length.toLocaleString('en-US')} breaks total. See Issues &amp; Review or the Bookkeeper Sign-Off for the other lines.</p>
              ) : null}
            </div>
          ) : firstReason ? (
            <div className="balance-details">
              <p><strong>Line {firstReason.row} · {firstReason.column}</strong> {firstReason.message}</p>
              {chain.reasons.length > 1 ? (
                <p>See Issues &amp; Review or the Bookkeeper Sign-Off for the other flagged lines.</p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <p className="balance-details">Include a Balance or Running Balance column in the source CSV to verify the chain.</p>
      )}
    </section>
  );
}
