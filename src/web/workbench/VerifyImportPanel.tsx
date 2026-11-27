import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import type { StorePlatform } from '../../core/shopify-price-diff/workspace-profile';
import type { WorkbenchWorker } from '../../core/worker/client';
import type { InspectionSummary } from '../../core/worker/protocol';
import { BIGCOMMERCE_DEMO } from './bigCommerceDemo';
import { CustodyFingerprints } from './CustodyFingerprints';
import { PAGE_SIZE, Pagination, usePagination } from './Pagination';
import type { GeneratedPairSource } from './PriceDiffWorkbench';
import { PriceFileInput } from './PriceFileInput';
import { useWorkerPage } from './useWorkerPage';
import { useWorkerSession, WorkerStatus } from './workerSession';
import { STORE_PLATFORMS } from './WorkspaceProfile';

type FileRole = 'baseline' | 'candidate' | 'pairedUpdate';
type CandidateKind = 'update' | 'rollback';
type LocalInput = { file?: File; error?: string; synthetic?: boolean };
type VerifyFiles = { platform: StorePlatform; baseline: File; candidate: File; pairedUpdate?: File };
type Report = { summary: InspectionSummary; worker: WorkbenchWorker; files: VerifyFiles };
type GeneratedFiles = Awaited<ReturnType<GeneratedPairSource['load']>>;

const FILE_FIELDS = {
  baseline: { title: 'Baseline CSV', formats: 'Drop the original catalog export', label: 'Choose baseline CSV', accept: '.csv' },
  candidate: { title: 'Update or rollback CSV', formats: 'Drop the CSV you plan to import', label: 'Choose update or rollback CSV', accept: '.csv' },
  pairedUpdate: { title: 'Matching update CSV', formats: 'Drop the update that the rollback should reverse', label: 'Choose matching update CSV', accept: '.csv' },
};

const ISSUE_SOURCES = { baseline: 'Baseline', candidate: 'Candidate', update: 'Paired update' } as const;

