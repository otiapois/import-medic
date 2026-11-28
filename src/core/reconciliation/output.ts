import { sha256 } from '../audit/custody';
import { brandSignoffHtml } from '../branding/signoff-brand';
import { parseCsv, serializeCsv } from '../csv';
import { guardSpreadsheetRow, type FormulaGuardCell } from '../formula-guard';
import { custodyFooter, escapeReportText as escape, offlineReportCsp } from '../report-html';
import { formatMinorUnits } from '../values';
import type { parseReconciliationSource } from './source';
import type { ReconciliationArtifact, ReconciliationInput, ReconciliationResult } from './types';

const filenames = {
  pairsCsv: 'payout-reconciled-pairs.csv',
  exceptionsCsv: 'payout-exceptions.csv',
  auditJson: 'payout-reconciliation-audit.json',
  signoffHtml: 'payout-reconciliation-sign-off.html',
} as const;
const pairHeaders = ['Payout ID', 'Payout Line', 'Bank Line', 'Payout Date', 'Bank Date', 'Currency', 'Amount Cents', 'Lag Days',
  'Bank Description', 'Bank Reference'];
const exceptionHeaders = ['Code', 'Payout Lines', 'Bank Lines', 'Currency', 'Payout Cents', 'Bank Cents', 'Delta Cents', 'Lag Days',
  'Column', 'Source Value', 'Expected Cents', 'Actual Cents', 'Candidate Sets', 'Message'];

type Outcome = Omit<ReconciliationResult, 'artifacts'>;
type Sources = Record<'payouts' | 'bank', ReturnType<typeof parseReconciliationSource>['evidence']>;
const utf8 = new TextEncoder();

const artifact = (key: keyof typeof filenames, text: string): ReconciliationArtifact =>
  ({ filename: filenames[key], bytes: utf8.encode(text) });
const fingerprint = async ({ filename, bytes }: ReconciliationInput['payouts']) =>
  ({ filename, byteLength: bytes.byteLength, sha256: await sha256(bytes) });

function verifiedCsv(headers: string[], source: string[][], neutralized: FormulaGuardCell[]): string {
  let line = 2;
  const guarded = source.map(row => {
    const cells = guardSpreadsheetRow(row, headers, line, neutralized);
    line += 1 + cells.reduce((count, cell) => count + (cell.match(/\r\n|\n|\r/g)?.length ?? 0), 0);
    return cells;
  });
  const csv = serializeCsv(headers, guarded, 'payout-reconciliation');
  const expected = [headers, ...guarded];
  const { records } = parseCsv(csv);
  if (records.length !== expected.length || records.some(({ cells, parseError }, index) =>
    parseError || cells.length !== headers.length || cells.some((cell, position) => cell !== expected[index][position]))) {
    throw new Error('A reconciliation CSV did not preserve the verified report values.');
  }
  return csv;
}

function htmlTable(label: string, headers: readonly string[], rows: readonly string[][]): string {
  return rows.length === 0 ? '<p>None.</p>' : `<div class="table-scroll" role="region" aria-label="${label}" tabindex="0"><table>
    <thead><tr>${headers.map(header => '<th scope="col">' + escape(header) + '</th>').join('')}</tr></thead>
    <tbody>${rows.map(row => '<tr>' + row.map(cell => '<td>' + escape(cell) + '</td>').join('') + '</tr>').join('')}</tbody></table></div>`;
}

