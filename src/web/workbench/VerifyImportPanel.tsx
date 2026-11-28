import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ImportPlatform } from '../../core/verify-import/inspector';
import type { WorkbenchWorker } from '../../core/worker/client';
import type { InspectionSummary } from '../../core/worker/protocol';
import { AMAZON_FILE_ERROR, AMAZON_FILE_EXTENSION, AMAZON_VERIFY_FIELDS } from './amazon/flatFileFields';
import { BIGCOMMERCE_DEMO } from './bigCommerceDemo';
import { CustodyFingerprints } from './CustodyFingerprints';
import { InspectionIssues, InspectionRows } from './InspectionDetails';
import { LocalCliCommand } from './LocalCliCommand';
import type { GeneratedPairSource } from './PriceDiffWorkbench';
import { PriceFileInput } from './PriceFileInput';
import { useWorkerSession, WorkerStatus } from './workerSession';
import { PRICE_UPDATE_PLATFORMS } from './WorkspaceProfile';

type FileRole = 'baseline' | 'candidate' | 'pairedUpdate';
type CandidateKind = 'update' | 'rollback';
type LocalInput = { file?: File; error?: string; synthetic?: boolean };
type VerifyFiles = { platform: ImportPlatform; baseline: File; candidate: File; pairedUpdate?: File };
type Report = { summary: InspectionSummary; worker: WorkbenchWorker; files: VerifyFiles };
type GeneratedFiles = Awaited<ReturnType<GeneratedPairSource['load']>>;

const FILE_FIELDS = {
  baseline: { title: 'Baseline CSV', formats: 'Drop the original catalog export', label: 'Choose baseline CSV', accept: '.csv' },
  candidate: { title: 'Update or rollback CSV', formats: 'Drop the CSV you plan to import', label: 'Choose update or rollback CSV', accept: '.csv' },
  pairedUpdate: { title: 'Matching update CSV', formats: 'Drop the update that the rollback should reverse', label: 'Choose matching update CSV', accept: '.csv' },
};

