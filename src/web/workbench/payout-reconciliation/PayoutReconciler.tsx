import { useEffect, useId, useMemo, useState } from 'react';
import demoPayouts from '../../../../fixtures/m26/shopify-payouts.csv?raw';
import demoBank from '../../../../fixtures/m26/bank-matched.csv?raw';
import { PriceFileInput } from '../PriceFileInput';
import { SignoffBrandingDrawer, useSignoffBranding } from '../SignoffBranding';
import { PayoutResults } from './PayoutResults';
import { ReconciliationWorker } from './reconciliationWorker';
import type { ReconciliationJob, ReconciliationPreview } from './reconciliationWorker';
import './payout-reconciliation.css';

const CSV_TYPE = 'text/csv';
const ACCEPT_CSV = '.csv,text/csv';
const MAX_LAGS = Array.from({ length: 11 }, (_, days) => days);
const SOURCES = {
  payouts: { title: 'Platform Payout CSV', formats: 'Payout ID or Reference, Payout Date, Net Payout Amount', label: 'Choose Platform Payout CSV', accept: ACCEPT_CSV },
  bank: { title: 'Bank Statement CSV', formats: 'Bank Date, Description, Amount', label: 'Choose Bank Statement CSV', accept: ACCEPT_CSV },
};

interface FileSlot {
  selection?: { file: File; synthetic?: boolean };
  currency?: string;
  error?: string;
}

type Completed = { job: ReconciliationJob } & ({ worker: ReconciliationWorker; preview: ReconciliationPreview } | { error: string });

function useReconciliation(job?: ReconciliationJob) {
  const [completed, setCompleted] = useState<Completed>();
  useEffect(() => {
    if (!job) return;
    let active = true;
    let worker: ReconciliationWorker | undefined;
    const timer = window.setTimeout(async () => {
      try {
        worker = new ReconciliationWorker();
        const preview = await worker.request({ type: 'reconcile', job });
        if (active) setCompleted({ job, worker, preview });
      } catch (error) {
        if (active) setCompleted({ job, error: error instanceof Error ? error.message : 'The local CSVs could not be reconciled.' });
      }
    }, 100);
    return () => {
      active = false;
      window.clearTimeout(timer);
      worker?.terminate();
    };
  }, [job]);
  if (completed && completed.job !== job) {
    setCompleted(undefined);
    return undefined;
  }
  return completed;
}

