import { sha256 } from '../audit/custody';
import { serializeCsvRecords, type CsvDelimiter } from '../csv';
import type { ImportDiffRow, ImportInspection, ImportInspectionIssue } from '../verify-import/inspector';
import {
  amazonCell, amazonFields, amazonFileExtension, amazonFulfilled, maxPrice, minPrice, readAmazonTable, readAmazonValue, skuHeader,
  type AmazonField, type AmazonRow, type AmazonSource, type AmazonTable,
} from './source';

export { amazonFileExtension };
export interface AmazonInput { filename: string; bytes: Uint8Array }
export interface AmazonPriceResult {
  status: 'ready' | 'blocked' | 'no-changes';
  canDownload: boolean;
  delimiter: CsvDelimiter | null;
  fileNames: { update: string; rollback: string; audit: string };
  rows: ImportDiffRow[];
  issues: ImportInspectionIssue[];
  verification: ImportInspection['rollback'] | null;
  updateBytes: Uint8Array<ArrayBuffer> | null;
  rollbackBytes: Uint8Array<ArrayBuffer> | null;
  auditJson: string;
}

type Write = { field: AmazonField; before: string; after: string; delta: string };
type ScopedRow = { original: AmazonRow; incoming: AmazonRow; writes: Write[] };
type Scope = Map<string, ScopedRow>;

function cents(value: bigint): string {
  const digits = (value < 0n ? -value : value).toString().padStart(3, '0');
  return (value < 0n ? '-' : '') + digits.slice(0, -2) + '.' + digits.slice(-2);
}

function scopeFile(baseline: AmazonTable, file: AmazonTable, source: Exclude<AmazonSource, 'baseline'>,
  issues: ImportInspectionIssue[], proposal = false,
): { scope: Scope; matchedRows: number; nonTargetMutations: number } {
  const scope: Scope = new Map();
  let matchedRows = 0;
  let nonTargetMutations = 0;
  if (!proposal && baseline.delimiter && file.delimiter && baseline.delimiter !== file.delimiter) {
    issues.push({ source, code: 'amazon-delimiter-mismatch', line: file.headerLine, message: 'The scoped file must use the same delimiter as the baseline.' });
  }
  const forbidden = file.headers.flatMap((header, index) => header !== skuHeader && !amazonFields.some(field => field === header) ? [index] : []);
  for (const [sku, incoming] of file.rows) {
    nonTargetMutations += forbidden.filter(index => incoming.cells[index] !== '').length;
    const original = baseline.rows.get(sku);
    const report = (code: string, message: string, column: string, issueSource: AmazonSource = source) => {
      issues.push({ source: issueSource, code, message, column, line: issueSource === 'baseline' ? original?.line : incoming.line,
        baselineLine: original?.line, candidateLine: incoming.line });
    };
    if (!original) {
      report('amazon-unknown-sku', 'This exact SKU is missing from the baseline. Only existing listings can be updated.', skuHeader);
      continue;
    }
    matchedRows++;
    const chosen = amazonFields.filter(field => amazonCell(file, incoming, field) !== '');
    if (!chosen.length) {
      report('amazon-empty-change', 'Enter a price or quantity for this SKU. Leave an individual cell blank to keep its current value.', skuHeader);
      continue;
    }
    const limit = (column: string) => {
      const raw = amazonCell(baseline, original, column);
      const value = raw.trim() === '' ? null : readAmazonValue('price', raw);
      if (value === null && raw.trim() !== '') {
        report('amazon-invalid-corridor', 'Enter the original positive price limit with cent precision, or leave an unknown limit blank.', column, 'baseline');
      }
      return value;
    };
    const minimum = limit(minPrice);
    const maximum = limit(maxPrice);
    const outside = (value: bigint) => (minimum !== null && value < minimum) || (maximum !== null && value > maximum);
    if (minimum !== null && maximum !== null && minimum > maximum) {
      report('amazon-inverted-corridor', `The supplied minimum price ${cents(minimum)} exceeds the maximum price ${cents(maximum)}.`, minPrice, 'baseline');
    }

    const writes: Write[] = [];
    for (const field of chosen) {
      const after = amazonCell(file, incoming, field);
      const before = amazonCell(baseline, original, field);
      const next = readAmazonValue(field, after);
      const prior = readAmazonValue(field, before);
      if (next === null) {
        report('amazon-invalid-value', field === 'price' ? 'Enter a positive decimal price with cent precision and no currency symbol.' :
          'Enter a nonnegative whole quantity.', field);
      } else if (field === 'quantity' && amazonFulfilled(baseline, original)) {
        report('amazon-fba-quantity', 'Leave quantity blank for this Amazon-fulfilled listing. Only seller-fulfilled quantities can be written.', field);
      } else if (field === 'price' && outside(next)) {
        const bounds = [minimum === null ? '' : `minimum ${cents(minimum)}`, maximum === null ? '' : `maximum ${cents(maximum)}`].filter(Boolean).join(', ');
        report('amazon-price-outside-corridor', `The proposed price ${cents(next)} is outside the known Amazon price corridor (${bounds}).`, field);
      } else if (prior === null || (field === 'price' && outside(prior))) {
        report('amazon-unrestorable-value', 'The original value cannot be safely written back under the supplied baseline constraints.', field, 'baseline');
      } else if (!proposal || prior !== next) {
        writes.push({ field, before, after, delta: field === 'price' ? cents(next - prior) : (next - prior).toString() });
      }
    }
    if (writes.length) scope.set(sku, { original, incoming, writes });
  }
  return { scope, matchedRows, nonTargetMutations };
}