export default function VerifyImportPanel({ pairSource, buildPlatform }: { pairSource: GeneratedPairSource | null; buildPlatform: ImportPlatform }) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [localPlatform, setLocalPlatform] = useState<ImportPlatform>();
  const [local, setLocal] = useState<Partial<Record<FileRole, LocalInput>>>({});
  const [selectedPair, setSelectedPair] = useState<GeneratedPairSource | null>(null);
  const [generated, setGenerated] = useState<GeneratedFiles | null>(null);
  const [kind, setKind] = useState<CandidateKind>('update');
  const [report, setReport] = useState<Report | null>(null);
  const { run, reset, resume, cancel, progress, paused, finished, error } = useWorkerSession();
  const usingPair = selectedPair !== null && selectedPair === pairSource;
  const visibleReport = selectedPair === null || usingPair ? report : null;
  const platform = localPlatform ?? buildPlatform;
  const amazon = platform === 'amazon';
  const reportPlatform = usingPair ? selectedPair.platform : platform;
  const amazonReport = reportPlatform === 'amazon';
  const baseline = local.baseline?.file;
  const candidate = local.candidate?.file;
  const matched = usingPair ? kind === 'rollback' : Boolean(local.pairedUpdate?.file);

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
    const extension = amazon ? AMAZON_FILE_EXTENSION : /\.csv$/i;
    const input = choices
      ? choices.length === 1 && extension.test(choices[0].name)
        ? { file: choices[0] }
        : { error: amazon ? AMAZON_FILE_ERROR : 'Choose one file with a .csv extension.' }
      : undefined;
    if (input) setLocalPlatform(platform);
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
    const field = amazon ? AMAZON_VERIFY_FIELDS[role] : FILE_FIELDS[role];
    return <PriceFileInput side={`verify-${role}`} field={field} file={choice?.file ? { file: choice.file, synthetic: choice.synthetic } : undefined}
      message={{ error: choice?.error }} onLoad={(files) => selectFile(role, files)} onClear={() => selectFile(role, null)} clearLabel={clearLabel} />;
  }

  function restart() {
    if (!usingPair) verifyLocal();
    else if (generated) chooseCandidate(kind);
    else loadGeneratedPair();
  }

  function commandPath(stem: string, file?: File) {
    const extension = amazonReport ? file?.name.match(AMAZON_FILE_EXTENSION)?.[1].toLowerCase() ?? 'txt' : 'csv';
    return `${stem}.${extension}`;
  }

  return (
    <section className="price-section verify-panel" aria-labelledby={id} data-amazon={amazonReport}>
      <div className="price-heading">
        <div>
          <h2 id={id} ref={heading} tabIndex={-1}>Verify before import</h2>
          <p className="field-help">{amazonReport
            ? 'Check exact price and quantity changes and the price corridor against the original Amazon Price & Quantity export. Files stay in this browser.'
            : 'Check product groups and exact price or stock changes against the original catalog export. Files stay in this browser.'}</p>
        </div>
        <button className="button button-secondary" type="button" data-testid="verify-load-pair"
          disabled={!pairSource || Boolean(progress)} onClick={loadGeneratedPair}>Load last generated pair</button>
      </div>
      {usingPair ? (
        <div className="verify-generated">
          <div className="verify-actions">
            <div className="price-platform-toggle" role="group" aria-label={amazonReport ? 'Generated Amazon candidate file' : 'Generated candidate CSV'}>
              <button type="button" aria-pressed={kind === 'update'} data-testid="verify-update" disabled={!generated || Boolean(progress)}
                onClick={() => chooseCandidate('update')}>{amazonReport ? 'Amazon Update File' : 'Update CSV'}</button>
              <button type="button" aria-pressed={kind === 'rollback'} data-testid="verify-rollback" disabled={!generated || Boolean(progress)}
                onClick={() => chooseCandidate('rollback')}>{amazonReport ? 'Amazon Rollback File' : 'Rollback CSV'}</button>
            </div>
            <button type="button" className="text-button" onClick={useLocalFiles}>{amazonReport ? 'Use local files' : 'Use local CSV files'}</button>
          </div>
          <p className="field-help">{PRICE_UPDATE_PLATFORMS[selectedPair.platform]} baseline <strong>{selectedPair.baseline.name}</strong>
            {selectedPair.market ? <> · Target <code>{selectedPair.market.priceHeader}</code></> : null}
            {generated ? <> · {kind === 'update' ? 'Update' : 'Rollback'} <strong>{generated[kind].name}</strong></> : null}</p>
        </div>
      ) : (
        <>
          <div className="price-sheet">
            <label htmlFor={`${id}-platform`}>Store platform</label>
            <select id={`${id}-platform`} value={platform} onChange={(event) => {
              const next = event.currentTarget.value as ImportPlatform;
              reset();
              setReport(null);
              if (amazon || next === 'amazon') setLocal({});
              setLocalPlatform(next);
            }}>
              {Object.entries(PRICE_UPDATE_PLATFORMS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          {platform === 'bigcommerce' ? (
            <div className="verify-actions">
              <button className="button button-secondary" type="button" disabled={Boolean(progress)} onClick={loadBigCommerceDemo}>Load Synthetic BigCommerce Demo</button>
            </div>
          ) : null}
          <div className="price-files">
            {filePicker('baseline', amazon ? 'Clear Amazon baseline file' : 'Clear baseline CSV')}
            {filePicker('candidate', amazon ? 'Clear Amazon update or rollback file' : 'Clear update or rollback CSV')}
          </div>
          <details className="verify-paired-input">
            <summary>Check a rollback with its matching update{local.pairedUpdate?.file ? ' · Update selected'
              : local.pairedUpdate?.error ? ' · Check the selected file' : ''}</summary>
            <p className="field-help">Add the update the rollback must reverse. The candidate file above becomes the rollback for a local replay.</p>
            {filePicker('pairedUpdate', amazon ? 'Clear matching Amazon update file' : 'Clear matching update CSV')}
          </details>
          <div className="verify-actions">
            <button className="button button-primary" type="button" data-testid="verify-submit"
              disabled={!baseline || !candidate || Boolean(local.pairedUpdate?.error) || Boolean(progress) || paused}
              onClick={verifyLocal}>{amazon ? 'Verify Amazon File' : 'Verify CSV'}</button>
          </div>
        </>
      )}
      {reportPlatform === 'bigcommerce' ? <p className="field-help catalog-import-note">
        Use the original legacy Bulk Edit export. Enable <strong>Ignore blank values</strong> when importing a verified file.
      </p> : null}
      <WorkerStatus progress={progress} paused={paused} finished={finished} error={error} focusHeading={id} onCancel={() => {
        cancel();
        setReport(null);
      }} onResume={restart} />
      <p className="sr-only" role="status">{visibleReport ? `Verification result: ${visibleReport.summary.verdict}` : ''}</p>
      {visibleReport ? <InspectionReport {...visibleReport} /> : null}
      <LocalCliCommand mode="verify" unavailable="Fix the selected file error to prepare the command."
        getArguments={() => !usingPair && Object.values(local).some(({ error }) => error) ? null : [
          '--platform', reportPlatform,
          '--baseline', commandPath('baseline', usingPair ? selectedPair.baseline : baseline),
          '--candidate', commandPath(matched ? 'rollback' : 'candidate', usingPair ? generated?.[kind] : candidate),
          ...(matched ? ['--matched-update', commandPath('matching-update', usingPair ? generated?.update : local.pairedUpdate?.file)] : []),
        ]}>
        {usingPair ? <p className="field-help">Save the generated candidate locally before running. For a rollback, also save the matching update.</p> : null}
      </LocalCliCommand>
    </section>
  );
}

function InspectionReport({ summary, worker, files }: Report) {
  const { rollback } = summary;
  const paired = rollback.scope === 'paired-update';
  const pass = summary.verdict === 'PASS';
  const amazon = files.platform === 'amazon';
  const format = amazon ? 'file' : 'CSV';
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
      <p className="field-help">{pass
        ? amazon ? 'The candidate passed the local Amazon file safety checks.' : 'The candidate passed the local CSV safety checks.'
        : 'The candidate failed a safety check. Fix the issues before importing.'}</p>
      <dl className="verify-metrics">
        {metrics.filter(([field]) => !amazon || (field !== 'unchanged-siblings' && field !== 'broken-groups')).map(([field, label, value]) => (
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
        { field: 'baseline', label: `Baseline ${format}`, sha256: summary.baselineSha256, detail: files.baseline.name },
        { field: 'candidate', label: `Candidate ${format}`, sha256: summary.candidateSha256, detail: files.candidate.name },
        { field: 'paired-update', label: `Paired update ${format}`, sha256: rollback.pairedUpdateSha256, detail: files.pairedUpdate?.name },
      ]} />
      <InspectionIssues worker={worker} total={summary.issueCount} />
      <InspectionRows worker={worker} total={summary.rowCount} amazon={amazon} />
    </section>
  );
}
