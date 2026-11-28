import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { WorkbenchWorker } from '../core/worker/client';
import type { RepairSummary } from '../core/worker/protocol';
import type {
  CreditDebitConvention,
  DateOrder,
  ManualCellEdit,
  PlatformId,
  QuickBooksLayout,
  RepairIssue,
  RepairOptions,
  StripePayPalOutput,
} from '../core/types';
import { SHOPIFY_PRICE_UPDATE_PATH } from './seo/routes';
import { LocalCliCommand } from './workbench/LocalCliCommand';
import { Results } from './workbench/Results';
import { ModeNavigation } from './workbench/ModeNavigation';
import { useSignoffBranding } from './workbench/SignoffBranding';
import { getSample } from './workbench/samples';
import { TabBar } from './workbench/TabBar';
import { downloadFile } from './workbench/downloads';
import type { RepairDownload } from './workbench/downloads';
import { useWorkerSession, WorkerStatus } from './workbench/workerSession';

const CategorizationPanel = lazy(() => import('./workbench/categorization/CategorizationPanel'));

const PLATFORMS = [
  { id: 'shopify-products', label: 'Shopify Products' },
  { id: 'quickbooks-bank', label: 'QuickBooks Bank' },
  { id: 'stripe-paypal', label: 'Stripe / PayPal' },
  { id: 'xero-bank', label: 'Xero Bank CSV' },
  { id: 'freshbooks-expenses', label: 'FreshBooks CSV' },
] as const;

const DEFAULT_OPTIONS: Record<PlatformId, RepairOptions> = {
  'shopify-products': {},
  'quickbooks-bank': { qboLayout: '3col', dateOrder: 'auto', qboCreditDebit: 'auto' },
  'stripe-paypal': { dateOrder: 'auto', stripePayPalOutput: 'accounting', excludePayPalMemo: false, stripePayPalFeeConvention: 'auto' },
  'xero-bank': { dateOrder: 'auto' },
  'freshbooks-expenses': { dateOrder: 'auto' },
};

export type SourceFile = { filename: string } & ({ sample: true; bytes: Uint8Array } | { sample: false; file: File });

