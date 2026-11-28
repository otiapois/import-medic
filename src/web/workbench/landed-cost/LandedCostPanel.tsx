import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { containerDemoCsv, containerDemoOptions } from '../../../core/landed-cost/demo';
import { downloadFile } from '../downloads';
import { PriceFileInput } from '../PriceFileInput';
import { SignoffBrandingDrawer, useSignoffBranding } from '../SignoffBranding';
import { formatLandedCents, LandedCostIssues, LandedCostMetrics, LandedCostRows } from './LandedCostReview';
import { LandedCostWorker } from './landedCostWorker';
import type { LandedCostArtifact, LandedCostOptions, LandedCostSummary } from './landedCostWorker';
import './landed-cost.css';

const INVOICE_FIELD = {
  title: 'Shipment invoice', formats: 'Drop one shipment invoice (.csv or .xlsx)',
  label: 'Choose shipment invoice', accept: '.csv,.xlsx',
};
const METHODS = [
  ['by-value', 'Value', 'Uses the extended FOB value of each line.'],
  ['by-weight', 'Weight', 'Every line needs a positive Unit Weight Kg.'],
  ['by-cbm', 'CBM', 'Every line needs a positive Unit Volume CBM.'],
  ['by-units', 'Units', 'Uses the quantity on each line.'],
] as const;
const CHARGES = [
  ['freightCents', 'Freight'], ['insuranceCents', 'Insurance'],
  ['handlingCents', 'Port/Brokerage'], ['otherChargesCents', 'Other charges (optional)'],
] as const;
const DOWNLOADS = [
  ['csv', 'Download True Landed Cost CSV'],
  ['audit', 'Download Landed Cost Audit JSON'],
  ['html', 'Download Branded Landed-Cost Sheet (.html)'],
] as const;

type Charge = typeof CHARGES[number][0];
type Draft = Pick<LandedCostOptions, 'method' | 'dutyBase'> & {
  file?: { file: File; synthetic?: boolean };
  fileError?: string;
  worksheet?: string;
  sourceCurrency: string;
  currency: string;
  fxRate: string;
  fxConfirmed: boolean;
  charges: Record<Charge, string>;
};
type Inspection = { file: File; names?: string[]; error?: string };
type Completion = {
  id: number;
  draft: Draft;
  branding: LandedCostOptions['branding'];
  worker?: LandedCostWorker;
  summary?: LandedCostSummary;
  error?: string;
};
const INITIAL_DRAFT: Draft = {
  sourceCurrency: '', currency: '', fxRate: '', fxConfirmed: false, method: 'by-value', dutyBase: 'FOB',
  charges: { freightCents: '0.00', insuranceCents: '0.00', handlingCents: '0.00', otherChargesCents: '' },
};

function chargeCents(value: string): bigint | null {
  const amount = /^(\d{1,30})(?:\.(\d{1,2}))?$/.exec(value.trim());
  return amount ? BigInt(amount[1] + (amount[2] ?? '').padEnd(2, '0')) : null;
}

