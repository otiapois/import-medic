import { decodeCsv, parseCsv, serializeCsv, type CsvRecord } from '../csv';
import { guardSpreadsheetCell } from '../formula-guard';
import { currentHeader, inventoryIdentity, newHeader, type readInventoryBaseline } from './source';
import type { InventoryIssue, InventorySyncResult, InventorySyncRow } from './types';

const nativeFileLimit = 15_000_000;
const utf8 = new TextEncoder();

export function makeInventoryPair(
  baseline: ReturnType<typeof readInventoryBaseline>, target: string, rows: readonly InventorySyncRow[], issues: InventoryIssue[],
): Pick<InventorySyncResult, 'updateCsv' | 'rollbackCsv' | 'verification'> {
  const verification = { checked: false, restoredRows: 0, otherLocationRowsUntouched: 0 };
  const held = { updateCsv: null, rollbackCsv: null, verification };
  if (issues.length) return held;
  const changes = rows.filter(row => row.status === 'changed');
  if (!changes.length) return held;

  const recordsByLine = new Map(baseline.records.map(record => [record.line, record]));
  const identityHeaders = baseline.identity.map(({ header }) => header);
  const headers = [...identityHeaders, currentHeader, newHeader];
  const entries = changes.map(change => {
    const record = recordsByLine.get(change.baselineLine)!;
    const identity = baseline.identity.map(({ position }) => record.cells[position]);
    const unsafeColumn = identity.findIndex(value => guardSpreadsheetCell(value) !== value);
    if (unsafeColumn >= 0) issues.push({ code: 'unsafe-native-identity', source: 'baseline', sku: change.sku, line: record.line,
      column: identityHeaders[unsafeColumn], value: identity[unsafeColumn],
      message: 'An identity field could execute as a spreadsheet formula. Correct the original inventory export before retrying.' });
    return { identity, before: change.currentRaw, after: String(change.proposedQty) };
  });
  if (issues.length) return held;

  const updateRows = entries.map(({ identity, before, after }) => [...identity, before, after]);
  const rollbackRows = entries.map(({ identity, before, after }) => [...identity, after, before]);
  const encode = (records: string[][]) => utf8.encode(serializeCsv(headers, records, 'shopify-products'));
  const updateCsv = encode(updateRows);
  const rollbackCsv = encode(rollbackRows);
  if (updateCsv.byteLength > nativeFileLimit || rollbackCsv.byteLength > nativeFileLimit) {
    issues.push({ code: 'native-file-too-large', source: 'run', message: 'The native pair exceeds Shopify’s 15 MB CSV import limit.' });
    return held;
  }

  const identityColumns = new Map(baseline.identity.map(({ canonical }, position) => [canonical, position]));
  const byKey = new Map<string, { record: CsvRecord; currentRaw: string }>();
  for (const record of baseline.records) {
    const { key, currentRaw, location } = inventoryIdentity(record, baseline.columns);
    if (location === target) byKey.set(key, { record, currentRaw });
    else verification.otherLocationRowsUntouched++;
  }
  const replay = (bytes: Uint8Array, expected: string[][]) => {
    const { text, encoding } = decodeCsv(bytes);
    if (encoding !== 'utf-8') return false;
    const [header, ...records] = parseCsv(text).records;
    const exactRecord = (record: CsvRecord | undefined, cells: string[]) => record !== undefined && !record.parseError &&
      record.cells.length === cells.length && record.cells.every((cell, i) => cell === cells[i]);
    if (!exactRecord(header, headers) || records.length !== expected.length) return false;
    const seen = new Set<string>();
    return records.every((record, i) => {
      if (!exactRecord(record, expected[i])) return false;
      const { key, location } = inventoryIdentity(record, identityColumns);
      const state = byKey.get(key);
      const current = record.cells[headers.length - 2];
      if (location !== target || !state || seen.has(key) || state.currentRaw !== current) return false;
      seen.add(key);
      state.currentRaw = record.cells[headers.length - 1];
      return true;
    });
  };
  verification.checked = true;
  if (!replay(updateCsv, updateRows) || !replay(rollbackCsv, rollbackRows) ||
    [...byKey.values()].some(({ record, currentRaw }) => currentRaw !== record.cells[baseline.columns.get(currentHeader)!])) {
    issues.push({ code: 'native-replay-failed', source: 'run', message: 'The native pair failed exact selected-location inventory replay.' });
    return held;
  }
  verification.restoredRows = changes.length;
  return { updateCsv, rollbackCsv, verification };
}
