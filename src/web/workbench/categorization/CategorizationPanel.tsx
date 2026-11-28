import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  hasCategorizationHeaders, maxRulePackBytes, serializeRulePack, validateRulePack,
} from '../../../core/accounting/categorization-rules';
import type { BookkeeperRulePack, CategorizationIssue } from '../../../core/accounting/categorization-rules';
import demoCsv from '../../../../fixtures/m23/transactions.csv?raw';
import demoRules from '../../../../fixtures/m23/rules.json?raw';
import type { SourceFile } from '../../Workbench';
import { SignoffBrandingDrawer, useSignoffBranding } from '../SignoffBranding';
import { downloadFile } from '../downloads';
import { CSV_ENCODING_LABELS } from '../fileDisplay';
import { CategorizationResults, IssueList } from './CategorizationResults';
import type { CategorizationJob, CategorizationReply } from './categorization.worker';
import { optionalWholeNumber, RuleEditor } from './RuleEditor';
import './categorization.css';

const PACK_FILENAME = 'bookkeeper-rule-pack.json';
const UTF8 = new TextEncoder();
const INITIAL_PACK = { value: { schemaVersion: 1, rules: [] }, filename: PACK_FILENAME } satisfies PackSelection;
const JSON_MIME = 'application/json;charset=utf-8';

interface PackSelection {
  value: BookkeeperRulePack;
  filename: string;
  bytes?: Uint8Array;
}

interface SourceSelection {
  kind: 'current' | 'local';
  source: SourceFile;
}

