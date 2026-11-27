import { useId } from 'react';
import type { DownloadFormat, RepairSummary } from '../../core/worker/protocol';
import { RepairFingerprints } from './CustodyFingerprints';

export type RepairDownload = Extract<DownloadFormat, `repair-${string}`>;

export function downloadFile(filename: string, content: string | ArrayBuffer, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function FormulaGuard({ checked, disabled, onChange, description }: {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  description: string;
}) {
  const id = useId();
  return (
    <div className="formula-option">
      <label className="checkbox-label">
        <input type="checkbox" checked={checked} disabled={disabled} aria-describedby={id} onChange={(event) => onChange(event.currentTarget.checked)} />
        <span>Guard spreadsheet formulas (=, +, -, @)</span>
      </label>
      <p id={id} className="field-help">{description}</p>
    </div>
  );
}

export function ExportActions({ result, current, busy, guardEnabled, onGuard, onDownload }: {
  result: RepairSummary;
  current: boolean;
  busy: boolean;
  guardEnabled: boolean;
  onGuard: (value: boolean) => void;
  onDownload: (format: RepairDownload) => void;
}) {
  const warningId = useId();
  const unresolved = result.needsManualReviewCount + result.warnings;
  const explanation = !result.canDownload
    ? 'CSV export is blocked. Review the flagged issues and settings. Audit reports are available.'
    : unresolved
      ? `Draft CSV. ${unresolved.toLocaleString('en-US')} unresolved ${unresolved === 1 ? 'issue remains' : 'issues remain'}. Review before importing.`
      : '';
  return (
    <div className="export-actions">
      {result.platform === 'xero-bank' ? (
        <p className="field-help">Spreadsheet formula protection is always on for Xero. The audit lists any escaped text cells.</p>
      ) : (
        <FormulaGuard checked={guardEnabled} disabled={!current || busy} onChange={onGuard}
          description="Prefixes formula-like text with an apostrophe in the repaired CSV. Signed amounts stay unchanged." />
      )}
      <p className="field-help" role="status" aria-busy={!current && busy}>
        {current ? `Audit preview · ${result.formulaGuard.neutralizedCount.toLocaleString('en-US')} spreadsheet formula cells neutralized.` : 'Audit preview updates after processing.'}
      </p>
      {current && explanation ? <p id={warningId} className="export-warning">{explanation}</p> : null}
      <div className="export-buttons">
        <button className="button button-primary" type="button" disabled={!current || busy || !result.canDownload}
          aria-describedby={current && explanation ? warningId : undefined}
          onClick={() => onDownload('repair-csv')}>Download Repaired CSV</button>
        <button className="button button-secondary" type="button" disabled={!current || busy} onClick={() => onDownload('repair-audit-json')}>Download Audit Report (.json)</button>
        <button className="button button-secondary" type="button" disabled={!current || busy} onClick={() => onDownload('repair-audit-txt')}>Download Audit Report (.txt)</button>
        <button className="button button-secondary" type="button" disabled={!current || busy}
          aria-describedby={current && !result.canDownload ? warningId : undefined}
          onClick={() => onDownload('repair-bookkeeper-html')}>Download Bookkeeper Sign-Off (.html)</button>
      </div>
      {current ? <RepairFingerprints custody={result.custody} ready={result.canDownload} /> : null}
    </div>
  );
}

export function Inquiry() {
  return (
    <aside className="inquiry-card" aria-label="Batch cleanup inquiry">
      <div>
        <h2>Recurring CSV cleanup?</h2>
        <p>Scope a fixed-price cleanup for repeated imports or custom spreadsheets.</p>
      </div>
      <details>
        <summary>Request fixed-price cleanup</summary>
        <p>Quote requests are currently closed. Save a blank brief to prepare your scope.</p>
        <button className="button button-secondary button-small" type="button" onClick={() => downloadFile(
          'importmedic-cleanup-inquiry.txt',
          'CSV cleanup inquiry\n\nTarget platform:\nApproximate file count:\nHow often files arrive:\nRecurring import errors:\nDesired output:\n\nUse generic examples without customer or transaction data.\n',
          'text/plain;charset=utf-8',
        )}>Download inquiry template</button>
      </details>
    </aside>
  );
}
