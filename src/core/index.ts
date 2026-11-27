import { decodeCsv, parseCsv, serializeCsv } from './csv';
import { guardSpreadsheetRow } from './formula-guard';
import type { FormulaGuardCell } from './formula-guard';
import { Journal } from './journal';
import { quickBooksAliases, repairQuickBooks, stripBankStatement } from './profiles/quickbooks-bank';
import { repairShopify, shopifyAliases, shopifyPaddingColumns } from './profiles/shopify-products';
import { repairStripePayPal, resolveFeeConvention, stripePayPalAliases } from './profiles/stripe-paypal';
import { findSourceColumn, readTable } from './table';
import type { FeeConvention, ManualCellEdit, PlatformId, RepairOptions, RepairResult, RoundtripCheck } from './types';

export * from './types';
export { RECOGNIZED_RULE_IDS } from './rules';

const aliases = {
  'shopify-products': shopifyAliases,
  'quickbooks-bank': quickBooksAliases,
  'stripe-paypal': stripePayPalAliases,
};

export function getSourceColumn(platform: PlatformId, sourceHeaders: readonly string[], column: string): string | undefined {
  return sourceHeaders[findSourceColumn(sourceHeaders, column, aliases[platform])];
}

function runPass(bytes: Uint8Array, platform: PlatformId, options: RepairOptions, edits: readonly ManualCellEdit[], collectBookkeeperAmounts = false) {
  const journal = new Journal(platform, collectBookkeeperAmounts);
  const decoded = decodeCsv(bytes);
  const parsed = parseCsv(decoded.text);
  const { encoding } = decoded;
  const { records, lineEnding } = parsed;
  const empty = { headers: [], sourceHeaders: [], headerLine: 1, rows: [], encoding, lineEnding, journal, exportPlatform: platform,
    exportOptions: options, feeConvention: undefined };
  if (encoding === 'unknown') {
    journal.issue('invalid-encoding', 1, 'File encoding', '', 'Save a CSV as UTF-8, Windows-1252, or UTF-16LE with a BOM, then open it again.', { block: true });
    return empty;
  }

  journal.fix('encoding-repaired', 1, 'File encoding', encoding, 'utf-8', 'Transcoded the CSV to UTF-8 without a BOM.');
  const targetLineEnding = platform === 'shopify-products' ? 'lf' : 'crlf';
  if (records.length > 1 || lineEnding === 'mixed' || lineEnding === 'crlf') {
    journal.fix('line-ending-repaired', 1, 'Line endings', lineEnding, targetLineEnding, 'Standardized CSV record separators and preserved line endings inside quoted cells.');
  }
  for (const record of records) {
    if (record.parseError) {
      journal.issue('csv-parse-error', record.line, 'CSV row', record.raw, `${record.parseError}. Repair the record in the source file before exporting.`, { block: true });
    }
  }

  const source = platform === 'quickbooks-bank' ? stripBankStatement(records, journal) : records;
  const table = readTable(source, aliases[platform], journal, edits, {
    fixWindowsPunctuation: encoding === 'windows-1252',
    paddingColumns: platform === 'shopify-products' ? shopifyPaddingColumns : undefined,
  });

  let headers = table.headers;
  let exportPlatform = platform;
  let exportOptions = options;
  let feeConvention: FeeConvention | undefined;
  if (!source.find(({ line }) => line === table.headerLine)?.parseError) {
    if (platform === 'shopify-products') {
      repairShopify(table, journal);
    } else if (platform === 'quickbooks-bank') {
      const qbo = repairQuickBooks(table, journal, options);
      headers = qbo.headers;
      exportOptions = { ...options, dateOrder: qbo.dateOrder, qboCreditDebit: 'intuit' };
    } else {
      feeConvention = resolveFeeConvention(table.sourceHeaders, options.stripePayPalFeeConvention);
      headers = repairStripePayPal(table, journal, options, feeConvention);
      if (options.stripePayPalOutput === 'quickbooks-3col') {
        exportPlatform = 'quickbooks-bank';
        exportOptions = { qboLayout: '3col', dateOrder: options.dateOrder === 'DMY' ? 'DMY' : 'MDY' };
      } else {
        exportOptions = { ...options, stripePayPalFeeConvention: feeConvention };
      }
    }
  }

  const rows = table.rows.map(({ source: record, after }) => ({ row: record.line, before: record.cells, after }));
  return { headers, sourceHeaders: table.sourceHeaders, headerLine: table.headerLine, rows, encoding, lineEnding, journal, exportPlatform, exportOptions, feeConvention };
}

