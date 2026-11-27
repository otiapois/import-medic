import type { RepairCustody } from '../audit/custody';
import { custodyFooter, escapeReportText as escape, offlineReportCsp } from '../report-html';
import type { BalanceChain, BookkeeperAmountRow, RepairOptions, RepairResult } from '../types';

const rowLimit = 500;
const detailLimit = 30;
const valueLimit = 240;
const isoCurrencies = new Set(Intl.supportedValuesOf('currency'));
const currencyFields = ['amount', 'gross', 'fee', 'net'] as const;
type MoneyField = typeof currencyFields[number];
type Total = { units: bigint; scale: number; count: number };

interface ReportContext {
  generatedAt: Date;
  detectedProvider?: string;
  options?: RepairOptions;
  custody?: RepairCustody;
}

function currencyGroup(rows: readonly BookkeeperAmountRow[]) {
  const groups = new Map<string, { count: number; totals: Map<MoneyField, Total> }>();
  let included = 0;
  for (const { currency, amounts } of rows) {
    if (currency === null || !isoCurrencies.has(currency)) continue;
    const group = groups.get(currency) ?? { count: 0, totals: new Map<MoneyField, Total>() };
    let hasAmount = false;
    for (const field of currencyFields) {
      const amount = amounts[field];
      if (amount === undefined) continue;
      const [whole, fraction = ''] = amount.split('.');
      const units = BigInt(whole + fraction);
      const previous = group.totals.get(field) ?? { units: 0n, scale: 2, count: 0 };
      const scale = Math.max(fraction.length, previous.scale);
      group.totals.set(field, {
        units: previous.units * 10n ** BigInt(scale - previous.scale) + units * 10n ** BigInt(scale - fraction.length),
        scale, count: previous.count + 1,
      });
      hasAmount = true;
    }
    if (hasAmount) {
      group.count++;
      groups.set(currency, group);
      included++;
    }
  }
  return { groups, included };
}

function decimal({ units, scale }: Total): string {
  const magnitude = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  return (units < 0n ? '-' : '') + magnitude.slice(0, -scale) + '.' + magnitude.slice(-scale);
}

const boundedText = (text: string) => escape(text.length > valueLimit ? text.slice(0, valueLimit) + '…' : text);

function changesByLine(result: RepairResult) {
  const sourceRows = new Set(result.rows.map(({ row }) => row));
  const excluded = new Set(result.removedRows.map(({ row }) => row));
  const flagged = new Set(result.issues.flatMap(({ row, autoFixed }) => autoFixed ? [] : [row]));
  const protectedCells = [...result.formulaGuard.neutralized, ...result.formulaGuard.blocked];
  const affected = new Set([...flagged, ...excluded, ...result.changes.map(({ row }) => row), ...protectedCells.map(({ row }) => row)]);
  const lines = new Map([...affected].sort((left, right) => left - right).slice(0, rowLimit)
    .map((line) => [line, { details: [] as string[], count: 0 }]));
  const fixed = new Set<string>();
  const edited = new Set<string>();
  function add(row: number, detail: () => string) {
    const entry = lines.get(row);
    if (!entry) return;
    if (entry.count < detailLimit) entry.details.push(detail());
    entry.count++;
  }
  for (const { row, reconciliation } of result.issues) {
    if (!reconciliation) continue;
    const { gross, fee, net, expectedNet, feeConvention } = reconciliation;
    const operation = feeConvention === 'deduction' ? 'Gross − Fee' : 'Gross + Fee';
    add(row, () => `<strong>Flagged · Reconciliation mismatch</strong><br>Gross <code>${escape(gross)}</code> · Fee <code>${escape(fee)}</code> · Net <code>${escape(net)}</code><br>Expected Net from ${operation} <code>${escape(expectedNet)}</code>`);
  }
  for (const { row, column, code, before, after } of result.changes) {
    const cell = `${row}:${column}`;
    const kind = code === 'manual-edit' ? 'Manual edit' :
      code === 'layout-converted' || code === 'column-removed' ? 'Projection' : sourceRows.has(row) || excluded.has(row) ? 'Auto-fix' : 'Format';
    if (kind === 'Manual edit') edited.add(cell);
    if (kind === 'Auto-fix') fixed.add(cell);
    add(row, () => `<strong>${kind}</strong> · ${boundedText(column)} · ${boundedText(before)} → ${boundedText(after)}`);
  }
  for (const { row, column, message, rawValue, autoFixed, reconciliation } of result.issues) {
    if (autoFixed || reconciliation) continue;
    add(row, () => `<strong>Flagged</strong> · ${boundedText(column)} · ${boundedText(message)}${rawValue ? ` · ${boundedText(rawValue)}` : ''}`);
  }
  for (const { row, reason, rawPreview } of result.removedRows) {
    add(row, () => `<strong>Excluded</strong> · ${boundedText(reason)} · ${boundedText(rawPreview)}`);
  }
  for (const [index, { row, column, before, after }] of protectedCells.entries()) {
    const kind = index < result.formulaGuard.neutralized.length ? 'Spreadsheet protection' : 'Blocked spreadsheet protection';
    add(row, () => `<strong>${kind}</strong> · ${boundedText(column)} · ${boundedText(before)} → ${boundedText(after)}`);
  }
  return { lines, affectedCount: affected.size, fixedCount: fixed.size, editedCount: edited.size, flaggedCount: flagged.size, excludedCount: excluded.size };
}

