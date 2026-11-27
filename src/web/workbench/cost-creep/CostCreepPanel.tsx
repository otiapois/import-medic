import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CostCreepMapping } from '../../../core/cost-creep/types';
import { PriceFileInput } from '../PriceFileInput';
import { useSignoffBranding } from '../SignoffBranding';
import { downloadFile } from '../downloads';
import { CostCreepWorker } from './costCreepWorker';
import type { BrowserCostSource, BrowserCostSourceInspection, CostCreepArtifact, CostCreepRun } from './costCreepWorker';
import { CostCreepResults } from './CostCreepResults';
import type { CostCreepReport } from './CostCreepResults';
import { costCreepDemo } from './demo';
import './cost-creep.css';

const MIN_PERIODS = 2;
const MAX_PERIODS = 6;
const COLUMNS = ['skuColumn', 'amountColumn'] as const;

interface SourceDraft {
  source?: BrowserCostSource;
  inspection?: BrowserCostSourceInspection;
  sheetNames?: string[];
  mapping?: CostCreepMapping;
  synthetic?: boolean;
  error?: string;
}

interface PeriodDraft {
  key: number;
  label: string;
  input: SourceDraft;
}

function initialPeriods(): PeriodDraft[] {
  return [{ key: 1, label: 'Q1', input: {} }, { key: 2, label: 'Q2', input: {} }];
}

function buildSource({ source, inspection, mapping }: SourceDraft) {
  if (!source || !inspection) return undefined;
  return { ...source, sheetName: inspection.selectedSheet ?? source.sheetName, mapping };
}

function SourcePicker({ slot, draft, onFiles, onClear, onWorksheet, onMapping }: {
  slot: number | 'retail';
  draft: SourceDraft;
  onFiles: (files: FileList) => void;
  onClear: () => void;
  onWorksheet: (name: string) => void;
  onMapping: (role: keyof CostCreepMapping, column: number | undefined) => void;
}) {
  const { source, inspection, sheetNames, mapping, synthetic, error } = draft;
  const retail = slot === 'retail';
  const name = retail ? 'Baseline' : `Period ${slot}`;
  const title = retail ? 'Store Baseline CSV' : `${name} supplier file`;
  return (
    <PriceFileInput
      side={`creep-${slot}`}
      field={{ title, formats: retail ? 'Drop a store CSV' : 'Drop a supplier CSV or XLSX', label: title, accept: retail ? '.csv' : '.csv,.xlsx' }}
      showTitle={false}
      file={source ? { file: source.file, synthetic } : undefined}
      message={{ reading: Boolean(source && !inspection && !error), error }}
      onLoad={onFiles}
      onClear={onClear}
      clearLabel={`Clear ${title}`}
      worksheet={sheetNames?.length ? (
        <label className="price-sheet">Worksheet
          <select aria-label={`${name} worksheet`} value={source?.sheetName ?? inspection?.selectedSheet ?? sheetNames[0]}
            onChange={(event) => onWorksheet(event.currentTarget.value)}>
            {sheetNames.map((sheet) => <option key={sheet}>{sheet}</option>)}
          </select>
        </label>
      ) : undefined}
    >
      {inspection?.headers.length ? (
        <>
          <p className="field-help price-source-count">
            {inspection.rowCount.toLocaleString('en-US')} {inspection.rowCount === 1 ? 'row' : 'rows'}
          </p>
          <fieldset className="price-fields creep-mapping" aria-label={`${name} column mapping`}>
            {COLUMNS.map((role) => {
              const label = role === 'skuColumn' ? 'SKU column' : retail ? 'retail price column' : 'cost column';
              return (
                <label key={role}>{role === 'skuColumn' ? label : retail ? 'Retail price column' : 'Cost column'}
                  <select aria-label={`${name} ${label}`} value={mapping?.[role] ?? ''} onChange={(event) => {
                    const value = event.currentTarget.value;
                    onMapping(role, value === '' ? undefined : Number(value));
                  }}>
                    <option value="" disabled>Choose a column</option>
                    {inspection.headers.map((header, index) => <option key={index} value={index}>{header || 'Unnamed column'} · column {index + 1}</option>)}
                  </select>
                </label>
              );
            })}
          </fieldset>
        </>
      ) : inspection?.firstIssue ? (
        <p className="file-message file-error" role="alert">{inspection.firstIssue}</p>
      ) : null}
    </PriceFileInput>
  );
}

