import { getSourceColumn } from '..';
import type { RepairCustody } from '../audit/custody';
import type { FormulaGuardAudit } from '../formula-guard';
import type { PreviewRow, RepairOptions, RepairResult } from '../types';
import type { GuardSummary, RepairPreviewRow, RowMarks } from './protocol';

export function guardSummary({ enabled, neutralized, blocked }: FormulaGuardAudit): GuardSummary {
  return { enabled, neutralizedCount: neutralized.length, blockedCount: blocked.length };
}

export function indexRepairViews(result: RepairResult) {
  const marks = new Map<number, { changed: string[]; review: string[] }>();
  const beforeHeaderMarks = new Set<string>();
  const afterHeaderMarks = new Set<string>();
  function mark(kind: keyof RowMarks, row: number, column: string) {
    const entry = marks.get(row) ?? { changed: [], review: [] };
    entry[kind].push(column);
    marks.set(row, entry);
  }
  for (const { row, column } of result.changes) mark('changed', row, column);
  for (const { row, column, before, after } of result.formulaGuard.neutralized) {
    if (before === column && result.headers.includes(after) && !result.headers.includes(column)) {
      beforeHeaderMarks.add(column);
      afterHeaderMarks.add(after);
    } else {
      mark('changed', row, column);
    }
  }
  for (const entry of result.issues) {
    if (!entry.autoFixed) mark('review', entry.row, entry.column);
    if (entry.code === 'header-normalized' || entry.code === 'column-removed') {
      beforeHeaderMarks.add(entry.rawValue);
      if (entry.fixedValue) afterHeaderMarks.add(entry.fixedValue);
    }
  }

  const cache = (headers: readonly string[]) => {
    const columns = new Map<string, string>();
    return (column: string) => {
      let resolved = columns.get(column);
      if (resolved === undefined) {
        resolved = getSourceColumn(result.platform, headers, column) ?? '';
        columns.set(column, resolved);
      }
      return resolved;
    };
  };
  const before = cache(result.sourceHeaders);
  const after = cache(result.headers);
  function rowView(row: PreviewRow): RepairPreviewRow {
    const rowMarks = marks.get(row.row);
    const resolve = (column: (name: string) => string): RowMarks => ({
      changed: [...new Set(rowMarks?.changed.map(column))], review: [...new Set(rowMarks?.review.map(column))],
    });
    return { ...row, beforeMarks: resolve(before), afterMarks: resolve(after) };
  }
  return { rowView, beforeHeaderMarks: [...beforeHeaderMarks], afterHeaderMarks: [...afterHeaderMarks] };
}

export function repairAudit(result: RepairResult, options: RepairOptions, custody?: RepairCustody) {
  return {
    filename: result.filename, platform: result.platform, options,
    detectedEncoding: result.detectedEncoding, detectedLineEnding: result.detectedLineEnding,
    retainedRowCount: result.rows.length, canDownload: result.canDownload,
    needsManualReviewCount: result.needsManualReviewCount, roundtripCheck: result.roundtripCheck,
    formulaGuard: result.formulaGuard, issues: result.issues, changes: result.changes, removedRows: result.removedRows,
    custody: custody && (result.canDownload ? custody : { sourceSha256: custody.sourceSha256 }),
    currencySplit: result.currencySplit, stripePayPalFeeConvention: result.stripePayPalFeeConvention,
    balanceChain: result.balanceChain, freshBooksTaxes: result.freshBooksTaxes,
    taxReconciliation: result.taxReconciliation, duplicateTransactions: result.duplicateTransactions,
  };
}

export function repairAuditText(report: ReturnType<typeof repairAudit>): string {
  const quote = (value: string) => JSON.stringify(value);
  return [
    'ImportMedic CSV audit',
    `Source file: ${quote(report.filename)}`,
    `Platform: ${report.platform}`,
    `Settings: ${JSON.stringify(report.options)}`,
    `Detected encoding: ${report.detectedEncoding}`,
    `Detected line endings: ${report.detectedLineEnding}`,
    `Retained rows: ${report.retainedRowCount}`,
    `CSV export available: ${report.canDownload ? 'Yes' : 'No'}`,
    `Needs manual review: ${report.needsManualReviewCount}`,
    `Roundtrip validation: ${report.roundtripCheck.checked ? JSON.stringify(report.roundtripCheck) : 'Unavailable'}`,
    ...(report.balanceChain ? [`Running-balance chain: ${JSON.stringify(report.balanceChain)}`] : []),
    ...(report.freshBooksTaxes ? [`FreshBooks tax review: ${JSON.stringify(report.freshBooksTaxes)}`] : []),
    ...(report.taxReconciliation ? [`Tax reconciliation: ${JSON.stringify(report.taxReconciliation)}`] : []),
    ...(report.duplicateTransactions ? [`Duplicate transactions: ${JSON.stringify(report.duplicateTransactions)}`] : []),
    '',
    `ISSUES (${report.issues.length})`,
    ...report.issues.map((issue) =>
      `Line ${issue.row} | ${issue.column} | ${issue.autoFixed ? 'Auto-fixed' : issue.severity} | ${issue.code}\n  ${issue.message}\n  Before: ${quote(issue.rawValue)}${issue.fixedValue === undefined ? '' : `\n  After: ${quote(issue.fixedValue)}`}`,
    ),
    '',
    `CHANGES (${report.changes.length})`,
    ...report.changes.map((change) =>
      `Line ${change.row} | ${change.column} | ${change.code}\n  ${quote(change.before)} → ${quote(change.after)}\n  ${change.reason}`,
    ),
    '',
    `FORMULA GUARD (${report.formulaGuard.enabled ? 'on' : 'off'})`,
    ...(['neutralized', 'blocked'] as const).flatMap((state) => report.formulaGuard[state].map(({ row, column, before, after }) =>
      `Line ${row} | ${column} | ${state}\n  ${quote(before)} → ${quote(after)}`)),
    '',
    `REMOVED ROWS (${report.removedRows.length})`,
    ...report.removedRows.map((row) =>
      `Line ${row.row} | ${row.code} | ${row.reason}\n  ${quote(row.rawPreview)}`,
    ),
    '',
  ].join('\n');
}