function signoff(
  outcome: Outcome, maxLagDays: number, sourceValid: boolean, sources: Sources,
  files: Parameters<typeof custodyFooter>[0], branding?: ReconciliationInput['branding'],
) {
  const { status, summary, pairs, exceptions } = outcome;
  const money = (cents: string) => formatMinorUnits(BigInt(cents), 2);
  const totalRows = summary.byCurrency.map(row => [row.currency, money(row.totalPayoutCents), money(row.totalBankInflowCents),
    money(row.matchedPayoutCents), money(row.unmatchedPayoutCents), money(row.unmatchedBankCents),
    money(row.ambiguousPayoutCents), money(row.ambiguousBankCents)]);
  const pairRows = pairs.map(pair => [pair.payoutId, String(pair.payoutLine), String(pair.bankLine), pair.payoutDate,
    pair.bankDate, pair.currency, money(pair.amountCents), String(pair.lagDays), pair.bankDescription, pair.bankReference]);
  const exceptionRows = exceptions.map(item => [item.code, item.payoutLines.join(', '), item.bankLines.join(', '),
    item.currency ?? '', item.payoutCents ?? '', item.bankCents ?? '', item.deltaCents ?? '',
    [item.message, item.column && item.column + (item.value === undefined ? '' : ' = ' + item.value),
      item.expectedCents !== undefined && 'Expected ' + item.expectedCents + ' cents, supplied ' + item.actualCents + ' cents']
      .filter(Boolean).join(' ')]);
  const excludedBank = sources.bank.records.filter(row => row.disposition === 'excluded-non-inflow').length;
  const unpricedPayouts = sources.payouts.records.filter(row => row.disposition === 'excluded-unpriced').length;
  const unpricedBank = sources.bank.records.filter(row => row.disposition === 'excluded-unpriced').length;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${offlineReportCsp}">
<title>Month-End Payout Reconciliation Sign-Off</title><style>
*{box-sizing:border-box}body{margin:0;padding:1rem;color:#152b1f;background:#fff;font:1rem/1.45 system-ui,sans-serif}
main{max-width:70rem;margin:auto;min-width:0}h1,h2{line-height:1.2}h1{font-size:clamp(1.55rem,4vw,2.3rem);margin:.5rem 0}
h2{font-size:1.25rem;margin:1.75rem 0 .6rem}p{margin:.6rem 0}.status{font-weight:700;color:#235338}.hold{color:#833418}
.table-scroll{max-width:100%;overflow:auto;border:1px solid #91a39a;border-radius:.25rem}
.table-scroll:focus-visible{outline:2px solid #1a4930;outline-offset:2px}
table{width:100%;border-collapse:collapse;text-align:left;font-variant-numeric:tabular-nums}th,td{padding:.42rem .58rem;border-bottom:1px solid #c3cbc7}
th{background:#ebf1ed;white-space:nowrap}td{vertical-align:top;white-space:pre-wrap;overflow-wrap:break-word}td:first-child{min-width:7ch}
.amounts td{white-space:nowrap}.evidence td:last-child{min-width:22ch;overflow-wrap:anywhere}
footer code{overflow-wrap:anywhere}dd{margin:0 0 .45rem}code{font-family:ui-monospace,monospace}
@media print{body{padding:0;font-size:9pt}.table-scroll{overflow:visible}table{table-layout:fixed}th,td{white-space:pre-wrap;overflow-wrap:anywhere}
.amounts td{white-space:pre-wrap}.evidence td:last-child{min-width:0}thead{display:table-header-group}tr{break-inside:avoid}}
</style></head><body><main><h1>Month-End Payout Reconciliation Sign-Off</h1>
<p class="status ${status === 'HOLD' ? 'hold' : ''}">${status === 'READY' ? 'READY · All eligible payouts and bank inflows reconciled' : 'HOLD · Review exceptions before signing off'}</p>
<p>${summary.matchedPairs} matched pairs · ${summary.unmatchedPayouts} unmatched payouts · ${summary.unmatchedBankDeposits} unmatched bank deposits · ${summary.ambiguousGroups} ambiguous groups · ${summary.exceptionCount} exceptions</p>
<p>The settlement window spans 0–${maxLagDays} calendar days from payout date through bank date.</p>
${sourceValid ? '' : '<p>Source evidence requires review. Exact and near matching was held for this run.</p>'}
<p>Totals cover supplied payout rows with exact cents and a confirmed currency, and bank inflows above zero. The audit retains ${excludedBank} non-inflow bank rows and ${unpricedPayouts} payout / ${unpricedBank} bank rows outside the exact-currency totals.</p>
<section class="amounts"><h2>Currency totals</h2>${htmlTable('Currency totals',
  ['Currency', 'Payout total', 'Bank inflow', 'Reconciled', 'Unmatched payout', 'Unmatched bank', 'Ambiguous payout', 'Ambiguous bank'], totalRows)}</section>
<section class="evidence"><h2>Reconciled pairs</h2>${htmlTable('Reconciled pairs',
  ['Payout ID', 'Payout line', 'Bank line', 'Payout date', 'Bank date', 'Currency', 'Amount', 'Lag days', 'Bank description', 'Bank reference'], pairRows)}</section>
<section class="evidence"><h2>Reconciliation exceptions</h2>${htmlTable('Reconciliation exceptions',
  ['Code', 'Payout lines', 'Bank lines', 'Currency', 'Payout cents', 'Bank cents', 'Delta cents', 'Review details'], exceptionRows)}</section>
${custodyFooter(files)}</main></body></html>`;
  return brandSignoffHtml(html, branding);
}

export async function writeReconciliationArtifacts(input: ReconciliationInput, maxLagDays: number, sourceValid: boolean,
  sources: Sources, outcome: Outcome): Promise<ReconciliationResult['artifacts']> {
  const pairRows = outcome.pairs.map(pair => [pair.payoutId, String(pair.payoutLine), String(pair.bankLine), pair.payoutDate,
    pair.bankDate, pair.currency, pair.amountCents, String(pair.lagDays), pair.bankDescription, pair.bankReference]);
  const exceptionRows = outcome.exceptions.map(item => [item.code, item.payoutLines.join(', '), item.bankLines.join(', '),
    item.currency ?? '', item.payoutCents ?? '', item.bankCents ?? '', item.deltaCents ?? '', item.lagDays?.toString() ?? '',
    item.column ?? '', item.value ?? '', item.expectedCents ?? '', item.actualCents ?? '',
    item.candidateSets ? JSON.stringify(item.candidateSets) : '', item.message]);
  const formulaGuard = { pairsCsv: [] as FormulaGuardCell[], exceptionsCsv: [] as FormulaGuardCell[] };
  const pairsCsv = artifact('pairsCsv', verifiedCsv(pairHeaders, pairRows, formulaGuard.pairsCsv));
  const exceptionsCsv = artifact('exceptionsCsv', verifiedCsv(exceptionHeaders, exceptionRows, formulaGuard.exceptionsCsv));
  const [payouts, bank, pairs, exceptions] = await Promise.all([
    fingerprint(input.payouts), fingerprint(input.bank), fingerprint(pairsCsv), fingerprint(exceptionsCsv),
  ]);
  const signoffHtml = artifact('signoffHtml', signoff(outcome, maxLagDays, sourceValid, sources, [
    ['Payout CSV — ' + payouts.filename, payouts.sha256], ['Bank CSV — ' + bank.filename, bank.sha256],
    [pairs.filename, pairs.sha256], [exceptions.filename, exceptions.sha256],
  ], input.branding));
  const audit = { schemaVersion: 1, ...outcome,
    settings: { minLagDays: 0, maxLagDays, lagUnit: 'calendar-days', nearMaxAbsoluteCents: '2500', nearMaxPercent: '2' },
    sourceValid, totalsScope: {
      payouts: 'Supplied rows with exact signed payout cents and a confirmed currency, including source-held rows.',
      bank: 'Supplied positive inflows with exact cents and a confirmed currency.',
      excluded: 'Rows without verifiable cents or currency and non-inflow bank rows remain in source evidence outside these totals.',
    },
    sources, formulaGuard,
    custody: { inputs: { payouts, bank }, outputs: { pairsCsv: pairs, exceptionsCsv: exceptions, signoffHtml: await fingerprint(signoffHtml) } },
  };
  const auditJson = artifact('auditJson', JSON.stringify(audit, null, 2) + '\n');
  return { pairsCsv, exceptionsCsv, auditJson, signoffHtml };
}