export default function CostCreepPanel({ active }: { active: boolean }) {
  const id = useId();
  const { branding } = useSignoffBranding();
  const workerRef = useRef<CostCreepWorker | null>(null);
  const periodId = useRef(MIN_PERIODS);
  const fileId = useRef(0);
  const runId = useRef(0);
  const focusPeriod = useRef<number | null>(null);
  const baselineDetails = useRef<HTMLDetailsElement>(null);
  const latest = useRef<CostCreepReport | undefined>(undefined);
  const [periods, setPeriods] = useState(initialPeriods);
  const [retail, setRetail] = useState<SourceDraft>({});
  const [threshold, setThreshold] = useState('10');
  const [currency, setCurrency] = useState('');
  const [retailCurrency, setRetailCurrency] = useState('');
  const [checked, setChecked] = useState<{ input: CostCreepRun; report?: CostCreepReport; error?: string }>();
  const [downloadState, setDownloadState] = useState<{ report: CostCreepReport; busy?: boolean; error?: string }>();

  const inputs = useMemo<CostCreepRun | undefined>(() => {
    if (!threshold.trim() || retail.error) return undefined;
    const mapped = [];
    for (const period of periods) {
      const source = buildSource(period.input);
      if (!source) return undefined;
      mapped.push({ ...source, label: period.label });
    }
    const baseline = buildSource(retail);
    if (retail.source && !baseline) return undefined;
    return {
      periods: mapped,
      retail: baseline ? { ...baseline, currency: retailCurrency.trim() || undefined } : undefined,
      threshold,
      currency: currency.trim() || undefined,
      branding,
    };
  }, [periods, retail, threshold, currency, retailCurrency, branding]);

  const current = checked?.input === inputs ? checked : undefined;
  const report = current?.report;
  const ready = report?.result.status === 'ready';
  const saving = downloadState?.report === report ? downloadState : undefined;
  const allSynthetic = periods.length === 4 && periods.every((period) => period.input.synthetic);
  const sources = [...periods.map((period) => period.input), retail];
  const loading = sources.some(({ source, inspection, error }) => source && !inspection && !error);
  const sourceError = sources.some(({ error }) => error);
  const status = current?.error ? 'Analysis stopped' : ready ? 'Ready to download' : report ? 'Review required' :
    inputs ? 'Analyzing supplier costs…' : loading ? 'Reading local files…' :
      sourceError ? 'Fix the source file selection' : !threshold.trim() ? 'Enter a cumulative creep threshold' : 'Choose a supplier file for every period';

  useLayoutEffect(() => {
    latest.current = active ? report : undefined;
    return () => { latest.current = undefined; };
  }, [active, report]);

  useLayoutEffect(() => {
    if (focusPeriod.current === null) return;
    document.getElementById(`${id}-period-${focusPeriod.current}`)?.focus();
    focusPeriod.current = null;
  }, [id, periods]);

  useEffect(() => () => {
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  useEffect(() => {
    if (!inputs) return;
    let current = true;
    const analysisId = ++runId.current;
    // Coalesce typing in period labels, currencies and the threshold before running the local comparison.
    const timer = window.setTimeout(() => {
      void Promise.resolve().then(async () => {
        const worker = workerRef.current ??= new CostCreepWorker();
        const result = await worker.request({ type: 'build', runId: analysisId, run: inputs });
        if (current) setChecked({ input: inputs, report: { id: analysisId, result, worker } });
      }).catch((error: unknown) => {
        if (current) setChecked({ input: inputs, error: error instanceof Error ? error.message : 'The cost creep analysis could not finish.' });
      });
    }, 150);
    return () => { current = false; window.clearTimeout(timer); };
  }, [inputs]);

  function updateSource(key: BrowserCostSource['key'], update: (input: SourceDraft) => SourceDraft) {
    if (key === 'retail') {
      setRetail(update);
    } else {
      setPeriods((current) => {
        const index = current.findIndex((period) => period.key === key);
        if (index < 0) return current;
        const period = current[index];
        const input = update(period.input);
        if (input === period.input) return current;
        const next = current.slice();
        next[index] = { ...period, input };
        return next;
      });
    }
  }

  function forget(key: BrowserCostSource['key']) {
    void workerRef.current?.request({ type: 'clear', key }).catch(() => undefined);
  }

  function inspect(source: BrowserCostSource, synthetic?: boolean, sheetNames?: string[]) {
    const { key } = source;
    updateSource(key, () => ({ source, synthetic, sheetNames }));
    void Promise.resolve().then(() => (workerRef.current ??= new CostCreepWorker()).request({ type: 'inspect', source })).then((inspection) => {
      updateSource(key, (input) => input.source === source
        ? { ...input, inspection, sheetNames: inspection.sheetNames, mapping: inspection.suggestions }
        : input);
    }, (error: unknown) => {
      updateSource(key, (input) => input.source === source
        ? { ...input, error: error instanceof Error ? error.message : 'The local file could not be read.' }
        : input);
    });
  }

  function sourceControls(key: BrowserCostSource['key'], draft: SourceDraft) {
    return {
      draft,
      onFiles: (files: FileList) => {
        if (!files.length) return;
        const pattern = key === 'retail' ? /\.csv$/i : /\.(csv|xlsx)$/i;
        if (files.length === 1 && pattern.test(files[0].name)) {
          inspect({ key, fileId: ++fileId.current, file: files[0] });
        } else {
          forget(key);
          const error = key === 'retail' ? 'Choose one store baseline CSV.' : 'Choose one supplier CSV or XLSX.';
          updateSource(key, () => ({ error }));
        }
      },
      onClear: () => { forget(key); updateSource(key, () => ({})); },
      onWorksheet: (sheetName: string) => {
        if (draft.source) inspect({ ...draft.source, sheetName }, draft.synthetic, draft.sheetNames);
      },
      onMapping: (role: keyof CostCreepMapping, column: number | undefined) => {
        updateSource(key, (input) => ({ ...input, mapping: { ...input.mapping, [role]: column } }));
      },
    };
  }

  function addPeriod() {
    const key = ++periodId.current;
    const label = Array.from({ length: MAX_PERIODS }, (_, index) => `Q${index + 1}`)
      .find((candidate) => !periods.some((period) => period.label.trim() === candidate))!;
    focusPeriod.current = key;
    setPeriods([...periods, { key, label, input: {} }]);
  }

  function removePeriod(index: number) {
    forget(periods[index].key);
    focusPeriod.current = (periods[index + 1] ?? periods[index - 1]).key;
    setPeriods(periods.filter((_, position) => position !== index));
  }

  function movePeriod(index: number, direction: -1 | 1) {
    const next = periods.slice();
    const destination = index + direction;
    [next[index], next[destination]] = [next[destination], next[index]];
    focusPeriod.current = periods[index].key;
    setPeriods(next);
  }

  function loadDemo() {
    for (const period of periods) forget(period.key);
    const demo = costCreepDemo();
    const next = demo.periods.map(({ label, file }) => ({ key: ++periodId.current, label, file }));
    setPeriods(next.map(({ key, label }) => ({ key, label, input: {} })));
    setThreshold('10');
    setCurrency('USD');
    setRetailCurrency('USD');
    for (const { key, file } of next) inspect({ key, fileId: ++fileId.current, file }, true);
    inspect({ key: 'retail', fileId: ++fileId.current, file: demo.retail }, true);
    if (baselineDetails.current) baselineDetails.current.open = true;
  }

  async function download(artifact: CostCreepArtifact) {
    if (!report || saving?.busy || (artifact !== 'auditJson' && !ready)) return;
    setDownloadState({ report, busy: true });
    try {
      const { bytes, filename, mime } = await report.worker.request({ type: 'download', artifact, runId: report.id });
      if (latest.current === report) downloadFile(filename, bytes, mime);
      setDownloadState((state) => state?.report === report ? undefined : state);
    } catch (error) {
      setDownloadState((state) => state?.report === report ? {
        report, error: error instanceof Error ? error.message : 'The cost creep report could not be saved.',
      } : state);
    }
  }

  return (
    <div className="price-section cost-creep">
      <div className="price-heading">
        <div>
          <h2>Multi-Period Cost Creep</h2>
          <p className="field-help">Compare 2–6 supplier price sheets from oldest to newest. Files stay in this browser.</p>
        </div>
        <button type="button" className="button button-secondary" onClick={loadDemo}>Load Synthetic 4-Quarter Cost-Creep Demo</button>
      </div>
      {allSynthetic ? <p className="field-help creep-demo-note">Synthetic demo with four quarters of sample supplier costs.</p> : null}
      <div className="creep-settings">
        <div>
          <label>Cumulative creep threshold (%)
            <input inputMode="decimal" value={threshold} aria-describedby={`${id}-threshold-help`} aria-invalid={!threshold.trim() || undefined}
              onChange={(event) => setThreshold(event.currentTarget.value)} />
          </label>
          <p className="field-help" id={`${id}-threshold-help`}>The threshold uses the exact percentage before display rounding.</p>
        </div>
        <div>
          <label>Cost currency
            <input autoCapitalize="characters" spellCheck={false} value={currency} placeholder="e.g. USD"
              aria-describedby={`${id}-currency-help`} onChange={(event) => setCurrency(event.currentTarget.value.toUpperCase())} />
          </label>
          <p className="field-help" id={`${id}-currency-help`}>Optional three-letter code for bare costs. Use the same currency across periods.</p>
        </div>
      </div>
      <ol className="creep-periods" aria-label="Supplier periods, oldest to newest">
        {periods.map((period, index) => {
          const position = index + 1;
          const name = `Period ${position}`;
          return (
            <li key={period.key} className="creep-period">
              <h3>{name}</h3>
              <div className="creep-period-controls">
                <label>{name} label
                  <input id={`${id}-period-${period.key}`} value={period.label}
                    onChange={(event) => {
                      const label = event.currentTarget.value;
                      setPeriods((current) => current.map((entry) => entry.key === period.key ? { ...entry, label } : entry));
                    }} />
                </label>
                <div className="creep-period-actions">
                  <button type="button" className="text-button" aria-label={`Move period ${position} earlier`}
                    disabled={index === 0} onClick={() => movePeriod(index, -1)}>Move earlier</button>
                  <button type="button" className="text-button" aria-label={`Move period ${position} later`}
                    disabled={position === periods.length} onClick={() => movePeriod(index, 1)}>Move later</button>
                  <button type="button" className="text-button" aria-label={`Remove period ${position}`}
                    disabled={periods.length === MIN_PERIODS} onClick={() => removePeriod(index)}>Remove</button>
                </div>
              </div>
              <SourcePicker slot={position} {...sourceControls(period.key, period.input)} />
            </li>
          );
        })}
      </ol>
      <button type="button" className="button button-secondary button-small creep-add-period"
        disabled={periods.length === MAX_PERIODS} onClick={addPeriod}>Add period</button>
      <details className="creep-baseline" ref={baselineDetails}>
        <summary>Store Baseline CSV (optional)</summary>
        <p className="field-help">Margin compares the first and latest costs against the same retail price.</p>
        <label>Baseline retail currency
          <input autoCapitalize="characters" spellCheck={false} value={retailCurrency} placeholder="e.g. USD"
            aria-describedby={`${id}-retail-help`} onChange={(event) => setRetailCurrency(event.currentTarget.value.toUpperCase())} />
        </label>
        <p className="field-help" id={`${id}-retail-help`}>Optional three-letter code for bare retail prices. Margin requires a matching cost currency.</p>
        <SourcePicker slot="retail" {...sourceControls('retail', retail)} />
        {retail.error && !retail.source ? (
          <button type="button" className="text-button" onClick={() => {
            setRetail({});
            baselineDetails.current?.querySelector('summary')?.focus();
          }}>Clear baseline selection</button>
        ) : null}
      </details>
      <section className="delta-review creep-review" aria-label="Cost creep review">
        <h3>Cost creep review</h3>
        <p className="delta-state" data-testid="cost-creep-status" data-ready={ready} data-held={report?.result.status === 'blocked'}
          role="status">{status}</p>
        {current?.error ? <p className="file-message file-error" role="alert">{current.error}</p> : null}
        <div className="export-buttons" role="group" aria-label="Cost creep reports">
          <button type="button" className="button button-primary" disabled={!active || !ready || saving?.busy}
            onClick={() => void download('historyCsv')}>Cost-Creep CSV</button>
          <button type="button" className="button button-secondary" disabled={!active || !report || saving?.busy}
            onClick={() => void download('auditJson')}>Audit JSON</button>
          <button type="button" className="button button-secondary" disabled={!active || !ready || saving?.busy}
            onClick={() => void download('briefHtml')}>Vendor Negotiation Brief (.html)</button>
        </div>
        {report?.result.status === 'blocked' ? (
          <p className="field-help">Resolve the blocking issues to download the cost history and negotiation brief. The audit includes the source checks.</p>
        ) : null}
        {saving?.error ? <p className="file-message file-error" role="alert">{saving.error}</p> : null}
        {report ? <CostCreepResults key={report.id} report={report} /> : null}
      </section>
    </div>
  );
}