function renderBalanceChain(chain: BalanceChain): string {
  const { status, direction, currency, openingBalance, netMovement, closingBalance, verifiedLinks, totalLinks, breaks, reasons } = chain;
  const headline = status === 'VERIFIED' ? `VERIFIED (${verifiedLinks}/${totalLinks} links)` :
    status === 'FAIL_BALANCE_BREAK' ? `BALANCE BREAK at Line ${breaks[0].row}` : 'UNVERIFIABLE';
  const balances = [
    ['Opening Balance', openingBalance], ['Net Movement', netMovement], ['Closing Balance', closingBalance],
  ] as const;
  return `<section><h2>Running-Balance Chain Audit</h2>
<p><strong class="${status === 'VERIFIED' ? 'chain-verified' : 'chain-held'}">${headline}</strong></p>
<dl class="summary">${balances.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value ?? 'Unavailable')}</dd></div>`).join('')}</dl>
<p class="meta">Currency ${escape(currency ?? 'unspecified')} · Order ${escape(direction ?? 'undetermined')} · Verified Chain Links ${verifiedLinks}/${totalLinks}</p>
${status === 'VERIFIED' && totalLinks === 0 ? '<p class="meta">The single transaction has no consecutive links to check.</p>' : ''}
${breaks.length ? `<table><thead><tr><th scope="col">Line</th><th scope="col">Expected Balance</th><th scope="col">Actual Balance</th><th scope="col">Discrepancy</th></tr></thead><tbody>
${breaks.slice(0, rowLimit).map(({ row, expected, actual, delta }) => `<tr><th scope="row">${row}</th><td>${escape(expected)}</td><td>${escape(actual)}</td><td>${escape(delta.startsWith('-') ? delta : '+' + delta)}</td></tr>`).join('')}
</tbody></table>${breaks.length > rowLimit ? `<p>Showing ${rowLimit} of ${breaks.length} breaks. Download the full repair audit for every break.</p>` : ''}` : ''}
${reasons.length ? `<ul>${reasons.slice(0, rowLimit).map(({ row, column, message }) => `<li>Line ${row} · ${boundedText(column)} · ${boundedText(message)}</li>`).join('')}</ul>
${reasons.length > rowLimit ? `<p>Showing ${rowLimit} of ${reasons.length} reasons. Download the full repair audit for every reason.</p>` : ''}` : ''}
</section>`;
}

export function createBookkeeperSignoffHtml(result: RepairResult, { generatedAt, detectedProvider, options, custody }: ReportContext): string {
  const fourColumn = options ? options.qboLayout === '4col' : result.headers.includes('Credit');
  const target = result.platform === 'shopify-products' ? 'Shopify products' :
    result.platform === 'quickbooks-bank' ? `QuickBooks bank (${fourColumn ? '4-column' : '3-column'} target)` :
    result.platform === 'xero-bank' ? 'Xero bank statement' :
    result.platform === 'freshbooks-expenses' ? 'FreshBooks expenses' : 'Stripe / PayPal transactions';
  const { lines, affectedCount, fixedCount, editedCount, flaggedCount, excludedCount } = changesByLine(result);
  const { groups, included } = currencyGroup(result.bookkeeperAmounts);
  const moneyFields = result.platform === 'stripe-paypal' ? ['gross', 'fee', 'net'] as const : ['amount'] as const;
  const currencyRows = [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([currency, { count, totals }]) => `<tr><th scope="row">${escape(currency)}</th><td>${count}</td>${moneyFields.map((field) => {
    const total = totals.get(field);
    return total ? `<td>${decimal(total)} <small>${total.count} ${total.count === 1 ? 'value' : 'values'}</small></td>` : '<td>—</td>';
  }).join('')}</tr>`).join('\n');
  const metrics = [
    ['Total rows', result.rows.length + excludedCount], ['Auto-fixed cells', fixedCount],
    ['Manually edited cells', editedCount], ['Blocked / flagged lines', flaggedCount], ['Excluded memo / non-transaction rows', excludedCount],
  ] as const;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${offlineReportCsp}">
<title>Bookkeeper Sign-Off</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:clamp(12px,4vw,34px);font:14px/1.5 system-ui,sans-serif;color:#183134;background:#fff}main{max-width:960px;margin:auto;overflow-wrap:anywhere}
h1{font-size:clamp(22px,4vw,34px);line-height:1.15}h2{font-size:18px;margin-top:1.5em}.meta{color:#435a5b}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,9rem),1fr));gap:8px}
.summary div{padding:8px;border:1px solid #b7cac6;border-radius:6px;background:#f1f7f5}dt,th{font-weight:700}dd{margin:0;font-variant-numeric:tabular-nums}table{width:100%;table-layout:fixed;border-collapse:collapse}
th,td{padding:6px;border:1px solid #b7cac6;text-align:left;vertical-align:top}th{background:#eaf3f1}.lines th:first-child{width:4rem}small{display:block;color:#435a5b}ul{padding-left:1.2rem;margin:0}
.chain-verified{color:#236048}.chain-held{color:#8e2624}
@media print{body{padding:0;font-size:11pt}.summary div,th{background:#fff}tr,.summary div{break-inside:avoid}thead{display:table-header-group}}
</style></head><body><main>
<h1>Bookkeeper Sign-Off</h1>
<p><strong>Source file</strong> ${boundedText(result.filename)}<br><strong>Confirmed platform</strong> ${escape(target)}<br><strong>Detected source</strong> ${escape(detectedProvider ?? 'Unspecified')}<br>
${result.platform === 'stripe-paypal' && options?.stripePayPalOutput === 'quickbooks-3col' ? '<strong>Output layout</strong> QuickBooks 3-column bank CSV<br>' : ''}
<strong>Generated locally</strong> <time datetime="${generatedAt.toISOString()}">${escape(generatedAt.toLocaleString())}</time></p>
<p><strong>Repaired CSV</strong> ${result.canDownload ? 'Available' : 'Blocked'}</p>
<dl class="summary">${metrics.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>
<p class="meta">Total rows include retained and excluded CSV records, after omitting the header record. Cell counts use distinct source cells. Layout, header, encoding and line-ending notices appear in the audit where applicable.</p>
${result.balanceChain ? renderBalanceChain(result.balanceChain) : ''}
<h2>Totals by currency</h2>
${currencyRows ? `<table><thead><tr><th scope="col">Currency</th><th scope="col">Lines</th>${moneyFields.map((field) => `<th scope="col">${field[0].toUpperCase() + field.slice(1)}</th>`).join('')}</tr></thead><tbody>${currencyRows}</tbody></table>` : '<p>No monetary totals are available.</p>'}
${result.platform === 'shopify-products' ? '<p class="meta">The product repair supplies no transaction amounts or currency totals.</p>' : `<p class="meta">Totals use validated source amounts under their explicit currency, before any export removes the source currency column. ${result.rows.length - included} retained ${result.rows.length - included === 1 ? 'line has' : 'lines have'} no reportable amount. A dash means that amount is unavailable for the currency.</p>`}
<h2>Source line audit</h2>
${affectedCount > rowLimit ? `<p>Showing ${rowLimit} of ${affectedCount} source lines. Download the full repair audit for the remaining ${affectedCount - rowLimit}.</p>` : ''}
${lines.size ? `<table class="lines"><thead><tr><th scope="col">Line</th><th scope="col">Repair and review</th></tr></thead><tbody>${[...lines].map(([row, { details, count }]) => `<tr><th scope="row">${row}</th><td><ul>${details.map((detail) => `<li>${detail}</li>`).join('')}${count > detailLimit ? `<li>${count - detailLimit} more entries in the full repair audit.</li>` : ''}</ul></td></tr>`).join('\n')}</tbody></table>` : '<p>There are no fixed, edited, flagged or excluded source lines to show.</p>'}
${result.currencySplit ? `<section><h2>Currency split required</h2><p>Use a separate bank CSV for each currency.</p>
<table><thead><tr><th scope="col">Currency</th><th scope="col">Lines</th><th scope="col">Physical source lines</th></tr></thead><tbody>
${result.currencySplit.map(({ currency, lines }) => `<tr><th scope="row">${escape(currency)}</th><td>${lines.length}</td><td>${lines.join(', ')}</td></tr>`).join('\n')}
</tbody></table></section>` : ''}
${result.freshBooksTaxes ? `<section><h2>FreshBooks tax review</h2><p>Source tax fields are recorded here for review. Confirm or add taxes in FreshBooks after the expense import.</p>
<table><thead><tr><th scope="col">Line</th><th scope="col">Tax 1 Name</th><th scope="col">Tax 1 Amount</th></tr></thead><tbody>
${result.freshBooksTaxes.slice(0, rowLimit).map(({ row, name, amount }) => `<tr><th scope="row">${row}</th><td>${boundedText(name)}</td><td>${boundedText(amount)}</td></tr>`).join('')}
</tbody></table>${result.freshBooksTaxes.length > rowLimit ? `<p>Showing ${rowLimit} of ${result.freshBooksTaxes.length} lines. Download the full repair audit for every line.</p>` : ''}</section>` : ''}
${custody ? custodyFooter([['Source CSV', custody.sourceSha256], ['Repaired CSV', result.canDownload ? custody.repairedCsvSha256 : undefined]]) : ''}
</main></body></html>
`;
}
