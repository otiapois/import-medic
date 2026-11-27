import { useRef, useState } from 'react';
import type { DiffSummary, RepairSummary } from '../../core/worker/protocol';

interface Fingerprint {
  field: string;
  label: string;
  sha256?: string;
  detail?: string;
}

export function PriceFingerprints({ custody, ready }: { custody: DiffSummary['custody']; ready: boolean }) {
  return <CustodyFingerprints entries={[
    { field: 'baseline', label: 'Baseline', sha256: custody.baselineSha256 },
    ...custody.suppliers.map(({ filename, sha256, bytes }, index) => ({
      field: `supplier-${index + 1}`, label: `Supplier ${index + 1}`, sha256,
      detail: `${filename} · ${bytes.toLocaleString('en-US')} bytes`,
    })),
    { field: 'update', label: 'Update CSV', sha256: ready ? custody.updateCsvSha256 : undefined },
    { field: 'rollback', label: 'Rollback CSV', sha256: ready ? custody.rollbackCsvSha256 : undefined },
  ]} />;
}

export function RepairFingerprints({ custody, ready }: { custody: RepairSummary['custody']; ready: boolean }) {
  return <CustodyFingerprints entries={[
    { field: 'source', label: 'Source CSV', sha256: custody.sourceSha256 },
    { field: 'repaired', label: 'Repaired CSV', sha256: ready ? custody.repairedCsvSha256 : undefined },
  ]} />;
}

export function CustodyFingerprints({ entries, open }: { entries: readonly Fingerprint[]; open?: boolean }) {
  return (
    <details className="custody-fingerprints" data-testid="custody-fingerprints" open={open}>
      <summary>SHA-256 file fingerprints</summary>
      <ul>
        {entries.map(({ field, label, detail, sha256 }) => sha256 ? (
          <FingerprintRow key={`${field}-${sha256}`} field={field} label={label} detail={detail} sha256={sha256} />
        ) : null)}
      </ul>
    </details>
  );
}

function FingerprintRow({ field, label, detail, sha256 }: Fingerprint & { sha256: string }) {
  const digest = useRef<HTMLElement>(null);
  const [feedback, setFeedback] = useState<'Copy' | 'Copied' | 'Selected' | 'Copy failed'>('Copy');
  const status = {
    Copy: '',
    Copied: `${label} fingerprint copied.`,
    Selected: `${label} fingerprint selected. Use your device’s copy command.`,
    'Copy failed': 'Select the fingerprint to copy it manually.',
  }[feedback];

  async function copy() {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(sha256);
        setFeedback('Copied');
        return;
      }
    } catch {
      // Select the displayed text if the browser denies clipboard access.
    }
    const selection = window.getSelection();
    if (!selection || !digest.current) {
      setFeedback('Copy failed');
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(digest.current);
    selection.removeAllRanges();
    selection.addRange(range);
    setFeedback('Selected');
  }

  return (
    <li className="custody-fingerprint">
      <div>
        <strong>{label}</strong>
        {detail ? <span className="custody-file-detail">{detail}</span> : null}
        <code ref={digest} data-custody-field={field}>{sha256}</code>
      </div>
      <button className="button button-secondary button-small" type="button" aria-label={`Copy ${label} SHA-256`} title={status || undefined} onClick={copy}>{feedback}</button>
      <span className="sr-only" role="status">{status}</span>
    </li>
  );
}