function diffRows(scope: Scope): ImportDiffRow[] {
  return [...scope].flatMap(([sku, { original, incoming, writes }]) => {
    const changes = writes.filter(({ before, after }) => before !== after).map(({ field, before, after, delta }) => ({ column: field, before, after, delta }));
    return changes.length ? [{ sku, product: sku, baselineLine: original.line, candidateLine: incoming.line, changes }] : [];
  });
}

function replayPair(baseline: AmazonTable, update: Scope, rollback: Scope, issues: ImportInspectionIssue[]): number {
  let residualDiffs = 0;
  for (const [sku, row] of baseline.rows) {
    const forward = update.get(sku);
    const reverse = rollback.get(sku);
    if (!forward && !reverse) continue;
    const restored = row.cells.slice();
    const fields = new Set<AmazonField>();
    for (const write of forward?.writes ?? []) {
      restored[baseline.positions.get(write.field)!] = write.after;
      fields.add(write.field);
    }
    for (const write of reverse?.writes ?? []) {
      restored[baseline.positions.get(write.field)!] = write.after;
      if (!fields.delete(write.field)) {
        issues.push({ source: 'candidate', code: 'amazon-rollback-scope', message: 'The rollback writes a field outside the matched update scope.',
          line: reverse?.incoming.line, candidateLine: reverse?.incoming.line, baselineLine: row.line, column: write.field });
      }
    }
    for (const field of fields) {
      issues.push({ source: 'candidate', code: 'amazon-rollback-scope', message: 'The rollback is missing a field written by the matched update.',
        line: reverse?.incoming.line, candidateLine: reverse?.incoming.line, baselineLine: row.line, column: field });
    }
    for (const [index, original] of row.cells.entries()) {
      if (restored[index] === original) continue;
      residualDiffs++;
      issues.push({ source: 'candidate', code: 'amazon-rollback-residual', message: 'Replaying the pair did not restore the exact original cell.',
        line: reverse?.incoming.line, candidateLine: reverse?.incoming.line, baselineLine: row.line, column: baseline.headers[index] });
    }
  }
  return residualDiffs;
}

export async function inspectAmazonImport(baselineBytes: Uint8Array, candidateBytes: Uint8Array, pairedUpdateBytes?: Uint8Array): Promise<ImportInspection> {
  const hashes = Promise.all([sha256(baselineBytes), sha256(candidateBytes), pairedUpdateBytes && sha256(pairedUpdateBytes)]);
  const baseline = readAmazonTable(baselineBytes, 'baseline');
  const candidate = readAmazonTable(candidateBytes, 'candidate');
  const update = pairedUpdateBytes && readAmazonTable(pairedUpdateBytes, 'update');
  const issues = [...baseline.issues, ...candidate.issues, ...(update?.issues ?? [])];
  const compared = scopeFile(baseline, candidate, 'candidate', issues);
  const paired = update && scopeFile(baseline, update, 'update', issues);
  const unsafeInputs = issues.length > 0;
  const rows = diffRows(compared.scope);
  const residualDiffs = unsafeInputs ? null : paired ? replayPair(baseline, paired.scope, compared.scope, issues) :
    rows.reduce((count, { changes }) => count + changes.length, 0);
  const [baselineSha256, candidateSha256, pairedUpdateSha256] = await hashes;
  return {
    verdict: issues.length ? 'FAIL_UNSAFE' : 'PASS', baselineSha256, candidateSha256, matchedRows: compared.matchedRows,
    changedRows: rows.length, changedSkus: rows.length, unchangedSiblingSkus: 0,
    nonTargetMutations: compared.nonTargetMutations + (paired?.nonTargetMutations ?? 0), brokenGroups: 0, issues, rows,
    rollback: {
      scope: paired ? 'paired-update' : 'candidate-vs-baseline', residualDiffs, restored: residualDiffs === 0 && issues.length === 0,
      ...(pairedUpdateSha256 === undefined ? {} : { pairedUpdateSha256 }),
    },
  };
}

