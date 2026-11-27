export interface FormulaGuardCell {
  row: number;
  column: string;
  before: string;
  after: string;
}

export interface FormulaGuardAudit {
  enabled: boolean;
  neutralized: readonly FormulaGuardCell[];
  blocked: readonly FormulaGuardCell[];
}

const leadingFormula = /^[\t\r\n]|^[\s\x00-\x1f\x7f\u0085\u200b-\u200f\u202a-\u202e\u2060-\u206f]*[=+\-@＝＋－＠]/u;
const signedDecimal = /^[+-](?:\d+(?:\.\d+)?|\.\d+)$/;

export function guardSpreadsheetCell(value: string): string {
  return leadingFormula.test(value) && !signedDecimal.test(value) ? "'" + value : value;
}

export function guardSpreadsheetRow(
  cells: readonly string[], headers: readonly string[], row: number, changes: FormulaGuardCell[],
): string[] {
  return cells.map((before, index) => {
    const after = guardSpreadsheetCell(before);
    if (before !== after) changes.push({ row, column: headers[index], before, after });
    return after;
  });
}