export default function CategorizationPanel({ currentSource }: {
  currentSource: { source: SourceFile; headers: readonly string[] } | null;
}) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const importAttempt = useRef(0);
  const [source, setSource] = useState<SourceSelection>();
  const [sourceError, setSourceError] = useState('');
  const [currency, setCurrency] = useState('');
  const [creditDebit, setCreditDebit] = useState<'' | 'bank' | 'intuit'>('');
  const [pack, setPack] = useState<PackSelection>(INITIAL_PACK);
  const [packImport, setPackImport] = useState<{ filename: string; issues?: CategorizationIssue[] }>();
  const [packStatus, setPackStatus] = useState('');
  const [ruleListVersion, setRuleListVersion] = useState(0);
  const [thresholdText, setThresholdText] = useState('');
  const [checked, setChecked] = useState<{ job: CategorizationJob; reply: CategorizationReply }>();
  const { branding } = useSignoffBranding();

  const eligible = currentSource && hasCategorizationHeaders(currentSource.headers) ? currentSource.source : undefined;
  const activeSource = source && (source.kind === 'local' || source.source === eligible) ? source.source : undefined;
  const sourceCurrency = currency.trim();
  const validCurrencyLength = sourceCurrency === '' || /^[A-Z]{3}$/.test(sourceCurrency);
  const threshold = pack.value.unmappedReviewThresholdCents;
  const thresholdInvalid = threshold !== undefined && !Number.isSafeInteger(threshold);
  const ruleInput = useMemo(() => {
    if (packImport || thresholdInvalid) return undefined;
    return { filename: pack.filename, bytes: pack.bytes ?? UTF8.encode(serializeRulePack(pack.value)) };
  }, [pack, packImport, thresholdInvalid]);
  const job = useMemo<CategorizationJob | undefined>(() => activeSource && ruleInput && validCurrencyLength ? {
    source: activeSource, rulePack: ruleInput, sourceCurrency: sourceCurrency || undefined,
    creditDebitConvention: creditDebit || undefined, branding,
  } : undefined, [activeSource, ruleInput, validCurrencyLength, sourceCurrency, creditDebit, branding]);
  const reply = checked?.job === job ? checked?.reply : undefined;
  const result = reply && 'result' in reply ? reply.result : undefined;
  const processing = Boolean(job && !reply);

  useEffect(() => () => { importAttempt.current += 1; }, []);

  useEffect(() => {
    if (!job) return;
    let closed = false;
    let worker: Worker | undefined;
    const timer = window.setTimeout(() => {
      const receive = (reply: CategorizationReply) => {
        if (!closed) setChecked({ job, reply });
        worker?.terminate();
      };
      try {
        worker = new Worker(new URL('./categorization.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<CategorizationReply>) => receive(event.data);
        worker.onerror = (event) => {
          event.preventDefault();
          receive({ error: 'The local categorization worker stopped. Choose the file again to retry.' });
        };
        worker.onmessageerror = () => receive({ error: 'The local categorization result could not be read.' });
        worker.postMessage(job);
      } catch (error) {
        receive({ error: error instanceof Error ? error.message : 'The local categorization worker could not start.' });
      }
    }, 120);
    return () => {
      closed = true;
      window.clearTimeout(timer);
      worker?.terminate();
    };
  }, [job]);

  function selectSource(next?: SourceSelection, message = '') {
    setSource(next);
    setSourceError(message);
    setCurrency('');
    setCreditDebit('');
  }

  function updatePack(value: BookkeeperRulePack) {
    importAttempt.current += 1;
    setPack({ value, filename: PACK_FILENAME });
    setPackImport(undefined);
    setPackStatus('');
  }

  function loadPack(bytes: Uint8Array, filename: string) {
    const validated = validateRulePack(bytes);
    if (!validated.ok) {
      setPackImport({ filename, issues: validated.issues });
      return;
    }
    setPack({ value: validated.value, filename, bytes });
    setThresholdText(validated.value.unmappedReviewThresholdCents?.toString() ?? '');
    setPackImport(undefined);
    setRuleListVersion((version) => version + 1);
    setPackStatus(`Rule pack loaded · ${filename}`);
  }

  async function readPack(file: File) {
    const attempt = ++importAttempt.current;
    setPackImport({ filename: file.name });
    setPackStatus('');
    if (file.size > maxRulePackBytes) {
      setPackImport({ filename: file.name, issues: [{ code: 'invalid-rule-pack', message: 'Use a rule pack no larger than 512 KiB.' }] });
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (attempt === importAttempt.current) loadPack(bytes, file.name);
    } catch (error) {
      if (attempt === importAttempt.current) setPackImport({ filename: file.name, issues: [{ code: 'file-read',
        message: error instanceof Error ? error.message : 'The rule pack could not be read.' }] });
    }
  }

  function loadDemo() {
    importAttempt.current += 1;
    setPackStatus('');
    selectSource({ kind: 'local', source: { sample: true, filename: 'transactions.csv', bytes: UTF8.encode(demoCsv) } });
    loadPack(UTF8.encode(demoRules), 'rules.json');
  }

  return (
    <section className="categorization-panel" aria-label="Bookkeeper auto-categorization" data-testid="categorization-panel">
      <header className="categorization-heading-row categorization-intro">
        <h2>Bookkeeper auto-categorization</h2>
        <button className="button button-secondary" type="button" onClick={loadDemo}>Load Synthetic SaaS &amp; GCC/UK VAT Rule Pack Demo</button>
        <p className="field-help">Apply ordered account and tax rules to a local accounting CSV. The demo uses synthetic transactions and sample rates.</p>
      </header>

      <div className="categorization-source">
        <h3>Accounting source</h3>
        <div className="categorization-buttons">
          <div className="file-picker">
            <input className="sr-only" id={`${id}-csv`} ref={fileInput} type="file" data-testid="categorization-csv" accept=".csv,text/csv"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (!file) return;
                if (/\.csv$/i.test(file.name)) selectSource({ kind: 'local', source: { sample: false, file, filename: file.name } });
                else selectSource(undefined, 'Choose a file with a .csv extension.');
              }} />
            <label className="button button-secondary" htmlFor={`${id}-csv`}>Choose Categorization CSV</label>
          </div>
          <button className="button button-secondary" type="button" disabled={!eligible} aria-describedby={`${id}-source-help`}
            onClick={() => { if (eligible) selectSource({ kind: 'current', source: eligible }); }}>Use Current Source CSV</button>
        </div>
        <p id={`${id}-source-help`} className="field-help">Current source uses the original bytes and line numbers after an eligible accounting repair with no unresolved checks, manual edits, or removed rows.</p>
        {activeSource ? (
          <div className="selected-file categorization-chosen-file" data-testid="categorization-source-file">
            <strong>{activeSource.filename}</strong>
            {activeSource.sample ? <span>Synthetic file</span> : null}
            {result?.encoding ? <span>{CSV_ENCODING_LABELS[result.encoding]}</span> : null}
            <button type="button" className="text-button" onClick={() => { selectSource(); fileInput.current?.focus(); }}>Clear categorization CSV</button>
          </div>
        ) : source ? <p className="field-help" role="status">The selected repair source is unavailable. Choose a local CSV or use the current verified source.</p> : null}
        {sourceError ? <p className="file-message file-error" role="alert">{sourceError}</p> : null}
        {activeSource ? (
          <div className="categorization-fields categorization-source-options">
            <label>Source currency (if CSV has none)
              <input value={currency} maxLength={3} placeholder="Optional, e.g. GBP" autoCapitalize="characters" spellCheck={false}
                aria-invalid={!validCurrencyLength || undefined} aria-describedby={!validCurrencyLength ? `${id}-currency-help` : undefined}
                onChange={(event) => setCurrency(event.currentTarget.value.toUpperCase())} />
              {!validCurrencyLength ? <span id={`${id}-currency-help`}>Enter a three-letter currency code or leave blank.</span> : null}
            </label>
            <label>Credit / Debit convention
              <select value={creditDebit} onChange={(event) => setCreditDebit(event.currentTarget.value as typeof creditDebit)}>
                <option value="">Use signed or named columns</option>
                <option value="bank">Bank · Credit is money in</option>
                <option value="intuit">Intuit example · Credit is payments</option>
              </select>
            </label>
          </div>
        ) : null}
      </div>

      <div className="categorization-layout">
        <section className="categorization-rules" aria-label="Bookkeeper rule pack">
          <h3>Bookkeeper rule pack</h3>
          <div className="categorization-buttons">
            <div className="file-picker">
              <input className="sr-only" id={`${id}-rules`} type="file" data-testid="categorization-rules-json" accept=".json,application/json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) void readPack(file);
                }} />
              <label className="button button-secondary button-small" htmlFor={`${id}-rules`}>Load Rule Pack (.json)</label>
            </div>
            <button className="button button-secondary button-small" type="button" disabled={!ruleInput} onClick={() => {
              if (!ruleInput) return;
              downloadFile(PACK_FILENAME, new Uint8Array(ruleInput.bytes).buffer, JSON_MIME);
              setPackStatus('Rule pack saved as a local JSON file.');
            }}>Save Rule Pack (.json)</button>
          </div>
          {packStatus ? <p className="field-help" role="status">{packStatus}</p> : null}
          {packImport ? (packImport.issues ? (
            <div className="categorization-import-error">
              <p role="alert">Could not load {packImport.filename}.</p>
              <IssueList issues={packImport.issues} />
              <button className="text-button" type="button" onClick={() => setPackImport(undefined)}>Keep current rules</button>
            </div>
          ) : <p className="field-help" role="status">Reading {packImport.filename}…</p>) : null}
          <div className="categorization-fields">
            <label>Conflict policy
              <select value={pack.value.conflictPolicy ?? 'fail-on-ambiguous-match'} onChange={(event) => {
                updatePack({ ...pack.value, conflictPolicy: event.currentTarget.value as BookkeeperRulePack['conflictPolicy'] });
              }}>
                <option value="fail-on-ambiguous-match">Hold on conflicting matches</option>
                <option value="first-match-wins">First matching rule wins</option>
              </select>
            </label>
            <label>Unmapped review threshold (cents)
              <input inputMode="numeric" placeholder="Optional" value={thresholdText} aria-invalid={thresholdInvalid || undefined}
                aria-describedby={`${id}-threshold-help`} onChange={(event) => {
                  const text = event.currentTarget.value;
                  setThresholdText(text);
                  updatePack({ ...pack.value, unmappedReviewThresholdCents: optionalWholeNumber(text) });
                }} />
            </label>
          </div>
          <p className="field-help" id={`${id}-threshold-help`}>{thresholdInvalid
            ? 'Enter the threshold as a whole number of cents between 0 and 9,007,199,254,740,991.'
            : 'An uncategorized transaction whose absolute amount exceeds the threshold holds the pack.'}</p>
          <RuleEditor key={ruleListVersion} pack={pack.value} onChange={updatePack} />
        </section>

        <section className="categorization-review" aria-label="Categorization review">
          <h3>Categorization review</h3>
          <p className="categorization-status" role="status" data-testid="categorization-status" data-state={result?.status}>
            {packImport ? 'Review updates after the rule pack is confirmed.'
              : !activeSource ? 'Choose an accounting CSV or load the synthetic demo.'
                : !validCurrencyLength || !ruleInput ? 'Check the source and rule settings.'
                  : processing ? 'Applying rules locally…'
                    : result?.status === 'ready' ? 'Categorization pack ready for review.'
                      : result?.status === 'blocked' ? 'Categorization held. Review the issues before exporting CSVs.'
                        : 'Categorization stopped.'}
          </p>
          {reply && 'error' in reply ? <p className="file-message file-error" role="alert">{reply.error}</p> : null}
          {result ? <CategorizationResults result={result} /> : null}
          <SignoffBrandingDrawer allowProfileLoad />
        </section>
      </div>
    </section>
  );
}