export default function VerifyImportPanel({ pairSource, buildPlatform }: { pairSource: GeneratedPairSource | null; buildPlatform: StorePlatform }) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [localPlatform, setLocalPlatform] = useState<StorePlatform>();
  const [local, setLocal] = useState<Partial<Record<FileRole, LocalInput>>>({});
  const [selectedPair, setSelectedPair] = useState<GeneratedPairSource | null>(null);
  const [generated, setGenerated] = useState<GeneratedFiles | null>(null);
  const [kind, setKind] = useState<CandidateKind>('update');
  const [report, setReport] = useState<Report | null>(null);
  const { run, reset, resume, cancel, progress, paused, finished, error } = useWorkerSession();
  const usingPair = selectedPair !== null && selectedPair === pairSource;
  const visibleReport = selectedPair === null || usingPair ? report : null;
  const platform = localPlatform ?? buildPlatform;
  const baseline = local.baseline?.file;
  const candidate = local.candidate?.file;

  useLayoutEffect(() => {
    if (!selectedPair || selectedPair === pairSource) return;
    // A replacement Build run invalidates these files even if its outputs have the same names.
    reset();
    setReport(null);
    setSelectedPair(null);
    setGenerated(null);
  }, [selectedPair, pairSource, reset]);

  function selectFile(role: FileRole, choices: FileList | null) {
    if (choices && !choices.length) return;
    reset();
    setReport(null);
    const input = choices
      ? choices.length === 1 && /\.csv$/i.test(choices[0].name)
        ? { file: choices[0] }
        : { error: 'Choose one file with a .csv extension.' }
      : undefined;
    if (input?.file) setLocalPlatform(platform);
    setLocal((previous) => ({ ...previous, [role]: input }));
  }

  function complete(value: { summary: InspectionSummary; files: VerifyFiles }, worker: WorkbenchWorker) {
    setReport({ ...value, worker });
  }

  function inspect(files: VerifyFiles) {
    setReport(null);
    resume();
    void run(async ({ worker, progress: update }) => ({
      summary: await worker.request({ type: 'inspectImport', ...files }, update),
      files,
    }), complete, 'parsing');
  }

  function fromGenerated(source: GeneratedPairSource, files: GeneratedFiles, candidateKind: CandidateKind): VerifyFiles {
    return {
      platform: source.platform,
      baseline: source.baseline,
      candidate: files[candidateKind],
      ...(candidateKind === 'rollback' ? { pairedUpdate: files.update } : {}),
    };
  }

  function loadGeneratedPair() {
    if (!pairSource) return;
    const source = pairSource;
    reset();
    setReport(null);
    setSelectedPair(source);
    setGenerated(null);
    setKind('update');
    void run(async ({ worker, progress: update, isCurrent }) => {
      const pair = await source.load();
      if (!isCurrent()) throw new Error('The generated pair changed.');
      setGenerated(pair);
      const files = fromGenerated(source, pair, 'update');
      return { summary: await worker.request({ type: 'inspectImport', ...files }, update), files };
    }, complete, 'reading');
  }

  function verifyLocal() {
    if (!baseline || !candidate || local.pairedUpdate?.error) return;
    const pairedUpdate = local.pairedUpdate?.file;
    inspect({ platform, baseline, candidate, ...(pairedUpdate ? { pairedUpdate } : {}) });
  }

  function loadBigCommerceDemo() {
    const { baseline, baselineName, candidate, candidateName } = BIGCOMMERCE_DEMO;
    const baselineFile = new File([baseline], baselineName, { type: 'text/csv' });
    const candidateFile = new File([candidate], candidateName, { type: 'text/csv' });
    setLocalPlatform('bigcommerce');
    setLocal({ baseline: { file: baselineFile, synthetic: true }, candidate: { file: candidateFile, synthetic: true } });
    inspect({ platform: 'bigcommerce', baseline: baselineFile, candidate: candidateFile });
  }

  function chooseCandidate(next: CandidateKind) {
    if (!usingPair || !generated || (kind === next && report)) return;
    setKind(next);
    inspect(fromGenerated(selectedPair, generated, next));
  }

  function useLocalFiles() {
    reset();
    setReport(null);
    setSelectedPair(null);
    setGenerated(null);
    heading.current?.focus({ preventScroll: true });
  }

  function filePicker(role: FileRole, clearLabel: string) {
    const choice = local[role];
    return <PriceFileInput side={`verify-${role}`} field={FILE_FIELDS[role]} file={choice?.file ? { file: choice.file, synthetic: choice.synthetic } : undefined}
      message={{ error: choice?.error }} onLoad={(files) => selectFile(role, files)} onClear={() => selectFile(role, null)} clearLabel={clearLabel} />;
  }

  function restart() {
    if (!usingPair) verifyLocal();
    else if (generated) chooseCandidate(kind);
    else loadGeneratedPair();
  }

  return (
    <section className="price-section verify-panel" aria-labelledby={id}>
      <div className="price-heading">
        <div>
          <h2 id={id} ref={heading} tabIndex={-1}>Verify before import</h2>
          <p className="field-help">Check product groups and exact price or stock changes against the original catalog export. Files stay in this browser.</p>
        </div>
        <button className="button button-secondary" type="button" data-testid="verify-load-pair"
          disabled={!pairSource || Boolean(progress)} onClick={loadGeneratedPair}>Load last generated pair</button>
      </div>
      {usingPair ? (
        <div className="verify-generated">
          <div className="verify-actions">
            <div className="price-platform-toggle" role="group" aria-label="Generated candidate CSV">
              <button type="button" aria-pressed={kind === 'update'} data-testid="verify-update" disabled={!generated || Boolean(progress)}
                onClick={() => chooseCandidate('update')}>Update CSV</button>
              <button type="button" aria-pressed={kind === 'rollback'} data-testid="verify-rollback" disabled={!generated || Boolean(progress)}
                onClick={() => chooseCandidate('rollback')}>Rollback CSV</button>
            </div>
            <button type="button" className="text-button" onClick={useLocalFiles}>Use local CSV files</button>
          </div>
          <p className="field-help">{STORE_PLATFORMS[selectedPair.platform]} baseline <strong>{selectedPair.baseline.name}</strong>
            {selectedPair.market ? <> · Target <code>{selectedPair.market.priceHeader}</code></> : null}
            {generated ? <> · {kind === 'update' ? 'Update' : 'Rollback'} <strong>{generated[kind].name}</strong></> : null}</p>
        </div>
      ) : (
        <>
          <div className="price-sheet">
            <label htmlFor={`${id}-platform`}>Store platform</label>
            <select id={`${id}-platform`} value={platform} onChange={(event) => {
              reset();
              setReport(null);
              setLocalPlatform(event.currentTarget.value as StorePlatform);
            }}>
              {Object.entries(STORE_PLATFORMS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          {platform === 'bigcommerce' ? (
            <div className="verify-actions">
              <button className="button button-secondary" type="button" disabled={Boolean(progress)} onClick={loadBigCommerceDemo}>Load Synthetic BigCommerce Demo</button>
            </div>
          ) : null}
          <div className="price-files">
            {filePicker('baseline', 'Clear baseline CSV')}
            {filePicker('candidate', 'Clear update or rollback CSV')}
          </div>
          <details className="verify-paired-input">
            <summary>Check a rollback with its matching update{local.pairedUpdate?.file ? ' · Update selected'
              : local.pairedUpdate?.error ? ' · Check the selected file' : ''}</summary>
            <p className="field-help">Add the update the rollback must reverse. The candidate file above becomes the rollback for a local replay.</p>
            {filePicker('pairedUpdate', 'Clear matching update CSV')}
          </details>
          <div className="verify-actions">
            <button className="button button-primary" type="button" data-testid="verify-submit"
              disabled={!baseline || !candidate || Boolean(local.pairedUpdate?.error) || Boolean(progress) || paused}
              onClick={verifyLocal}>Verify CSV</button>
          </div>
        </>
      )}
      {(usingPair ? selectedPair.platform : platform) === 'bigcommerce' ? <p className="field-help catalog-import-note">
        Use the original legacy Bulk Edit export. Enable <strong>Ignore blank values</strong> when importing a verified file.
      </p> : null}
      <WorkerStatus progress={progress} paused={paused} finished={finished} error={error} focusHeading={id} onCancel={() => {
        cancel();
        setReport(null);
      }} onResume={restart} />
      <p className="sr-only" role="status">{visibleReport ? `Verification result: ${visibleReport.summary.verdict}` : ''}</p>
      {visibleReport ? <InspectionReport {...visibleReport} /> : null}
    </section>
  );
}

function InspectionReport({ summary, worker, files }: Report) {
  const { rollback } = summary;
  const paired = rollback.scope === 'paired-update';
  const pass = summary.verdict === 'PASS';
  const metrics = [
    ['matched-rows', 'Matched rows', summary.matchedRows],
    ['changed-rows', 'Changed rows', summary.changedRows],
    ['changed-skus', 'Changed SKUs', summary.changedSkus],
    ['unchanged-siblings', 'Unchanged sibling SKUs', summary.unchangedSiblingSkus],
    ['non-target-mutations', 'Non-target mutations', summary.nonTargetMutations],
    ['broken-groups', 'Broken product groups', summary.brokenGroups],
  ] as const;
  const id = useId();

  return (
    <section className="verify-report" aria-labelledby={id}>
      <div className="price-heading">
        <h3 id={id}>Verification result</h3>
        <strong className={`issue-badge ${pass ? 'badge-fixed' : 'badge-review'}`} data-testid="verify-verdict">{summary.verdict}</strong>
      </div>
      <p className="field-help">{pass ? 'The candidate passed the local CSV safety checks.' : 'The candidate failed a safety check. Fix the issues before importing.'}</p>
      <dl className="verify-metrics">
        {metrics.map(([field, label, value]) => (
          <div key={field}>
            <dt>{label}</dt>
            <dd data-testid={`verify-metric-${field}`}>{value.toLocaleString('en-US')}</dd>
          </div>
        ))}
      </dl>
      <div className="verify-rollback">
        <h3>{paired ? 'Paired rollback replay' : 'Baseline cell comparison'}</h3>
        {rollback.residualDiffs === null ? <p className="field-help">The file checks blocked an exact comparison of the target cells.</p> : (
          <>
            <p className="verify-residual" data-testid="verify-residual-diffs">
              {rollback.residualDiffs.toLocaleString('en-US')} {paired ? 'residual differences' : 'target cell differences'}
            </p>
            <p className="field-help">{paired
              ? rollback.restored
                ? 'Applying the matching update and then this rollback locally restores the original target cell values exactly.'
                : 'The local replay of the update and rollback did not restore the original target cell values.'
              : rollback.restored
                ? 'All included target cells match the supplied baseline exactly. Add the matching update for a local rollback replay.'
                : 'These differences compare the candidate directly with the supplied baseline.'}</p>
          </>
        )}
      </div>
      <CustodyFingerprints key={`${summary.baselineSha256}:${summary.candidateSha256}:${rollback.pairedUpdateSha256 ?? ''}`} open entries={[
        { field: 'baseline', label: 'Baseline CSV', sha256: summary.baselineSha256, detail: files.baseline.name },
        { field: 'candidate', label: 'Candidate CSV', sha256: summary.candidateSha256, detail: files.candidate.name },
        { field: 'paired-update', label: 'Paired update CSV', sha256: rollback.pairedUpdateSha256, detail: files.pairedUpdate?.name },
      ]} />
      <InspectionIssues worker={worker} total={summary.issueCount} />
      <InspectionRows worker={worker} total={summary.rowCount} />
    </section>
  );
}

function InspectionIssues({ worker, total }: { worker: WorkbenchWorker; total: number }) {
  const id = useId();
  const page = usePagination(total);
  const read = useCallback(() => worker.request({ type: 'inspectionIssues', page: page.page, pageSize: PAGE_SIZE }), [worker, page.page]);
  const data = useWorkerPage(total ? read : null);
  if (!total) return null;

  return (
    <section className="verify-result-detail" aria-labelledby={id} data-testid="verify-issues">
      <h3 id={id}>Safety issues ({total.toLocaleString('en-US')})</h3>
      {data?.error ? <p className="file-error" role="alert">{data.error}</p> : data?.page ? (
        <ul className="verify-issues">
          {data.page.rows.map(({ source, code, message, line, column }, index) => (
            <li key={page.start + index} data-issue-code={code}>
              <p><strong>{ISSUE_SOURCES[source]}{line === undefined ? '' : ` line ${line}`}</strong>{column ? <> · <code>{column}</code></> : null}</p>
              <p>{message}</p>
              <code className="field-help">{code}</code>
            </li>
          ))}
        </ul>
      ) : <p className="empty-panel" role="status">Loading safety issues…</p>}
      <Pagination state={page} total={total} label="Safety issue pages" />
    </section>
  );
}

function InspectionRows({ worker, total }: { worker: WorkbenchWorker; total: number }) {
  const id = useId();
  const page = usePagination(total);
  const read = useCallback(() => worker.request({ type: 'inspectionRows', page: page.page, pageSize: PAGE_SIZE }), [worker, page.page]);
  const data = useWorkerPage(total ? read : null);

  return (
    <section className="verify-result-detail" aria-labelledby={id} data-testid="verify-rows">
      <h3 id={id}>Exact diff rows ({total.toLocaleString('en-US')})</h3>
      {data?.error ? <p className="file-error" role="alert">{data.error}</p> : data?.page ? (
        <div className="preview-card">
          <div className="table-scroll" role="region" aria-labelledby={id} tabIndex={0}>
            <table className="verify-table" aria-labelledby={id}>
              <thead>
                <tr><th scope="col">SKU / Product</th><th scope="col">Baseline line</th><th scope="col">Candidate line</th><th scope="col">Changed cells</th></tr>
              </thead>
              <tbody>
                {data.page.rows.map(({ sku, product, baselineLine, candidateLine, changes }) => (
                  <tr key={candidateLine}>
                    <th scope="row"><code>{sku || 'No SKU'}</code><span className="price-row-detail">{product}</span></th>
                    <td>{baselineLine}</td>
                    <td>{candidateLine}</td>
                    <td>
                      <ul className="verify-changes">
                        {changes.map(({ column, before, after, delta }) => (
                          <li key={column}>
                            <strong>{column}</strong>
                            <dl>
                              <div><dt>Before</dt><dd><CsvCell value={before} /></dd></div>
                              <div><dt>After</dt><dd><CsvCell value={after} /></dd></div>
                              <div><dt>Delta</dt><dd><CsvCell value={delta} missing="Unavailable" /></dd></div>
                            </dl>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : <p className="empty-panel" role="status">{total ? 'Loading diff rows…' : 'No changed rows to display.'}</p>}
      <Pagination state={page} total={total} label="Exact diff row pages" />
    </section>
  );
}

function CsvCell({ value, missing = 'Column absent' }: { value: string | null; missing?: string }) {
  if (value === null || value === '') return <span className="blank-cell">{value === null ? missing : 'Empty'}</span>;
  return <code>{value}</code>;
}
