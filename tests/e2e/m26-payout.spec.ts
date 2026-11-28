import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Papa from 'papaparse';
import { assertFits, test } from './browser';
import { auditPage } from './m10-accessibility';

const fixture = (name: string) => resolve('fixtures/m26', name);
const status = (page: Page) => page.getByTestId('payout-reconciliation-status');
const bank = (page: Page) => page.getByLabel('Choose Bank Statement CSV', { exact: true });
const payouts = (page: Page) => page.getByLabel('Choose Platform Payout CSV', { exact: true });
const matched = (page: Page) => page.getByRole('table', { name: 'Matched pairs', exact: true });
const queue = (page: Page) => page.getByRole('table', { name: 'Reconciliation exceptions', exact: true });
const lag = (page: Page) => page.getByRole('combobox', { name: 'Settlement lag window (days)', exact: true });
const input = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
const receipt = (filename: string, bytes: Buffer) => ({
  filename, byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'),
});

async function openWorkbench(page: Page, begin: () => void) {
  await page.goto('/', { waitUntil: 'networkidle' });
  const group = page.getByRole('region', { name: 'Accounting Workbench', exact: true })
    .getByRole('group', { name: 'Accounting workflow', exact: true });
  await expect(group.getByRole('button', { name: 'Single-File Bank Repair', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const reconciler = group.getByRole('button', { name: 'Payout vs Bank Reconciler', exact: true });
  await reconciler.focus();
  await reconciler.press('Enter');
  await expect(reconciler).toHaveAttribute('aria-pressed', 'true');
  await expect(status(page)).toHaveAttribute('data-state', 'waiting');
  await expect(lag(page)).toHaveValue('5');
  await page.waitForLoadState('networkidle');
  begin();
}

async function download(page: Page, info: TestInfo, stage: string, label: string, filename: string) {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: label, exact: true }).click()]);
  expect(file.suggestedFilename()).toBe(filename);
  const root = process.env.IMPORT_MEDIC_M26_DOWNLOADS;
  const path = root ? resolve(root, info.project.name, stage, filename) : info.outputPath(stage, filename);
  await mkdir(dirname(path), { recursive: true });
  await file.saveAs(path);
  expect(await file.failure()).toBeNull();
  const bytes = await readFile(path);
  return { bytes, path, fingerprint: receipt(filename, bytes) };
}

function parseCsv(bytes: Buffer) {
  const parsed = Papa.parse<Record<string, string>>(new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    { delimiter: ',', header: true, skipEmptyLines: true });
  expect(parsed.errors).toEqual([]);
  return parsed.data;
}

async function files(page: Page, info: TestInfo, stage: string, payoutFile: ReturnType<typeof input>, bankFile: ReturnType<typeof input>) {
  const pairs = await download(page, info, stage, 'Download Reconciled Pairs CSV', 'payout-reconciled-pairs.csv');
  const except = await download(page, info, stage, 'Download Exceptions CSV', 'payout-exceptions.csv');
  const report = await download(page, info, stage, 'Download Branded Month-End Sign-Off (.html)', 'payout-reconciliation-sign-off.html');
  const json = await download(page, info, stage, 'Download Audit JSON', 'payout-reconciliation-audit.json');
  const audit = JSON.parse(json.bytes.toString('utf8'));
  expect(audit.custody.inputs).toEqual({ payouts: receipt(payoutFile.name, payoutFile.buffer), bank: receipt(bankFile.name, bankFile.buffer) });
  expect(audit.custody.outputs).toEqual({ pairsCsv: pairs.fingerprint, exceptionsCsv: except.fingerprint, signoffHtml: report.fingerprint });
  for (const row of audit.summary.byCurrency) {
    expect(BigInt(row.matchedPayoutCents)).toBe(BigInt(row.matchedBankCents));
    expect(BigInt(row.totalPayoutCents)).toBe(BigInt(row.matchedPayoutCents) + BigInt(row.unmatchedPayoutCents) + BigInt(row.ambiguousPayoutCents));
    expect(BigInt(row.totalBankInflowCents)).toBe(BigInt(row.matchedBankCents) + BigInt(row.unmatchedBankCents) + BigInt(row.ambiguousBankCents));
  }
  const csv = parseCsv(pairs.bytes), exceptions = parseCsv(except.bytes);
  expect(csv).toHaveLength(audit.summary.matchedPairs);
  expect(exceptions).toHaveLength(audit.summary.exceptionCount);
  return { audit, csv, exceptions, report };
}