export default function PayoutReconciler() {
  const id = useId();
  const { branding } = useSignoffBranding();
  const [sources, setSources] = useState<Record<keyof typeof SOURCES, FileSlot>>({ payouts: {}, bank: {} });
  const [maxLagDays, setMaxLagDays] = useState(5);
  const payouts = sources.payouts.selection?.file;
  const bank = sources.bank.selection?.file;
  const payoutCurrency = sources.payouts.currency || undefined;
  const bankCurrency = sources.bank.currency || undefined;
  const currencyInProgress = [payoutCurrency, bankCurrency].some((code) => code && code.length !== 3);
  const job = useMemo(() => payouts && bank && !currencyInProgress
    ? { payouts, bank, payoutCurrency, bankCurrency, maxLagDays, branding } : undefined,
  [payouts, bank, payoutCurrency, bankCurrency, currencyInProgress, maxLagDays, branding]);
  const completed = useReconciliation(job);
  const report = completed && 'preview' in completed ? completed : undefined;
  const error = completed && 'error' in completed ? completed.error : undefined;
  const ready = report?.preview.status === 'READY';
  const hold = Boolean(report && !ready);
  const state = ready ? 'ready' : hold ? 'hold' : error ? 'error' : job ? 'working' : 'waiting';

  function replaceFile(side: keyof typeof SOURCES, files?: FileList) {
    if (files && !files.length) return;
    const field = SOURCES[side];
    const slot: FileSlot = !files ? {} : files.length === 1 && /\.csv$/i.test(files[0].name)
      ? { selection: { file: files[0] } } : { error: `Choose one ${field.title} with a .csv extension.` };
    setSources((current) => ({ ...current, [side]: slot }));
  }

  function loadDemo() {
    setSources({
      payouts: { selection: { file: new File([demoPayouts], 'shopify-payouts.csv', { type: CSV_TYPE }), synthetic: true } },
      bank: { selection: { file: new File([demoBank], 'bank-matched.csv', { type: CSV_TYPE }), synthetic: true } },
    });
    setMaxLagDays(5);
  }

  let status = 'Add both CSVs to start reconciliation.';
  if (ready) status = 'Reconciliation complete. No exceptions found.';
  else if (hold) status = 'Reconciliation requires review. Check the exception queue.';
  else if (error) status = 'Reconciliation stopped.';
  else if (job) status = 'Matching payouts and deposits in this browser…';
  else if (currencyInProgress) status = 'Enter a three-letter currency code or leave the default blank.';

  return (
    <section className="price-section payout-reconciler" aria-labelledby={`${id}-heading`}>
      <header className="price-heading payout-heading">
        <div>
          <h2 id={`${id}-heading`}>Reconcile platform payouts with bank deposits</h2>
          <p className="field-help">Compare month-end CSVs by currency, exact amount, and settlement date. Both files stay in your browser.</p>
        </div>
        <button type="button" className="button button-secondary" onClick={loadDemo}>Load Synthetic Month-End Shopify Payout vs Bank Demo</button>
      </header>

      <div className="price-files payout-sources" role="group" aria-label="Reconciliation source files">
        {(Object.keys(SOURCES) as Array<keyof typeof SOURCES>).map((side) => {
          const slot = sources[side];
          const field = SOURCES[side];
          return (
            <PriceFileInput key={side} side={`payout-${side}`} field={field} inputTestId={`payout-${side}-file`}
              file={slot.selection} message={{ error: slot.error }} clearLabel={`Clear ${field.title}`}
              onLoad={(files) => replaceFile(side, files)} onClear={() => replaceFile(side)}>
              <label className="payout-currency">
                {side === 'payouts' ? 'Payout default currency' : 'Bank default currency'}
                <input value={slot.currency ?? ''} disabled={!slot.selection} placeholder="e.g. USD" maxLength={3} autoComplete="off" spellCheck={false}
                  aria-describedby={`${id}-${side}-currency-help`} aria-invalid={Boolean(slot.currency && slot.currency.length !== 3) || undefined}
                  onChange={(event) => {
                    const currency = event.currentTarget.value.toUpperCase().replace(/[^A-Z]/g, '');
                    setSources((current) => ({ ...current, [side]: { ...current[side], currency } }));
                  }} />
              </label>
              <p id={`${id}-${side}-currency-help`} className="field-help">Use a two-decimal currency code only if this CSV has no Currency column.</p>
            </PriceFileInput>
          );
        })}
      </div>

      <div className="payout-lag-settings">
        <label className="price-sheet" htmlFor={`${id}-lag`}>Settlement lag window (days)</label>
        <select id={`${id}-lag`} value={maxLagDays} aria-describedby={`${id}-lag-help`}
          onChange={(event) => setMaxLagDays(Number(event.currentTarget.value))}>
          {MAX_LAGS.map((days) => <option key={days} value={days}>{days}</option>)}
        </select>
        <p className="field-help" id={`${id}-lag-help`}>A deposit can arrive on the payout date or up to this many calendar days later.</p>
      </div>
      <SignoffBrandingDrawer allowProfileLoad />

      <section className="payout-review" aria-label="Payout reconciliation review">
        <h3>Review reconciliation</h3>
        <p role="status" className="delta-state" data-testid="payout-reconciliation-status" data-state={state} data-ready={ready} data-held={hold}>{status}</p>
        {error ? <p className="file-message file-error" role="alert">{error}</p> : null}
        {report ? <PayoutResults result={report.preview} worker={report.worker} /> : null}
      </section>
    </section>
  );
}
