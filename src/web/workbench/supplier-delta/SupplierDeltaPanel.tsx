import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { PriceFileInput } from '../PriceFileInput';
import { downloadFile } from '../downloads';
import { useSignoffFingerprint } from '../CustodyFingerprints';
import { useSignoffBranding } from '../SignoffBranding';
import { DeltaWorker } from './deltaWorker';
import type { DeltaArtifact, DeltaInspection, DeltaMapping, DeltaSide, DeltaSummary } from './deltaWorker';
import { DeltaResults } from './DeltaResults';

const FIELDS = {
  previous: { label: 'Previous', title: 'Previous supplier sheet', formats: 'Drop a supplier CSV or XLSX', choose: 'Choose previous supplier sheet' },
  next: { label: 'New', title: 'New supplier sheet', formats: 'Drop a supplier CSV or XLSX', choose: 'Choose new supplier sheet' },
};

const ROLES = [
  { key: 'skuColumn', label: 'SKU column', optional: false },
  { key: 'costColumn', label: 'Cost column', optional: false },
  { key: 'inventoryColumn', label: 'Inventory column', optional: true },
] as const;

const EMPTY_MAPPING: DeltaMapping = {};

interface Source {
  file: File;
  sheetName?: string;
  synthetic?: boolean;
  fileId: number;
  sourceId: number;
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

function useDeltaSource(side: DeltaSide, getWorker: () => DeltaWorker, clearWorkerSource: (side: DeltaSide) => void, onChange: () => void) {
  const version = useRef(0);
  const [source, setSource] = useState<Source>();
  const [checked, setChecked] = useState<{ source: Source; inspection?: DeltaInspection; error?: string }>();
  const [override, setOverride] = useState<DeltaMapping>();
  const [fileError, setFileError] = useState('');
  const current = checked?.source === source ? checked : undefined;
  const inspection = current?.inspection;
  const sheetNames = source && checked?.source.fileId === source.fileId ? checked.inspection?.sheetNames : undefined;
  const mapping = override ?? inspection?.suggestions.mapping ?? EMPTY_MAPPING;
  const comparisonSource = useMemo(() => source && inspection ? { sourceId: source.sourceId, mapping } : null, [source, inspection, mapping]);

  useEffect(() => {
    if (!source) return;
    let current = true;
    void Promise.resolve().then(() => getWorker().request({ type: 'inspect', side, ...source })).then((inspection) => {
      if (current) setChecked({ source, inspection });
    }, (error: unknown) => {
      if (current) setChecked({ source, error: errorMessage(error, 'This supplier file could not be read.') });
    });
    return () => { current = false; };
  }, [getWorker, side, source]);

  function replace(next?: { file: File; sheetName?: string; synthetic?: boolean }, error = '') {
    onChange();
    const id = ++version.current;
    setSource(next ? { ...next, fileId: id, sourceId: id } : undefined);
    setChecked(undefined);
    setOverride(undefined);
    setFileError(error);
    if (!next) clearWorkerSource(side);
  }

  function load(files: FileList) {
    if (!files.length) return;
    if (files.length === 1 && /\.(csv|xlsx)$/i.test(files[0].name)) replace({ file: files[0] });
    else replace(undefined, 'Choose one supplier file with a .csv or .xlsx extension.');
  }

  function selectWorksheet(sheetName: string) {
    if (!source) return;
    onChange();
    setSource({ ...source, sheetName, sourceId: ++version.current });
    setOverride(undefined);
  }

  function selectColumn(role: keyof DeltaMapping, column: number | null) {
    onChange();
    setOverride({ ...mapping, [role]: column });
  }

  return { source, inspection, sheetNames, mapping, comparisonSource, replace, load, selectWorksheet, selectColumn,
    reading: Boolean(source && !current), error: fileError || current?.error };
}

function DeltaSourcePicker({ side, selection }: { side: DeltaSide; selection: ReturnType<typeof useDeltaSource> }) {
  const { source, inspection, sheetNames, mapping, reading, error } = selection;
  const { label, title, formats, choose } = FIELDS[side];
  const worksheet = sheetNames && sheetNames.length > 1 ? (
    <label className="price-sheet">{label} worksheet
      <select aria-label={`${label} worksheet`} value={source?.sheetName ?? inspection?.selectedSheet ?? ''}
        onChange={(event) => selection.selectWorksheet(event.currentTarget.value)}>
        {sheetNames.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    </label>
  ) : undefined;

  return (
    <PriceFileInput side={`delta-${side}`} field={{ title, formats, label: choose, accept: '.csv,.xlsx' }} file={source}
      message={{ reading, error }} onLoad={selection.load} onClear={() => selection.replace()} clearLabel={`Clear ${label.toLowerCase()} supplier sheet`}
      worksheet={worksheet}>
      {inspection?.headers.length ? (
        <>
          <p className="price-source-count field-help">
            {inspection.rowCount.toLocaleString('en-US')} {inspection.rowCount === 1 ? 'row' : 'rows'}{inspection.selectedSheet ? ` in ${inspection.selectedSheet}` : ''}
          </p>
          <fieldset className="price-fields delta-mapping" aria-label={`${label} column mapping`}>
            {ROLES.map(({ key, label: role, optional }) => (
              <label key={key}>{role}{optional ? ' (optional)' : ''}
                <select aria-label={`${label} ${role}`} value={mapping[key] ?? ''} onChange={(event) => {
                  const value = event.currentTarget.value;
                  selection.selectColumn(key, value === '' ? null : Number(value));
                }}>
                  <option value="" disabled={!optional}>{optional ? 'Ignore inventory' : 'Choose a column'}</option>
                  {inspection.headers.map((header, index) => (
                    <option key={index} value={index}>{header || 'Unnamed column'} · column {index + 1}</option>
                  ))}
                </select>
              </label>
            ))}
          </fieldset>
        </>
      ) : inspection?.firstIssue ? <p className="file-message file-error" role="alert">{inspection.firstIssue}</p> : null}
    </PriceFileInput>
  );
}

export default function SupplierDeltaPanel({ active }: { active: boolean }) {
  const heading = useId();
  const { branding } = useSignoffBranding();
  const workerRef = useRef<DeltaWorker | null>(null);
  const change = useRef(0);
  const comparisonId = useRef(0);
  const getWorker = useCallback(() => workerRef.current ??= new DeltaWorker(), []);
  const [demoPending, setDemoPending] = useState(false);
  const [demoError, setDemoError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  function invalidate() {
    change.current += 1;
    setDemoPending(false);
    setDemoError('');
    setDownloading(false);
    setDownloadError('');
  }

  function clearWorkerSource(side: DeltaSide) {
    void workerRef.current?.request({ type: 'clear', side }).catch(() => undefined);
  }

  const previous = useDeltaSource('previous', getWorker, clearWorkerSource, invalidate);
  const next = useDeltaSource('next', getWorker, clearWorkerSource, invalidate);
  const inputs = useMemo(() => previous.comparisonSource && next.comparisonSource
    ? { previous: previous.comparisonSource, next: next.comparisonSource } : null, [previous.comparisonSource, next.comparisonSource]);
  const [checked, setChecked] = useState<{ inputs: NonNullable<typeof inputs>; report?: { summary: DeltaSummary; id: number; worker: DeltaWorker }; error?: string }>();
  const current = checked?.inputs === inputs ? checked : undefined;
  const report = current?.report;
  const ready = report?.summary.status === 'ready';
  const readFingerprint = useMemo(() => active && ready && report && branding
    ? () => report.worker.request({ type: 'signoffFingerprint', comparisonId: report.id, branding }) : null,
  [active, ready, report, branding]);
  const brandedFingerprint = useSignoffFingerprint(readFingerprint);
  const signoffFingerprint = branding ? brandedFingerprint : report?.summary.custody.signOffHtmlSha256;

  useEffect(() => () => {
    change.current += 1;
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  useEffect(() => {
    if (!inputs) return;
    let current = true;
    const revision = change.current;
    const id = ++comparisonId.current;
    void Promise.resolve().then(async () => {
      const worker = getWorker();
      const summary = await worker.request({ type: 'build', comparisonId: id, sources: inputs });
      if (current && change.current === revision) setChecked({ inputs, report: { summary, id, worker } });
    }).catch((error: unknown) => {
      if (current && change.current === revision) setChecked({ inputs, error: errorMessage(error, 'The supplier delta could not finish.') });
    });
    return () => { current = false; };
  }, [getWorker, inputs]);

  async function loadDemo() {
    previous.replace();
    next.replace();
    setDemoPending(true);
    const revision = change.current;
    try {
      const { supplierDeltaDemo } = await import('./demo');
      if (change.current !== revision) return;
      const demo = supplierDeltaDemo();
      previous.replace({ ...demo.previous, synthetic: true });
      next.replace({ ...demo.next, synthetic: true });
    } catch (error) {
      if (change.current === revision) setDemoError(errorMessage(error, 'The synthetic supplier demo could not open.'));
    } finally {
      if (change.current === revision) setDemoPending(false);
    }
  }

  async function download(artifact: DeltaArtifact) {
    if (!report || downloading || (artifact !== 'audit' && report.summary.status !== 'ready')) return;
    const revision = change.current;
    setDownloading(true);
    setDownloadError('');
    try {
      const { filename, bytes, mime } = await report.worker.request({
        type: 'download', comparisonId: report.id, artifact, ...(artifact !== 'csv' && branding ? { branding } : {}),
      });
      if (change.current === revision) downloadFile(filename, bytes, mime);
    } catch (error) {
      if (change.current === revision) setDownloadError(errorMessage(error, 'This supplier delta report could not be saved.'));
    } finally {
      if (change.current === revision) setDownloading(false);
    }
  }

  const status = current?.error ? 'Comparison stopped' : ready ? 'Ready to download' : report ? 'Review required' :
    inputs ? 'Comparing supplier costs…' : previous.reading || next.reading ? 'Reading supplier files…' : 'Choose two supplier files';

  return (
    <div className="price-section supplier-delta">
      <div className="price-heading">
        <div>
          <h2 id={heading}>Compare supplier price sheets</h2>
          <p className="field-help">Spot changes to unit costs, SKUs and inventory. Files stay in this browser.</p>
        </div>
        <button type="button" className="button button-secondary" onClick={() => void loadDemo()} disabled={demoPending}>
          Load Synthetic Supplier Delta Demo
        </button>
      </div>
      {demoPending ? <p className="field-help" role="status">Opening the synthetic demo…</p> : null}
      {demoError ? <p className="file-message file-error" role="alert">{demoError}</p> : null}
      <div className="price-files" role="group" aria-label="Supplier Delta files">
        <DeltaSourcePicker side="previous" selection={previous} />
        <DeltaSourcePicker side="next" selection={next} />
      </div>
      {previous.source?.synthetic && next.source?.synthetic ? (
        <p className="field-help delta-demo-note">Both demo sources use the same synthetic workbook. Their file fingerprints match.</p>
      ) : null}
      <section className="delta-review" aria-label="Supplier delta review">
        <p className="delta-state" data-testid="supplier-delta-status" data-ready={ready} data-held={report?.summary.status === 'blocked'}
          role="status" aria-live="polite">{status}</p>
        {current?.error ? <p className="file-message file-error" role="alert">{current.error}</p> : null}
        {report && previous.source && next.source ? (
          <DeltaResults key={report.id} report={report} signoffFingerprint={signoffFingerprint}
            previous={{ file: previous.source.file, sheetName: previous.inspection?.selectedSheet }}
            next={{ file: next.source.file, sheetName: next.inspection?.selectedSheet }} />
        ) : null}
        <div className="delta-downloads export-buttons" role="group" aria-label="Supplier delta reports">
          <button type="button" className="button button-primary" disabled={!ready || downloading} onClick={() => void download('csv')}>Supplier Delta CSV</button>
          <button type="button" className="button button-secondary" disabled={!report || downloading} onClick={() => void download('audit')}>JSON Audit</button>
          <button type="button" className="button button-secondary" disabled={!ready || downloading} onClick={() => void download('signoff')}>Delta Sign-Off (.html)</button>
        </div>
        {report?.summary.status === 'blocked' ? <p className="field-help">Resolve the blocking issues or download the JSON audit for details.</p> : null}
        {downloadError ? <p className="file-message file-error" role="alert">{downloadError}</p> : null}
      </section>
    </div>
  );
}