export default function LandedCostPanel({ active }: { active: boolean }) {
  const id = useId();
  const { branding } = useSignoffBranding();
  const [draft, setDraft] = useState<Draft>(INITIAL_DRAFT);
  const [inspection, setInspection] = useState<Inspection>();
  const [completion, setCompletion] = useState<Completion>();
  const [downloadState, setDownloadState] = useState<{ id: number; pending?: boolean; error?: string }>();
  const currentWorker = useRef<LandedCostWorker | undefined>(undefined);
  const sequence = useRef(0);

  const { file, currency, sourceCurrency, fxRate, fxConfirmed, method, dutyBase } = draft;
  const workbook = file && /\.xlsx$/i.test(file.file.name) ? file.file : undefined;
  const workbookInspection = inspection?.file === workbook ? inspection : undefined;
  const sheetNames = workbookInspection?.names;
  const sheetName = draft.worksheet ?? (sheetNames?.length === 1 ? sheetNames[0] : undefined);
  const readingWorkbook = Boolean(workbook && !workbookInspection);
  const waitingForSheet = Boolean(sheetNames?.length && !sheetName);
  const currenciesValid = /^[A-Z]{3}$/.test(sourceCurrency) && /^[A-Z]{3}$/.test(currency);
  const needsFx = currenciesValid && sourceCurrency !== currency;
  const rate = fxRate.trim();
  const rateValid = /^\d+(?:\.\d+)?$/.test(rate) && /[1-9]/.test(rate);
  const chargeValues = useMemo(() => ({
    freightCents: chargeCents(draft.charges.freightCents),
    insuranceCents: chargeCents(draft.charges.insuranceCents),
    handlingCents: chargeCents(draft.charges.handlingCents),
    otherChargesCents: draft.charges.otherChargesCents.trim() ? chargeCents(draft.charges.otherChargesCents) : 0n,
  }), [draft.charges]);
  const { freightCents, insuranceCents, handlingCents, otherChargesCents } = chargeValues;
  const chargesValid = freightCents !== null && insuranceCents !== null && handlingCents !== null && otherChargesCents !== null;
  const readyToCalculate = Boolean(active && file && !draft.fileError
    && (!workbook || (sheetName && sheetNames?.includes(sheetName)))
    && currenciesValid && chargesValid && (!needsFx || (rateValid && fxConfirmed)));
  const latest = active && completion?.draft === draft && completion.branding === branding ? completion : undefined;
  const run = latest && latest.worker === currentWorker.current && latest.summary ? latest : undefined;

  useEffect(() => {
    if (!active || !workbook || workbookInspection) return;
    let current = true;
    let inspector: LandedCostWorker | undefined;
    async function inspect(file: File) {
      try {
        inspector = new LandedCostWorker();
        const names = await inspector.request({ type: 'worksheets', file });
        if (current) setInspection(names.length ? { file, names } : { file, error: 'This workbook has no visible worksheets.' });
      } catch (error) {
        if (current) setInspection({ file, error: error instanceof Error ? error.message : 'The workbook could not be read.' });
      } finally {
        inspector?.terminate();
      }
    }
    void inspect(workbook);
    return () => { current = false; inspector?.terminate(); };
  }, [active, workbook, workbookInspection]);

  useLayoutEffect(() => {
    if (!readyToCalculate || !file || !chargesValid) return;
    const job = {
      type: 'build', file: file.file, sheetName,
      options: { currency, sourceCurrency, method, dutyBase, branding,
        freightCents, insuranceCents, handlingCents, otherChargesCents,
        ...(needsFx ? { fxRate: rate } : {}) },
    } as const;
    let worker: LandedCostWorker | undefined;
    let current = true;
    const id = ++sequence.current;
    const timer = window.setTimeout(async () => {
      try {
        worker = new LandedCostWorker();
        currentWorker.current = worker;
        const summary = await worker.request(job);
        if (current) setCompletion({ id, draft, branding, worker, summary });
      } catch (error) {
        if (current) setCompletion({ id, draft, branding, error: error instanceof Error ? error.message : 'The local calculation could not finish.' });
      }
    }, 160);
    return () => {
      current = false;
      window.clearTimeout(timer);
      worker?.terminate();
      if (currentWorker.current === worker) currentWorker.current = undefined;
    };
  }, [readyToCalculate, file, sheetName, currency, sourceCurrency, method, dutyBase, branding, needsFx, rate, draft,
    chargesValid, freightCents, insuranceCents, handlingCents, otherChargesCents]);

  function change(patch: Partial<Draft>) {
    currentWorker.current?.terminate();
    currentWorker.current = undefined;
    setDraft((previous) => ({ ...previous, ...patch }));
  }

  function loadInvoice(files: FileList) {
    if (!files.length) return;
    const selected = files.length === 1 && /\.(csv|xlsx)$/i.test(files[0].name) ? { file: files[0] } : undefined;
    change({ file: selected, worksheet: undefined, fxConfirmed: false, fileError: selected ? undefined : 'Choose one shipment invoice with a .csv or .xlsx extension.' });
  }

  function loadDemo() {
    const { currency, method, dutyBase } = containerDemoOptions;
    change({
      ...INITIAL_DRAFT, currency, sourceCurrency: currency, method, dutyBase, fileError: undefined, worksheet: undefined,
      file: { file: new File([containerDemoCsv], 'synthetic-container-invoice.csv', { type: 'text/csv' }), synthetic: true },
      charges: {
        freightCents: formatLandedCents(BigInt(containerDemoOptions.freightCents)),
        insuranceCents: formatLandedCents(BigInt(containerDemoOptions.insuranceCents)),
        handlingCents: formatLandedCents(BigInt(containerDemoOptions.handlingCents)),
        otherChargesCents: formatLandedCents(BigInt(containerDemoOptions.otherChargesCents ?? 0)),
      },
    });
  }

  async function download(artifact: LandedCostArtifact) {
    if (!run?.worker) return;
    const { id, worker } = run;
    setDownloadState({ id, pending: true });
    try {
      const file = await worker.request({ type: 'download', artifact });
      if (currentWorker.current === worker) {
        downloadFile(file.filename, file.bytes, file.mime);
        setDownloadState({ id });
      }
    } catch {
      if (currentWorker.current === worker) setDownloadState({ id, error: 'This download could not be prepared.' });
    }
  }

  const summary = run?.summary;
  const ready = summary?.status === 'ready';
  const held = Boolean(summary?.status === 'blocked' || latest?.error || draft.fileError || workbookInspection?.error);
  const currentDownload = downloadState?.id === run?.id ? downloadState : undefined;
  const status = ready ? 'Landed costs are ready.'
    : held ? 'Landed cost downloads held. Review the shipment checks.'
    : readingWorkbook ? 'Reading visible worksheets locally…'
    : waitingForSheet ? 'Choose a visible shipment worksheet to continue.'
    : !file ? 'Choose a shipment invoice or load the synthetic demo.'
    : !currenciesValid ? 'Enter the three-letter FOB invoice and target store currencies.'
    : !chargesValid ? 'Enter valid freight and fee amounts in the target store currency.'
    : needsFx && (!rateValid || !fxConfirmed) ? 'Enter and confirm the manual FX rate to continue.'
    : 'Calculating landed costs locally…';

  return (
    <section className="price-section landed-cost-panel" aria-labelledby={id} data-testid="landed-cost-panel">
      <div className="price-heading">
        <div>
          <h2 id={id}>Landed Cost Calculator</h2>
          <p className="field-help">Allocate freight, fees, and customs duty across a shipment. Files stay in this browser.</p>
        </div>
        <button type="button" className="button button-secondary button-small" onClick={loadDemo}>Load Synthetic Container Import Demo</button>
      </div>
      <div className="landed-cost-setup">
        <PriceFileInput side="landed-invoice" field={INVOICE_FIELD} inputTestId="landed-cost-invoice-input" file={file}
          message={{ reading: readingWorkbook, error: draft.fileError ?? workbookInspection?.error }}
          onLoad={loadInvoice} onClear={() => change({ file: undefined, fileError: undefined, worksheet: undefined, fxConfirmed: false })}
          clearLabel="Clear shipment invoice"
          worksheet={sheetNames?.length ? (
            <div className="price-sheet">
              <label htmlFor={`${id}-sheet`}>Shipment worksheet</label>
              <select id={`${id}-sheet`} value={sheetName ?? ''} onChange={(event) => change({ worksheet: event.currentTarget.value || undefined, fxConfirmed: false })}>
                {sheetNames.length > 1 ? <option value="">Choose a visible worksheet</option> : null}
                {sheetNames.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </div>
          ) : undefined}>
          <p className="field-help landed-invoice-columns">Required columns are SKU, Quantity, and FOB Unit Cost. Duty Rate %, HS Code, Description, Unit Weight Kg, and Unit Volume CBM are optional.</p>
        </PriceFileInput>
        <fieldset className="landed-cost-settings">
          <legend>Shipment settings</legend>
          <div className="price-fields landed-currency-fields">
            <label>FOB invoice currency
              <input value={sourceCurrency} maxLength={3} placeholder="USD" autoComplete="off" spellCheck={false}
                aria-invalid={Boolean(sourceCurrency && !/^[A-Z]{3}$/.test(sourceCurrency)) || undefined}
                onChange={(event) => change({ sourceCurrency: event.currentTarget.value.toUpperCase(), fxConfirmed: false })} />
            </label>
            <label>Target store currency
              <input value={currency} maxLength={3} placeholder="USD" autoComplete="off" spellCheck={false}
                aria-invalid={Boolean(currency && !/^[A-Z]{3}$/.test(currency)) || undefined}
                onChange={(event) => change({ currency: event.currentTarget.value.toUpperCase(), fxConfirmed: false })} />
            </label>
            <div>
              <label htmlFor={`${id}-method-input`}>Allocation method</label>
              <select id={`${id}-method-input`} value={method} aria-describedby={`${id}-method`}
                onChange={(event) => change({ method: event.currentTarget.value as Draft['method'] })}>
                {METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`${id}-duty-input`}>Duty base</label>
              <select id={`${id}-duty-input`} value={dutyBase} aria-describedby={`${id}-duty`}
                onChange={(event) => change({ dutyBase: event.currentTarget.value as Draft['dutyBase'] })}>
                <option value="FOB">FOB</option>
                <option value="CIF">CIF</option>
              </select>
            </div>
          </div>
          <div className="landed-settings-help">
            <p id={`${id}-method`} className="field-help">{METHODS.find(([value]) => value === method)?.[2]}</p>
            <p id={`${id}-duty`} className="field-help">{dutyBase === 'FOB' ? 'Duty applies to FOB goods only.' : 'Duty applies to FOB goods plus allocated freight and insurance.'}</p>
          </div>
          {needsFx ? (
            <div className="landed-cost-fx">
              <div className="price-fields">
                <label>Manual FX rate
                  <input value={fxRate} inputMode="decimal" autoComplete="off" maxLength={40} aria-describedby={`${id}-fx`}
                    aria-invalid={Boolean(fxRate && !rateValid) || undefined}
                    onChange={(event) => change({ fxRate: event.currentTarget.value, fxConfirmed: false })} />
                </label>
              </div>
              <p id={`${id}-fx`} className="field-help">Enter the amount in {currency} for 1 {sourceCurrency}. This rate converts FOB goods only.</p>
              <label className="checkbox-label">
                <input type="checkbox" checked={fxConfirmed} disabled={!rateValid}
                  onChange={(event) => change({ fxConfirmed: event.currentTarget.checked })} />
                <span>Confirm manual FX rate</span>
              </label>
            </div>
          ) : null}
          <p className="field-help landed-fees-help" id={`${id}-fees`}>
            Enter shipment charges { /^[A-Z]{3}$/.test(currency) ? `in ${currency}` : 'in the target store currency' }. Use up to two decimal places.
          </p>
          <div className="price-fields landed-charge-fields">
            {CHARGES.map(([field, label]) => (
              <label key={field}>{label}
                <input value={draft.charges[field]} inputMode="decimal" autoComplete="off" maxLength={33}
                  aria-describedby={`${id}-fees`} aria-invalid={chargeValues[field] === null || undefined}
                  onChange={(event) => change({ charges: { ...draft.charges, [field]: event.currentTarget.value } })} />
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <SignoffBrandingDrawer allowProfileLoad />
      <section className="landed-cost-review" aria-labelledby={`${id}-review`}>
        <h3 id={`${id}-review`}>Shipment totals</h3>
        <p className="field-help" data-testid="landed-cost-status" role="status" data-ready={ready} data-held={held}>{status}</p>
        {latest?.error ? <p className="file-message file-error" role="alert">{latest.error}</p> : null}
        {summary?.totals ? <LandedCostMetrics totals={summary.totals} currency={currency} /> : null}
        {run?.worker && summary?.issueCount ? <LandedCostIssues key={run.id} worker={run.worker} count={summary.issueCount} /> : null}
        {run?.worker && summary?.rowCount ? <LandedCostRows key={run.id} worker={run.worker} count={summary.rowCount} currency={currency} /> : null}
        <div className="export-buttons" role="group" aria-label="Landed cost downloads">
          {DOWNLOADS.map(([artifact, label]) => (
            <button className={`button ${artifact === 'csv' ? 'button-primary' : 'button-secondary'}`} key={artifact} type="button"
              data-testid={`landed-cost-download-${artifact}`} disabled={!summary || currentDownload?.pending || (artifact !== 'audit' && !ready)}
              onClick={() => void download(artifact)}>{label}</button>
          ))}
        </div>
        {ready ? <p className="field-help">In Build Update, map Landed Unit Cost as the supplier cost. Wholesale B2B Line-Sheet reads the Cost column, rounded up to whole cents.</p> : null}
        {currentDownload?.error ? <p className="file-message file-error" role="alert">{currentDownload.error}</p> : null}
      </section>
    </section>
  );
}