const reviewCodes = (journal: Journal): string[] => journal.issues.filter(({ autoFixed }) => !autoFixed).map(({ code }) => code).sort();
const byLine = (left: { row: number }, right: { row: number }) => left.row - right.row;
const sameCells = (before: readonly string[], after: readonly string[]): boolean =>
  before.length === after.length && before.every((value, index) => value === after[index]);

export function repairCsvWithBytes(
  bytes: Uint8Array, filename: string, platform: PlatformId, options: RepairOptions, edits: readonly ManualCellEdit[],
): { result: RepairResult; verifiedBytes: Uint8Array<ArrayBuffer> | null } {
  const pass = runPass(bytes, platform, options, edits, platform !== 'shopify-products');
  const { journal, sourceHeaders } = pass;
  let { headers, rows } = pass;
  const enabled = options.formulaGuard === true;
  const guardChanges: FormulaGuardCell[] = [];
  const roundtripCheck: RoundtripCheck = { checked: false, autoFixableRemaining: null, needsManualReviewCount: null };
  let repairedCsv = '';
  let verifiedBytes: Uint8Array<ArrayBuffer> | null = null;
  if (!journal.blocked) {
    const outgoingHeaders = enabled ? guardSpreadsheetRow(headers, headers, pass.headerLine, guardChanges) : headers;
    const outgoingRows = enabled ? rows.map(({ row, after }) => guardSpreadsheetRow(after, headers, row, guardChanges)) : rows.map(({ after }) => after);
    const value = serializeCsv(outgoingHeaders, outgoingRows, pass.exportPlatform);
    const outgoingBytes = new TextEncoder().encode(value);
    const output = runPass(outgoingBytes, pass.exportPlatform, pass.exportOptions, []);
    const pending = reviewCodes(output.journal);
    roundtripCheck.checked = true;
    roundtripCheck.autoFixableRemaining = output.journal.issues.length - pending.length;
    roundtripCheck.needsManualReviewCount = pending.length;
    const sameRecords = sameCells(outgoingHeaders, output.sourceHeaders) && outgoingRows.length === output.rows.length &&
      outgoingRows.every((record, index) => sameCells(record, output.rows[index].before));
    if (!sameRecords || output.journal.blocked || roundtripCheck.autoFixableRemaining !== 0 || !sameCells(reviewCodes(journal), pending)) {
      journal.issue('roundtrip-failed', 1, 'CSV file', '', 'The generated CSV did not pass re-parsing and validation. Review the audit before exporting.', { block: true });
    } else {
      repairedCsv = value;
      verifiedBytes = outgoingBytes;
      if (guardChanges.length) {
        headers = outgoingHeaders;
        rows = rows.map((row, index) => ({ ...row, after: outgoingRows[index] }));
      }
    }
  }

  const result: RepairResult = {
    filename,
    platform,
    detectedEncoding: pass.encoding,
    detectedLineEnding: pass.lineEnding,
    sourceHeaders,
    headers,
    rows,
    issues: journal.issues.sort(byLine),
    changes: journal.changes.sort(byLine),
    removedRows: journal.removedRows.sort(byLine),
    needsManualReviewCount: reviewCodes(journal).length,
    repairedCsv,
    canDownload: !journal.blocked,
    roundtripCheck,
    formulaGuard: { enabled, neutralized: repairedCsv ? guardChanges : [], blocked: repairedCsv ? [] : guardChanges },
    bookkeeperAmounts: journal.bookkeeperAmounts ?? [],
    ...(journal.currencySplit && { currencySplit: journal.currencySplit }),
    ...(pass.feeConvention && { stripePayPalFeeConvention: pass.feeConvention }),
  };
  return { result, verifiedBytes };
}

export function repairCsv(bytes: Uint8Array, filename: string, platform: PlatformId, options: RepairOptions = {}): RepairResult {
  return repairCsvWithBytes(bytes, filename, platform, options, []).result;
}

export function applyManualCellEdits(
  bytes: Uint8Array,
  filename: string,
  platform: PlatformId,
  options: RepairOptions,
  edits: readonly ManualCellEdit[],
): RepairResult {
  return repairCsvWithBytes(bytes, filename, platform, options, edits).result;
}