export function Workbench({ initialPlatform, accountingHome = false }: { initialPlatform: PlatformId; accountingHome?: boolean }) {
  const { branding } = useSignoffBranding();
  const id = useId();
  const [platform, setPlatform] = useState(initialPlatform);
  const [source, setSource] = useState<SourceFile | null>(null);
  const [platformOptions, setPlatformOptions] = useState(DEFAULT_OPTIONS);
  const [edits, setEdits] = useState<ManualCellEdit[]>([]);
  const [sourceVersion, setSourceVersion] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState('');
  const [confirmedSuggestion, setConfirmedSuggestion] = useState(false);
  const [categorizationOpened, setCategorizationOpened] = useState(false);
  const loaded = useRef<{ source: SourceFile; worker: WorkbenchWorker } | null>(null);
  const { run, invalidate, reset, cancel, resume, paused, progress, error, finished } = useWorkerSession();
  const options = platformOptions[platform];
  const isXero = platform === 'xero-bank';
  const isFreshBooks = platform === 'freshbooks-expenses';
  const inputs = useMemo(() => ({ source, platform, options, edits }), [source, platform, options, edits]);
  const [report, setReport] = useState<{ result: RepairSummary; worker: WorkbenchWorker; inputs: typeof inputs } | null>(null);
  const current = !paused && report?.inputs === inputs;
  const suggestions = !current || source?.sample ? [] : report?.result.suggestions ?? [];

  useEffect(() => {
    const { source, platform, options, edits } = inputs;
    if (!source || paused) return;
    void run(async ({ worker, progress: update, isCurrent }) => {
      if (loaded.current?.worker !== worker || loaded.current.source !== source) {
        await worker.request({ type: 'loadRepair', file: source.sample ? source : source.file }, update);
        if (!isCurrent()) throw new Error('The file selection changed.');
        loaded.current = { worker, source };
      }
      return worker.request({ type: 'repair', platform, options, edits }, update);
    }, (result, worker) => setReport({ result, worker, inputs }), 'repairing');
  }, [inputs, paused, run]);

  function replaceSource(next: SourceFile | null) {
    reset();
    setReport(null);
    setSource(next);
    setEdits([]);
    setFileError('');
    setConfirmedSuggestion(false);
    setSourceVersion((version) => version + 1);
  }

  function selectPlatform(next: PlatformId) {
    if (next === platform) return;
    if (source?.sample) replaceSource(null);
    else {
      invalidate();
      setEdits([]);
    }
    setPlatform(next);
  }

  function loadFile(files: FileList) {
    if (!files.length) return;
    if (files.length !== 1 || !/\.csv$/i.test(files[0].name)) {
      replaceSource(null);
      setFileError('Choose one file with a .csv extension.');
      return;
    }
    replaceSource({ file: files[0], filename: files[0].name, sample: false });
  }

  function dropFile(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setDragging(false);
    void loadFile(event.dataTransfer.files);
  }

  function updateOption<K extends keyof RepairOptions>(key: K, value: RepairOptions[K]) {
    invalidate();
    setPlatformOptions((current) => ({ ...current, [platform]: { ...current[platform], [key]: value } }));
  }

  function saveEdit(issue: RepairIssue, value: string) {
    const { row, column } = issue;
    invalidate();
    setEdits((current) => [
      ...current.filter((edit) => edit.row !== row || edit.column !== column),
      { row, column, value },
    ]);
  }

  function download(format: RepairDownload) {
    if (!current || progress || (format === 'repair-csv' && !report.result.canDownload)) return;
    void run(
      ({ worker, progress: update }) => worker.request({
        type: 'download', format, ...(format === 'repair-bookkeeper-html' && branding ? { branding } : {}),
      }, update),
      ({ filename, bytes, mime }) => downloadFile(filename, bytes, mime),
      'exporting',
    );
  }

  return (
    <section className="workbench" aria-label="CSV repair workbench">
      <div className="workbench-input">
        {accountingHome ? null : <ModeNavigation current="repair" />}
        <div className="workbench-platforms">
          <h2>Choose a platform</h2>
          <TabBar
            id={id}
            label="Import platform"
            items={PLATFORMS}
            active={platform}
            onChange={selectPlatform}
            className="platform-tabs"
            sharedPanel
          />
        </div>
        <div
          className="workbench-platform-panel"
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-${platform}-tab`}
        >
          <div className="workbench-file">
            <h2 id={`${id}-file-heading`} tabIndex={-1}>Add a CSV file</h2>
            <div
              className="drop-zone"
              data-dragging={dragging}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes('Files')) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                setDragging(true);
              }}
              onDragLeave={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                  setDragging(false);
                }
              }}
              onDrop={dropFile}
            >
              <span className="file-symbol" aria-hidden="true">↑</span>
              <p>Drop a CSV file here</p>
              <div className="file-picker">
                <input
                  className="sr-only"
                  id={`${id}-file`}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    const input = event.currentTarget;
                    if (input.files) void loadFile(input.files);
                    input.value = '';
                  }}
                />
                <label className="button button-primary" htmlFor={`${id}-file`}>Choose CSV file</label>
              </div>
            </div>
            <div className="workbench-file-actions">
              <button
                className="sample-button"
                type="button"
                onClick={() => replaceSource({ ...getSample(platform), sample: true })}
              >
                {isXero ? 'Load Synthetic Xero Balance Break Demo'
                  : isFreshBooks ? 'Load Synthetic FreshBooks Sample'
                    : 'Try a Broken Sample CSV'}
              </button>
              {source ? (
                <div className="selected-file">
                  <span title={source.filename}>{source.filename}</span>
                  <button className="text-button" type="button" onClick={() => { replaceSource(null); document.getElementById(`${id}-file`)?.focus(); }}>Clear file</button>
                </div>
              ) : null}
            </div>
            <WorkerStatus progress={progress} paused={paused} finished={finished} error={error} focusHeading={`${id}-file-heading`}
              onCancel={() => { setReport(null); cancel(); }} onResume={resume} />
            {fileError ? <p className="file-message file-error" role="alert">{fileError}</p> : null}
            {suggestions.length && !confirmedSuggestion ? (
              <div className="platform-suggestion" role="region" aria-label="Platform suggestion">
                <p role="status">{suggestions.length > 1 ? 'These headers fit more than one platform. Confirm which format you want to use.' : `The headers look like ${suggestions[0].provider}. Use this suggestion to confirm your platform.`}</p>
                <div>
                  {suggestions.map(({ platform: suggested, provider }) => (
                    <button type="button" key={suggested} className="button button-secondary button-small" onClick={() => {
                      selectPlatform(suggested);
                      setConfirmedSuggestion(true);
                      document.getElementById(`${id}-${suggested}-tab`)?.focus();
                    }}>Use {provider}</button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <aside className="workbench-sidebar" aria-label="Privacy and import settings">
            <div className="privacy-note">
              <span className="privacy-symbol" aria-hidden="true" />
              <div>
                <p><strong>100% Local in Your Browser</strong></p>
                <p>Your CSV never leaves this device. Verify in the DevTools Network tab.</p>
              </div>
            </div>
            {platform === 'quickbooks-bank' ? (
              <fieldset className="repair-options">
                <legend>Import settings</legend>
                <label>
                  QuickBooks output layout
                  <select value={options.qboLayout} onChange={(event) => updateOption('qboLayout', event.currentTarget.value as QuickBooksLayout)}>
                    <option value="3col">3 columns · Amount</option>
                    <option value="4col">4 columns · Credit and Debit</option>
                  </select>
                </label>
                <DateFormatField value={options.dateOrder} onChange={(value) => updateOption('dateOrder', value)} />
                <label>
                  Credit / Debit convention
                  <select value={options.qboCreditDebit} onChange={(event) => updateOption('qboCreditDebit', event.currentTarget.value as CreditDebitConvention)}>
                    <option value="auto">Auto (confirm if ambiguous)</option>
                    <option value="bank">Bank · Credit is money in</option>
                    <option value="intuit">Intuit example · Credit is payments</option>
                  </select>
                </label>
                {options.qboLayout === '4col' ? (
                  <p className="field-help">In the output, map Credit to Money Spent and Debit to Money Received.</p>
                ) : null}
              </fieldset>
            ) : platform === 'stripe-paypal' ? (
              <fieldset className="repair-options">
                <legend>Import settings</legend>
                <label>
                  Export format
                  <select value={options.stripePayPalOutput} onChange={(event) => updateOption('stripePayPalOutput', event.currentTarget.value as StripePayPalOutput)}>
                    <option value="accounting">Standard accounting</option>
                    <option value="quickbooks-3col">QuickBooks Bank · 3 columns</option>
                  </select>
                </label>
                <DateFormatField value={options.dateOrder} onChange={(value) => updateOption('dateOrder', value)} />
                <label className="checkbox-label">
                  <input type="checkbox" checked={options.excludePayPalMemo} onChange={(event) => updateOption('excludePayPalMemo', event.currentTarget.checked)} />
                  <span>Exclude PayPal Memo rows</span>
                </label>
                <label>
                  <span id={`${id}-fee-label`}>Fee convention</span>
                  <select value={options.stripePayPalFeeConvention} aria-labelledby={`${id}-fee-label`} aria-describedby={`${id}-fee-help`}
                    onChange={(event) => updateOption('stripePayPalFeeConvention', event.currentTarget.value as RepairOptions['stripePayPalFeeConvention'])}>
                    <option value="auto">Auto (source headers)</option>
                    <option value="deduction">Stripe / deduction (Gross − Fee)</option>
                    <option value="signed-movement">PayPal / signed movement (Gross + Fee)</option>
                  </select>
                </label>
                <p className="field-help" id={`${id}-fee-help`}>If your export has generic headers, choose the convention used by the source report.</p>
              </fieldset>
            ) : isXero || isFreshBooks ? (
              <fieldset className="repair-options">
                <legend>Import settings</legend>
                <DateFormatField value={options.dateOrder} onChange={(value) => updateOption('dateOrder', value)} helpId={`${id}-date-help`} />
                <p className="field-help" id={`${id}-date-help`}>Choose the date order used by the source for dates like 04/05/2026.</p>
                {isXero ? (
                  <p className="field-help">Import into the Xero bank account for the source currency. Include a Balance or Running Balance column to verify the chain.</p>
                ) : (
                  <p className="field-help">In FreshBooks Expenses, map Merchant to Vendor and Description to Notes. Use the account currency. The Expenses importer reads only the negative rows in a mixed-sign file. Check the transaction types before preparing separate imports.</p>
                )}
              </fieldset>
            ) : (
              <div className="platform-note">
                <h3>Shopify Products CSV</h3>
                <p>Check product headers, variant prices, duplicate SKUs, and image URLs before importing.</p>
                <a className="text-button" href={SHOPIFY_PRICE_UPDATE_PATH}>Compare a supplier price sheet</a>
              </div>
            )}
          </aside>
        </div>
      </div>
      {report ? (
        <Results
          key={`${platform}-${sourceVersion}`}
          result={report.result}
          worker={report.worker}
          current={current}
          busy={Boolean(progress)}
          guardEnabled={options.formulaGuard ?? false}
          onEdit={saveEdit}
          onGuard={(enabled) => updateOption('formulaGuard', enabled)}
          onDownload={download}
        />
      ) : null}
      <div className="price-section local-cli-section">
        <LocalCliCommand mode="repair" getArguments={() => [
          '--platform', platform, 'source.csv',
          ...(options.dateOrder ? ['--date-order', options.dateOrder] : []),
          ...(options.qboLayout ? ['--qbo-layout', options.qboLayout] : []),
          ...(options.qboCreditDebit ? ['--qbo-credit-debit', options.qboCreditDebit] : []),
          ...(options.stripePayPalOutput ? ['--stripe-paypal-output', options.stripePayPalOutput] : []),
          ...(options.stripePayPalFeeConvention ? ['--stripe-paypal-fee-convention', options.stripePayPalFeeConvention] : []),
          ...(options.excludePayPalMemo ? ['--exclude-paypal-memo'] : []),
          ...(options.formulaGuard ? ['--formula-guard'] : []),
        ]}>
          {edits.length ? <p className="field-help">Browser cell corrections stay in this session. Apply those corrections to a local copy of the source before replaying it.</p> : null}
        </LocalCliCommand>
      </div>
      {accountingHome ? (
        <details className="categorization-drawer" onToggle={(event) => {
          if (event.target === event.currentTarget && event.currentTarget.open) setCategorizationOpened(true);
        }}>
          <summary data-testid="categorization-toggle">Auto-Categorize Rules</summary>
          {categorizationOpened ? (
            <Suspense fallback={<p className="field-help" role="status">Opening auto-categorization…</p>}>
              <CategorizationPanel currentSource={current && source && platform !== 'shopify-products' && platform !== 'freshbooks-expenses'
                && report.result.canDownload && !report.result.warnings && !report.result.needsManualReviewCount
                && !report.result.removedRowCount && !edits.length ? { source, headers: report.result.sourceHeaders } : null} />
            </Suspense>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

function DateFormatField({ value, onChange, helpId }: {
  value: DateOrder | undefined;
  onChange: (value: DateOrder) => void;
  helpId?: string;
}) {
  const id = useId();
  return (
    <label htmlFor={id}>
      <span id={`${id}-label`}>Date format</span>
      <select id={id} value={value} aria-labelledby={`${id}-label`} aria-describedby={helpId} onChange={(event) => onChange(event.currentTarget.value as DateOrder)}>
        <option value="auto">Auto (Fail-Closed)</option>
        <option value="MDY">MM/DD/YYYY</option>
        <option value="DMY">DD/MM/YYYY</option>
      </select>
    </label>
  );
}