async function scrollPanel(panel: Locator, page: Page) {
  await panel.focus();
  await expect(panel).toBeFocused();
  await panel.evaluate(el => { el.scrollLeft = 0; });
  const available = await panel.evaluate(el => el.scrollWidth - el.clientWidth);
  expect(available).toBeGreaterThan(0);
  await panel.press('ArrowRight');
  await expect.poll(() => panel.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
  await assertFits(page);
}

async function screenshot(page: Page, anchor: Locator, name: string) {
  if (process.env.IMPORT_MEDIC_CAPTURE_M26_SCREENSHOTS !== '1') return;
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await anchor.evaluate(el => window.scrollBy({ top: el.getBoundingClientRect().top - 16, behavior: 'instant' }));
  const path = resolve('docs/reports/screenshots/m26', name + '.png');
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, animations: 'disabled' });
}

test('Month-end demo and real uploads reconcile exact currency ledgers and open a branded sign-off offline', async ({ page, beginProcessing }, info) => {
  await openWorkbench(page, beginProcessing);
  await page.getByRole('button', { name: 'Load Synthetic Month-End Shopify Payout vs Bank Demo', exact: true }).click();
  await expect(status(page)).toHaveAttribute('data-state', 'ready');
  const rows = matched(page).locator('tbody tr');
  for (const [i, [id, currency, money, days]] of [
    ['po-0001', 'USD', '125.40', '2 days'], ['po-0002', 'USD', '82.15', '1 day'], ['po-0003', 'EUR', '210.00', '4 days'],
  ].entries()) {
    await expect(rows.nth(i).getByRole('rowheader')).toContainText(id);
    await expect(rows.nth(i).getByRole('cell').nth(1)).toHaveText(currency + ' ' + money);
    await expect(rows.nth(i).getByRole('cell').last()).toHaveText(days);
  }
  await expect(queue(page)).toContainText('No exceptions');
  expect((await page.locator('.payout-reconciled-amounts li').allTextContents()).sort()).toEqual(['EUR 210.00', 'USD 207.55']);
  const access = await auditPage(page, 'workbench');
  await screenshot(page, page.getByRole('heading', { name: 'Review reconciliation' }), info.project.name + '-m26-payout-reconciler');
  const brand = 'Harbor <payout-note> & Co.';
  await page.locator('.signoff-branding summary').click();
  await page.getByLabel('Agency name', { exact: true }).fill(brand);
  await page.getByLabel('Prepared for', { exact: true }).fill('Northstar Supply');
  await page.locator('.signoff-branding summary').click();
  const p = input('Harbor payouts.csv', '\uFEFF' + 'Payout ID,Payout Date,Net Payout Amount,Currency\r\n=1+1,2026-11-01,125.40,USD\r\nEUR-210,2026-11-01,210.00,EUR\r\n');
  const b = input('November bank.csv', 'Bank Date,Description,Amount,Currency,Reference\r\n2026-11-03,"Northstar, Inc.\r\nHarbor",125.40,USD,@batch\r\n2026-11-01,Euro deposit,210.00,EUR,BR-04\r\n');
  await payouts(page).setInputFiles(p);
  await bank(page).setInputFiles(b);
  await expect(status(page)).toHaveAttribute('data-state', 'ready');
  await expect(matched(page).getByRole('rowheader').first()).toContainText('=1+1');
  const { audit, csv, exceptions, report } = await files(page, info, 'branded', p, b);
  expect(exceptions).toEqual([]);
  expect(csv.map(r => [r['Payout ID'], r['Payout Line'], r['Bank Line'], r.Currency, r['Amount Cents'], r['Lag Days'], r['Bank Reference']])).toEqual([
    ["'=1+1", '2', '2', 'USD', '12540', '2', "'@batch"], ['EUR-210', '3', '4', 'EUR', '21000', '0', 'BR-04'],
  ]);
  expect(csv[0]['Bank Description']).toMatch(/^Northstar, Inc\.\r?\nHarbor$/);
  expect(audit.pairs[0]).toMatchObject({ payoutId: '=1+1', bankReference: '@batch' });
  await page.context().setOffline(true);
  const offline = await page.context().newPage(), requests: string[] = [];
  offline.on('request', request => requests.push(request.url()));
  const url = pathToFileURL(report.path).href;
  await offline.goto(url);
  expect(offline.url()).toBe(url);
  const branding = offline.getByRole('complementary', { name: 'Agency branding', exact: true });
  await expect(branding).toContainText(brand);
  await expect(branding).toContainText('Northstar Supply');
  await expect(offline.getByRole('heading', { name: 'Month-End Payout Reconciliation Sign-Off', exact: true })).toBeVisible();
  const ledger = offline.getByRole('region', { name: 'Reconciled pairs', exact: true });
  await expect(ledger.getByRole('cell', { name: '=1+1', exact: true })).toBeVisible();
  await expect(ledger.getByRole('cell', { name: '@batch', exact: true })).toBeVisible();
  await expect(offline.locator('script,[src],[srcset],[href],[action],[formaction],[poster],base,form,iframe,embed,object,payout-note')).toHaveCount(0);
  expect(await offline.locator('*').evaluateAll(elements => elements.flatMap(el => el.getAttributeNames().filter(n => /^on/i.test(n))))).toEqual([]);
  await expect(offline.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content',
    "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  const footer = await offline.locator('footer').innerText();
  for (const fingerprint of [audit.custody.inputs.payouts, audit.custody.inputs.bank, audit.custody.outputs.pairsCsv, audit.custody.outputs.exceptionsCsv]) expect(footer).toContain(fingerprint.sha256);
  await assertFits(offline);
  if (info.project.name === 'mobile') await scrollPanel(ledger, offline);
  else await screenshot(offline, branding, 'desktop-m26-payout-signoff');
  expect(requests).toEqual([url]);
  info.annotations.push({ type: 'm26-offline', description: JSON.stringify({ access, viewport: page.viewportSize(), version: page.context().browser()?.version(), requests, custody: audit.custody }) });
  await offline.close();
});

test('Exception review keeps every competing physical line and both sides of a one-cent discrepancy', async ({ page, beginProcessing }, info) => {
  await openWorkbench(page, beginProcessing);
  const p = input('shopify-payouts.csv', await readFile(fixture('shopify-payouts.csv'), 'utf8'));
  await payouts(page).setInputFiles(fixture(p.name));
  for (const [stage, code, payoutLines, bankLines, delta] of [
    ['ambiguous', 'AMBIGUOUS_TIE', '2', '2, 5', ''],
    ['fee', 'UNMATCHED_NEAR_AMOUNT', '2', '2', '-1'],
    ['missing', 'UNMATCHED_PAYOUT', '2', '', ''],
  ]) {
    const name = 'bank-' + stage + '.csv', b = input(name, await readFile(fixture(name), 'utf8'));
    await bank(page).setInputFiles(fixture(name));
    await expect(status(page)).toHaveAttribute('data-state', 'hold');
    const row = queue(page).locator('tr[data-exception-code="' + code + '"]');
    await expect(row.getByRole('cell').nth(0)).toHaveText(payoutLines);
    await expect(row.getByRole('cell').nth(1)).toHaveText(bankLines || '—');
    if (delta) await expect(row.getByRole('cell').last()).toHaveText('USD -0.01');
    const { audit, csv, exceptions } = await files(page, info, stage, p, b);
    expect(csv.map(r => [r['Payout ID'], r['Payout Line'], r['Bank Line'], r['Amount Cents']])).toEqual([
      ['po-0002', '3', stage === 'missing' ? '2' : '3', '8215'], ['po-0003', '4', stage === 'missing' ? '3' : '4', '21000'],
    ]);
    expect(exceptions.find(r => r.Code === code)).toMatchObject({ 'Payout Lines': payoutLines, 'Bank Lines': bankLines, 'Delta Cents': delta });
    const usd = audit.summary.byCurrency.find((r: { currency: string }) => r.currency === 'USD');
    expect(usd).toMatchObject({ totalPayoutCents: '20755', matchedPayoutCents: '8215',
      unmatchedPayoutCents: stage === 'ambiguous' ? '0' : '12540', ambiguousPayoutCents: stage === 'ambiguous' ? '12540' : '0',
      totalBankInflowCents: stage === 'ambiguous' ? '33295' : stage === 'fee' ? '20754' : '8215',
      unmatchedBankCents: stage === 'fee' ? '12539' : '0', ambiguousBankCents: stage === 'ambiguous' ? '25080' : '0' });
    expect(audit.exceptions.map((r: { code: string }) => r.code).sort()).toEqual(stage === 'fee'
      ? ['UNMATCHED_BANK_DEPOSIT', 'UNMATCHED_NEAR_AMOUNT', 'UNMATCHED_PAYOUT'] : [code]);
  }
  if (info.project.name === 'mobile') await scrollPanel(page.getByRole('region', { name: 'Scrollable reconciliation exceptions' }), page);
  const clear = page.getByRole('button', { name: 'Clear Bank Statement CSV', exact: true });
  await clear.focus();
  await clear.press('Enter');
  await expect(bank(page)).toBeFocused();
  await expect(status(page)).toHaveAttribute('data-state', 'waiting');
  await expect(page.getByRole('button', { name: 'Download Reconciled Pairs CSV', exact: true })).toHaveCount(0);
});

test('Settlement boundaries isolate currencies and a connected many-to-many tie retains multiline source positions', async ({ page, beginProcessing }, info) => {
  await openWorkbench(page, beginProcessing);
  const p = input('boundary-payouts.csv', 'Payout ID,Payout Date,Net,Currency\nzero,2026-11-01,1.00,USD\nten,2026-11-01,100.00,USD\nwrong-currency,2026-11-01,500.00,EUR\nbefore,2026-11-01,800.00,USD\neleven,2026-11-01,900.00,USD\n');
  const b = input('boundary-bank.csv', 'Date,Description,Amount,Currency\n2026-11-01,Same day,1.00,USD\n2026-11-11,Inclusive ten,100.00,USD\n2026-11-01,USD only,500.00,USD\n2026-10-31,Before posting,800.00,USD\n2026-11-12,Eleven days,900.00,USD\n');
  await payouts(page).setInputFiles(p);
  await bank(page).setInputFiles(b);
  await lag(page).selectOption('0');
  await expect(matched(page).locator('tbody th')).toHaveCount(1);
  for (const days of ['0', '10']) {
    await lag(page).selectOption(days);
    await expect(matched(page).locator('tbody th')).toHaveCount(days === '0' ? 1 : 2);
    const { csv, audit, exceptions } = await files(page, info, 'lag-' + days, p, b);
    expect(audit.settings.maxLagDays).toBe(Number(days));
    expect(csv.map(r => [r['Payout ID'], r['Bank Line'], r['Lag Days']])).toEqual(days === '0' ? [['zero', '2', '0']] : [['zero', '2', '0'], ['ten', '3', '10']]);
    expect(exceptions.filter(r => r.Code === 'UNMATCHED_PAYOUT').map(r => r['Payout Lines']).sort()).toEqual(days === '0' ? ['3', '4', '5', '6'] : ['4', '5', '6']);
    expect(exceptions.filter(r => r.Code === 'UNMATCHED_BANK_DEPOSIT').map(r => r['Bank Lines']).sort()).toEqual(days === '0' ? ['3', '4', '5', '6'] : ['4', '5', '6']);
    expect(exceptions.some(r => r.Code === 'UNMATCHED_NEAR_AMOUNT')).toBe(false);
  }
  const ties = input('group-payouts.csv', 'Payout ID,Payout Date,Net,Currency\n"Payout\none",2026-11-01,2.00,USD\nsecond,2026-11-04,2.00,USD\n');
  const deposits = input('group-bank.csv', 'Date,Description,Amount,Currency\n2026-11-03,"Memo\none",2.00,USD\n2026-11-04,Memo two,2.00,USD\n');
  await lag(page).selectOption('3');
  await payouts(page).setInputFiles(ties);
  await bank(page).setInputFiles(deposits);
  const group = queue(page).locator('tr[data-exception-code="AMBIGUOUS_TIE"]');
  await expect(group.getByRole('cell')).toHaveText(['2, 4', '2, 4', '—']);
  const { csv, audit, exceptions } = await files(page, info, 'connected-tie', ties, deposits);
  expect(csv).toEqual([]);
  expect(exceptions).toHaveLength(1);
  expect(exceptions[0]).toMatchObject({ Code: 'AMBIGUOUS_TIE', 'Payout Lines': '2, 4', 'Bank Lines': '2, 4' });
  expect(audit.summary.byCurrency).toContainEqual(expect.objectContaining({ currency: 'USD', ambiguousPayoutCents: '400', ambiguousBankCents: '400', matchedPayoutCents: '0' }));
});
