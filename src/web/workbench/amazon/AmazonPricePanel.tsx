import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { WorkbenchWorker } from '../../../core/worker/client';
import type { AmazonPriceSummary, WorkerDownload } from '../../../core/worker/protocol';
import { downloadFile } from '../downloads';
import { InspectionIssues, InspectionRows } from '../InspectionDetails';
import type { GeneratedPairSource } from '../PriceDiffWorkbench';
import { PriceFileInput } from '../PriceFileInput';
import { useWorkerSession, WorkerStatus } from '../workerSession';
import { AMAZON_BASELINE_FIELD, AMAZON_FILE_ERROR, AMAZON_FILE_EXTENSION, AMAZON_PROPOSAL_FIELD } from './flatFileFields';

type FileRole = 'baseline' | 'proposal';
type LocalInput = { file?: File; synthetic?: boolean; error?: string };
type Selection = Partial<Record<FileRole, LocalInput>>;

const FIELDS = { baseline: AMAZON_BASELINE_FIELD, proposal: AMAZON_PROPOSAL_FIELD };
const DOWNLOADS = [
  { format: 'amazon-update', testId: 'amazon-download-update', label: 'Download Amazon Update File' },
  { format: 'amazon-rollback', testId: 'amazon-download-rollback', label: 'Download Amazon Rollback File' },
  { format: 'amazon-audit-json', testId: 'amazon-download-audit', label: 'Download Amazon Audit JSON' },
] as const;
type Format = typeof DOWNLOADS[number]['format'];