function serializeScope(scope: Scope, side: 'before' | 'after', delimiter: CsvDelimiter): Uint8Array<ArrayBuffer> {
  const columns = amazonFields.filter(field => [...scope.values()].some(({ writes }) => writes.some(write => write.field === field)));
  const rows = [...scope].map(([sku, { writes }]) => [sku, ...columns.map(field => writes.find(write => write.field === field)?.[side] ?? '')]);
  return new TextEncoder().encode(serializeCsvRecords([[skuHeader, ...columns], ...rows], 'amazon', delimiter));
}

export async function buildAmazonPriceDiff(baselineInput: AmazonInput, proposalInput: AmazonInput): Promise<AmazonPriceResult> {
  const fingerprints = Promise.all([sha256(baselineInput.bytes), sha256(proposalInput.bytes)]);
  const baseline = readAmazonTable(baselineInput.bytes, 'baseline');
  const proposal = readAmazonTable(proposalInput.bytes, 'candidate');
  const { delimiter } = baseline;
  const extension = delimiter === '\t' ? (baselineInput.filename.toLowerCase().endsWith('.txt') ? 'txt' : 'tsv') : 'csv';
  const fileNames = { update: 'amazon-update.' + extension, rollback: 'amazon-rollback.' + extension, audit: 'price-audit.json' };
  const issues = [...baseline.issues, ...proposal.issues];
  for (const [source, input] of [['baseline', baselineInput], ['candidate', proposalInput]] as const) {
    if (!amazonFileExtension.test(input.filename)) issues.push({ source, code: 'amazon-invalid-extension', message: 'Choose a .csv, .tsv, or .txt flat file.' });
  }
  const { scope } = scopeFile(baseline, proposal, 'candidate', issues, true);
  const rows = diffRows(scope);
  let updateBytes = null;
  let rollbackBytes = null;
  let verification = null;
  let outputDigests = {};
  if (!issues.length && rows.length && delimiter) {
    const update = serializeScope(scope, 'after', delimiter);
    const rollback = serializeScope(scope, 'before', delimiter);
    const replayed = await inspectAmazonImport(baselineInput.bytes, rollback, update);
    const written = scopeFile(baseline, readAmazonTable(update, 'update'), 'update', []).scope;
    const expected = (scope: Scope) => [...scope].map(([sku, { writes }]) => [sku, writes.map(({ field, after }) => [field, after])]);
    if (replayed.verdict === 'PASS' && replayed.rollback.restored && replayed.nonTargetMutations === 0 &&
      JSON.stringify(expected(written)) === JSON.stringify(expected(scope))) {
      updateBytes = update;
      rollbackBytes = rollback;
      verification = replayed.rollback;
      outputDigests = { updateSha256: replayed.rollback.pairedUpdateSha256, rollbackSha256: replayed.candidateSha256 };
    } else {
      issues.push({ source: 'candidate', code: 'amazon-roundtrip-failed', message: 'The generated update and rollback failed local byte replay.' });
    }
  }
  const [baselineSha256, proposalSha256] = await fingerprints;
  const status = updateBytes ? 'ready' : issues.length ? 'blocked' : 'no-changes';
  const auditJson = JSON.stringify({ version: 1, platform: 'amazon', status, delimiter, fileNames, rows, issues, verification,
    inputs: { baseline: baselineInput.filename, proposal: proposalInput.filename }, custody: { baselineSha256, proposalSha256, ...outputDigests } }, null, 2) + '\n';
  return { status, canDownload: updateBytes !== null, delimiter, fileNames, rows, issues, verification, updateBytes, rollbackBytes, auditJson };
}
