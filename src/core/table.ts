import type { CsvRecord } from './csv';
import type { Journal } from './journal';
import type { ManualCellEdit } from './types';

export type HeaderAliases = ReadonlyMap<string, string>;

const headerKey = (value: string): string => value.trim().toLowerCase();

export function headerAliases(fields: Record<string, readonly string[]>): HeaderAliases {
  const entries = Object.entries(fields).flatMap(([canonical, aliases]) =>
    [canonical, ...aliases].map((name) => [headerKey(name), canonical] as const),
  );
  return new Map(entries);
}

export function canonicalHeader(header: string, aliases: HeaderAliases): string {
  return aliases.get(headerKey(header)) ?? header.trim();
}

export interface WorkingRow {
  source: CsvRecord;
  cells: string[];
  after: string[];
  invalid: boolean;
}

export interface Table {
  headers: string[];
  sourceHeaders: string[];
  headerLine: number;
  rows: WorkingRow[];
  positions: Map<string, number>;
}

export function findSourceColumn(sourceHeaders: readonly string[], column: string, aliases: HeaderAliases): number {
  const exact = sourceHeaders.indexOf(column);
  if (exact !== -1) return exact;
  return sourceHeaders.findIndex((header) => canonicalHeader(header, aliases) === column);
}

const smartPunctuation: Record<string, string> = {
  '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', ' ': ' ',
};

const hasNoCells = (record: CsvRecord): boolean =>
  !record.parseError && (record.raw.trim() === '' || record.cells.every((cell) => cell === ''));

export function readTable(
  input: readonly CsvRecord[],
  aliases: HeaderAliases,
  journal: Journal,
  edits: readonly ManualCellEdit[],
  { fixWindowsPunctuation, paddingColumns }: { fixWindowsPunctuation: boolean; paddingColumns?: ReadonlySet<string> },
): Table {
  const records = input.filter((record) => {
    if (!hasNoCells(record)) return true;
    journal.remove('blank-row', record, 'Removed an empty CSV record.');
    return false;
  });
  const [head, ...sourceRows] = records;
  const headerLine = head?.line ?? 1;
  const sourceHeaders = head?.cells ?? [];
  const headers = sourceHeaders.map((header) => canonicalHeader(header, aliases));
  const positions = new Map<string, number>();
  headers.forEach((column, index) => {
    if (column === '') {
      journal.issue('missing-header', headerLine, 'CSV header', '', `Column ${index + 1} has no header.`, { block: true });
    } else if (positions.has(headerKey(column))) {
      journal.issue('duplicate-header', headerLine, column, sourceHeaders[index], 'Resolve duplicate source columns before exporting.', { block: true });
    } else {
      positions.set(headerKey(column), index);
      journal.fix('header-normalized', headerLine, column, sourceHeaders[index], column, 'Mapped the source header to its expected spelling.');
    }
  });

  const editsByRow = new Map<number, Map<number, string>>();
  for (const { row, column, value } of edits) {
    const index = findSourceColumn(sourceHeaders, column, aliases);
    if (index === -1) continue;
    const rowEdits = editsByRow.get(row) ?? new Map<number, string>();
    rowEdits.set(index, value);
    editsByRow.set(row, rowEdits);
  }

  const rows = sourceRows.map((source): WorkingRow => {
    const { line, parseError } = source;
    const cells = source.cells.slice();
    let invalid = Boolean(parseError);
    if (!invalid && cells.length !== headers.length) {
      if (cells.length < headers.length && paddingColumns && headers.slice(cells.length).every((header) => paddingColumns.has(header))) {
        journal.issue('row-width', line, 'CSV row', `${cells.length} columns`, 'Padded missing trailing optional columns.', { fixedValue: `${headers.length} columns` });
        while (cells.length < headers.length) {
          journal.change('row-width', line, headers[cells.length], '', '', 'Added a trailing empty cell.');
          cells.push('');
        }
      } else {
        journal.issue('row-width', line, 'CSV row', source.raw, `This record has ${cells.length} cells. The header has ${headers.length}.`, { block: true });
        invalid = true;
      }
    }
    if (!invalid) {
      for (const [index, value] of editsByRow.get(line) ?? []) {
        if (cells[index] === value) continue;
        journal.change('manual-edit', line, headers[index], cells[index], value, 'Applied the cell edit supplied by the user.');
        cells[index] = value;
      }
      if (fixWindowsPunctuation) {
        cells.forEach((value, index) => {
          const fixed = value.replace(/[‘’“”–— ]/g, (character) => smartPunctuation[character]);
          cells[index] = journal.fix('encoding-repaired', line, headers[index], value, fixed, 'Normalized legacy Windows punctuation.');
        });
      }
    }
    return { source, cells, after: cells, invalid };
  });
  return { headers, sourceHeaders, headerLine, rows, positions };
}

export const columnIndex = (table: Table, column: string): number | undefined =>
  table.positions.get(headerKey(column));

export function requireColumn(table: Table, column: string, journal: Journal, details?: string): number | undefined {
  const index = columnIndex(table, column);
  if (index === undefined) {
    journal.issue('missing-header', table.headerLine, column, '', details ?? `Add the ${column} column using your source export.`, { block: true });
  }
  return index;
}

export function auditProjection(table: Table, retained: ReadonlySet<string>, journal: Journal): void {
  table.headers.forEach((column, index) => {
    if (retained.has(column)) return;
    const reason = 'The selected output schema has no field for this source column.';
    journal.fix('column-removed', table.headerLine, column, table.sourceHeaders[index], '', reason);
    for (const row of table.rows) {
      if (row.invalid || row.cells[index] === '') continue;
      journal.change('column-removed', row.source.line, column, row.cells[index], '', reason);
    }
  });
}
