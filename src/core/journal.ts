import type { CsvRecord } from './csv';
import { ruleDocSlug, type RuleId } from './rules';
import type { BookkeeperAmountRow, CellChange, PlatformId, RemovedRow, RepairIssue, RepairResult } from './types';

export class Journal {
  readonly issues: RepairIssue[] = [];
  readonly changes: CellChange[] = [];
  readonly removedRows: RemovedRow[] = [];
  private readonly idCounts = new Map<string, number>();
  blocked = false;
  readonly bookkeeperAmounts?: BookkeeperAmountRow[];
  currencySplit?: RepairResult['currencySplit'];

  constructor(private readonly platform: PlatformId, collectBookkeeperAmounts = false) {
    if (collectBookkeeperAmounts) this.bookkeeperAmounts = [];
  }

  issue(
    code: RuleId,
    row: number,
    column: string,
    rawValue: string,
    message: string,
    { fixedValue, editable = false, block = false, reconciliation }:
    Pick<RepairIssue, 'fixedValue' | 'editable' | 'reconciliation'> & { block?: boolean } = {},
  ): void {
    const key = `${code}:${row}:${column}`;
    const count = (this.idCounts.get(key) ?? 0) + 1;
    this.idCounts.set(key, count);
    this.issues.push({
      id: count === 1 ? key : `${key}:${count}`,
      severity: fixedValue === undefined ? 'error' : 'warning',
      code,
      row,
      column,
      rawValue,
      fixedValue,
      autoFixed: fixedValue !== undefined,
      message,
      ruleDocSlug: ruleDocSlug(code, this.platform),
      editable,
      ...(reconciliation && { reconciliation }),
    });
    this.blocked ||= block;
  }

  change(code: RuleId, row: number, column: string, before: string, after: string, reason: string): void {
    this.changes.push({ row, column, before, after, reason, code });
  }

  fix(code: RuleId, row: number, column: string, before: string, after: string, reason: string): string {
    if (before !== after) {
      this.issue(code, row, column, before, reason, { fixedValue: after });
      this.change(code, row, column, before, after, reason);
    }
    return after;
  }

  remove(code: RuleId, record: CsvRecord, reason: string): void {
    this.removedRows.push({ row: record.line, rawPreview: record.raw, reason, code });
    this.issue(code, record.line, 'CSV row', record.raw, reason, { fixedValue: '' });
  }
}