export default function AmazonPricePanel({ onBatchStarted, onPairAvailable }: {
  onBatchStarted: (started: boolean) => void;
  onPairAvailable: (source: GeneratedPairSource | null) => void;
}) {
  const id = useId();
  const [files, setFiles] = useState<Selection>({});
  const [report, setReport] = useState<{ summary: AmazonPriceSummary; worker: WorkbenchWorker }>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const revision = useRef(0);
  const { run, reset, resume, cancel, progress, paused, finished, error } = useWorkerSession();
  const baseline = files.baseline?.file;
  const proposal = files.proposal?.file;
  const summary = report?.summary;
  const ready = Boolean(summary?.canDownload);
  const held = summary?.status === 'blocked' || Boolean(files.baseline?.error || files.proposal?.error || error);

  useLayoutEffect(() => () => { revision.current += 1; }, []);

  useEffect(() => {
    if (!baseline || !proposal || paused) return;
    const batch = revision.current;
    void run(({ worker, progress: update }) => worker.request({ type: 'buildAmazonPriceDiff', baseline, proposal }, update),
      (summary, worker) => {
        setReport({ summary, worker });
        if (!summary.canDownload) return;
        onPairAvailable({
          platform: 'amazon',
          baseline,
          load: async () => {
            if (revision.current !== batch) throw new Error('The generated pair changed.');
            const [update, rollback] = await Promise.all([
              worker.request({ type: 'download', format: 'amazon-update' }),
              worker.request({ type: 'download', format: 'amazon-rollback' }),
            ]);
            if (revision.current !== batch) throw new Error('The generated pair changed.');
            const asFile = ({ filename, bytes, mime }: WorkerDownload) => new File([bytes], filename, { type: mime });
            return { update: asFile(update), rollback: asFile(rollback) };
          },
        });
      }, 'reading');
  }, [baseline, proposal, paused, onPairAvailable, run]);

  function updateFiles(next: Selection) {
    revision.current += 1;
    reset();
    setReport(undefined);
    onPairAvailable(null);
    setSaving(false);
    setSaveError('');
    setFiles(next);
    onBatchStarted(Boolean(next.baseline || next.proposal));
  }

  function selectFile(role: FileRole, choices: FileList) {
    if (!choices.length) return;
    const input = choices.length === 1 && AMAZON_FILE_EXTENSION.test(choices[0].name)
      ? { file: choices[0] }
      : { error: AMAZON_FILE_ERROR };
    updateFiles({ ...files, [role]: input });
  }

  function loadDemo() {
    const baselineDemo = 'sku\tprice\tminimum-seller-allowed-price\tmaximum-seller-allowed-price\tquantity\thandling-time\r\n'
      + '00042\t12.00\t10.00\t15.00\t8\t2\r\n00067\t25.00\t20.00\t30.00\t3\t5\r\n';
    const proposalDemo = 'sku\tprice\tquantity\r\n00042\t10.00\t6\r\n00067\t30.00\t\r\n';
    updateFiles({
      baseline: { file: new File([baselineDemo], 'amazon-baseline-synthetic.txt', { type: 'text/plain' }), synthetic: true },
      proposal: { file: new File([proposalDemo], 'amazon-proposal-synthetic.tsv', { type: 'text/tab-separated-values' }), synthetic: true },
    });
  }

  async function save(format: Format) {
    if (!report || saving || (format !== 'amazon-audit-json' && !ready)) return;
    const batch = revision.current;
    setSaving(true);
    setSaveError('');
    try {
      const { filename, bytes, mime } = await report.worker.request({ type: 'download', format });
      if (revision.current === batch) downloadFile(filename, bytes, mime);
    } catch (cause) {
      if (revision.current === batch) setSaveError(cause instanceof Error ? cause.message : 'The local download could not finish.');
    } finally {
      if (revision.current === batch) setSaving(false);
    }
  }

  let status = 'Add the Amazon baseline and proposal files.';
  if (held) status = 'Amazon update and rollback held for review.';
  else if (ready) status = 'Amazon update and rollback ready for review.';
  else if (summary?.status === 'no-changes') status = 'No price or quantity changes.';
  else if (paused) status = 'Amazon comparison canceled.';
  else if (baseline && proposal) status = 'Checking the Amazon files locally…';

  return (
    <section className="price-section price-build-files amazon-build" aria-labelledby={id}>
      <div className="price-heading">
        <div>
          <h2 id={id} tabIndex={-1}>Amazon Price &amp; Quantity</h2>
          <p className="field-help">Use one original Price &amp; Quantity export and one proposal. Files stay in this browser.</p>
        </div>
        <button className="button button-secondary" type="button" onClick={loadDemo}>Load Synthetic Amazon Demo</button>
      </div>
      <div className="price-files" role="group" aria-label="Amazon Price and Quantity files">
        {(Object.keys(FIELDS) as FileRole[]).map((role) => {
          const input = files[role];
          return (
            <PriceFileInput key={role} side={`amazon-${role}`} field={FIELDS[role]} inputTestId={`amazon-${role}-input`}
              file={input?.file ? { file: input.file, synthetic: input.synthetic } : undefined}
              message={{ error: input?.error }} onLoad={(choices) => selectFile(role, choices)}
              onClear={() => updateFiles({ ...files, [role]: undefined })}
              clearLabel={role === 'baseline' ? 'Clear Amazon baseline file' : 'Clear Amazon proposal file'} />
          );
        })}
      </div>
      <div className="amazon-corridor">
        <h3>Min/Max Price Corridor</h3>
        <p className="field-help">In the proposal, use the exact header <code>sku</code> and at least one of <code>price</code> or <code>quantity</code>.
          Leave a price or quantity cell blank to keep that value. Only existing SKUs are eligible.</p>
        <p className="field-help">Each proposed price must be within the baseline’s <code>minimum-seller-allowed-price</code> and <code>maximum-seller-allowed-price</code> when supplied.
          Both limits are inclusive. The pair preserves the baseline’s tab or comma delimiter.</p>
        <p className="field-help">Only price and seller-fulfilled quantity can change. Handling time, price limits, and other baseline fields stay intact.</p>
      </div>
      <WorkerStatus progress={progress} paused={paused} finished={finished} error={error} focusHeading={id} onCancel={cancel} onResume={resume} />
      <div className="amazon-review">
        <p className="delta-state" role="status" data-testid="amazon-build-status" data-ready={ready} data-held={held}>{status}</p>
        {summary?.delimiter ? (
          <p className="field-help" data-testid="amazon-baseline-format">
            Baseline format · {summary.delimiter === '\t' ? 'Tab-delimited text' : 'Comma-separated CSV'}.
          </p>
        ) : null}
        {summary?.verification?.restored ? <p className="field-help">Local replay restored the original target cells exactly.</p> : null}
        {report ? (
          <>
            <InspectionIssues worker={report.worker} total={report.summary.issueCount} build />
            <InspectionRows worker={report.worker} total={report.summary.rowCount} build amazon />
          </>
        ) : null}
        <div className="export-buttons" role="group" aria-label="Amazon downloads">
          {DOWNLOADS.map(({ format, label, testId }) => (
            <button key={format} data-testid={testId} type="button"
              className={`button ${format === 'amazon-update' ? 'button-primary' : 'button-secondary'}`}
              disabled={saving || !report || (format !== 'amazon-audit-json' && !ready)} onClick={() => void save(format)}>{label}</button>
          ))}
        </div>
        {saveError ? <p className="file-message file-error" role="alert">{saveError}</p> : null}
      </div>
    </section>
  );
}
