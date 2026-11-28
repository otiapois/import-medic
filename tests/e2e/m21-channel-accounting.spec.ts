import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Papa from 'papaparse';
import { assertFits, test } from './browser';
import { auditPage } from './m10-accessibility';
import { button, csv, field, save } from './m7-files';
import { bookkeeper, offlineReport } from './m8-reports';

type Input = { name: string; mimeType: string; buffer: Buffer };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const tsv = (name: string, rows: string[][]): Input => ({
  name, mimeType: 'text/tab-separated-values', buffer: Buffer.from(Papa.unparse(rows, { delimiter: '\t', newline: '\r\n' })),
});

async function archiveInputs(info: TestInfo, stage: string, files: Input[]) {
  const downloads = process.env.IMPORT_MEDIC_M7_DOWNLOADS;
  const folder = downloads ? resolve(downloads, info.project.name, stage) : info.outputPath(stage);
  await mkdir(folder, { recursive: true });
  for (const file of files) await writeFile(resolve(folder, file.name), file.buffer);
}

async function capture(page: Page, anchor: Locator, name: string) {
  await assertFits(page);
  if (process.env.IMPORT_MEDIC_CAPTURE_M21_SCREENSHOTS !== '1') return;
  await page.evaluate(() => document.fonts.ready);
  await anchor.evaluate(node => window.scrollBy(0, node.getBoundingClientRect().top - 18));
  const folder = resolve('docs/reports/screenshots/m21');
  await mkdir(folder, { recursive: true });
  await page.screenshot({ path: resolve(folder, name + '.png'), animations: 'disabled' });
}

const table = [
  ['sku', 'price', 'minimum-seller-allowed-price', 'maximum-seller-allowed-price', 'quantity', 'handling-time', 'notes'],
  ['00314', '012.30', '10.00', '15.00', '007', '04', 'first\r\nline of notes'],
  ['00417', '19.5', '18.50', '21.00', '000', '02', 'second'],
  ['UNTOUCHED', '33.00', '30.00', '35.00', '001', '03', 'spare'],
];
const baseline = tsv('november-price-quantity.txt', table);
const proposal = csv('november-price-proposal.csv', [
  ['sku', 'price', 'quantity'], ['00314', '10.00', '12'], ['00417', '21.00', ''],
]);
const outside = tsv('marketplace-price-corridor-exceptions.tsv', [
  ['sku', 'price', 'quantity'], ['00314', '9.99', ''], ['00417', '21.01', ''],
]);

function replay(update: string, rollback: string) {
  const local = table.map(row => [...row]);
  for (const [text, expected] of [
    [update, [['00314', '10.00', '12'], ['00417', '21.00', '']]],
    [rollback, [['00314', '012.30', '007'], ['00417', '19.5', '']]],
  ] as const) {
    const parsed = Papa.parse<string[]>(text, { delimiter: '\t', skipEmptyLines: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.data).toEqual([['sku', 'price', 'quantity'], ...expected]);
    for (const [sku, price, quantity] of parsed.data.slice(1)) {
      const row = local.find(record => record[0] === sku)!;
      row[1] = price;
      if (quantity !== '') row[4] = quantity;
    }
    for (const [index, row] of local.entries()) {
      expect([row[0], row[2], row[3], row[5], row[6]]).toEqual([table[index][0], table[index][2], table[index][3], table[index][5], table[index][6]]);
    }
    expect(local[3]).toEqual(table[3]);
  }
  expect(tsv('restored.txt', local).buffer).toEqual(baseline.buffer);
}

test('Amazon Price & Quantity holds out-of-corridor physical lines and verifies a downloaded scoped update and exact rollback', async ({ page, beginProcessing }, info) => {
  const stage = 'm21-amazon';
  await archiveInputs(info, stage, [baseline, proposal, outside]);
  await page.goto('/shopify-price-update-diff', { waitUntil: 'networkidle' });
  await button(page, 'Amazon Seller Central').click();
  const build = page.getByRole('region', { name: 'Amazon Price & Quantity', exact: true });
  await expect(build.getByRole('heading', { name: 'Min/Max Price Corridor' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  beginProcessing();
  await button(page, 'Load Synthetic Amazon Demo').click();
  const state = build.getByTestId('amazon-build-status');
  await expect(state).toHaveAttribute('data-ready', 'true');
  await expect(build.getByText('Synthetic file', { exact: true })).toHaveCount(2);
  await build.getByTestId('amazon-baseline-input').setInputFiles(baseline);
  await build.getByTestId('amazon-proposal-input').setInputFiles(outside);
  await expect(state).toHaveAttribute('data-held', 'true');
  const issues = build.getByTestId('amazon-build-issues').locator('[data-issue-code="amazon-price-outside-corridor"]');
  await expect(issues).toHaveCount(2);
  for (const [i, line, sourceLine, proposed, minimum, maximum] of [
    [0, 2, 2, '9.99', '10.00', '15.00'], [1, 3, 4, '21.01', '18.50', '21.00'],
  ] as const) {
    const issue = issues.nth(i);
    for (const text of [`Proposal line ${line}`, `Baseline line ${sourceLine}`, `proposed price ${proposed}`, `minimum ${minimum}`, `maximum ${maximum}`]) {
      await expect(issue).toContainText(text);
    }
  }
  for (const role of ['update', 'rollback']) await expect(build.getByTestId('amazon-download-' + role)).toBeDisabled();
  const held = JSON.parse((await save(page, info, 'Download Amazon Audit JSON', 'price-audit.json', stage + '-held')).text);
  expect(held.custody).toEqual({ baselineSha256: sha(baseline.buffer), proposalSha256: sha(outside.buffer) });
  const filenames = await build.locator('.price-file-name strong').evaluateAll(nodes => nodes.map(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return [...range.getClientRects()].every(rect => rect.left >= 0 && rect.right <= innerWidth + 1);
  }));
  expect(filenames).toEqual([true, true]);
  const access = await auditPage(page, 'workbench');
  const desktop = info.project.name === 'desktop';
  await capture(page, desktop ? build.locator('.amazon-corridor') : state, desktop ? 'desktop-m21-amazon-corridor' : 'mobile-m21-amazon');

  await build.getByTestId('amazon-proposal-input').setInputFiles(proposal);
  await expect(state).toHaveAttribute('data-ready', 'true');
  await expect(build.getByTestId('amazon-build-rows')).toContainText('00314');
  const update = await save(page, info, 'Download Amazon Update File', 'amazon-update.txt', stage);
  const rollback = await save(page, info, 'Download Amazon Rollback File', 'amazon-rollback.txt', stage);
  replay(update.text, rollback.text);
  const audit = JSON.parse((await save(page, info, 'Download Amazon Audit JSON', 'price-audit.json', stage)).text);
  const updateSha256 = sha(await readFile(update.path));
  const rollbackSha256 = sha(await readFile(rollback.path));
  expect(audit.custody).toEqual({ baselineSha256: sha(baseline.buffer), proposalSha256: sha(proposal.buffer), updateSha256, rollbackSha256 });

  await page.getByRole('tab', { name: /Verify Update/ }).click();
  const verify = page.getByRole('region', { name: 'Verify before import', exact: true });
  await verify.getByRole('combobox', { name: 'Store platform' }).selectOption('amazon');
  await verify.getByLabel('Choose Amazon baseline Price & Quantity file', { exact: true }).setInputFiles(baseline);
  const candidate = verify.getByLabel('Choose Amazon update or rollback file', { exact: true });
  const submit = verify.getByRole('button', { name: 'Verify Amazon File' });
  const verdict = verify.getByTestId('verify-verdict');
  await candidate.setInputFiles(update.path);
  await submit.click();
  await expect(verdict).toHaveText('PASS');
  await expect(verify.getByTestId('verify-residual-diffs')).toHaveText('3 target cell differences');
  await expect(verify.locator('[data-custody-field="candidate"]')).toHaveText(updateSha256);
  const forbidden = tsv('forbidden-handling.tsv', [['sku', 'price', 'handling-time'], ['00314', '10.00', '90']]);
  const altered = { name: 'altered-rollback.txt', mimeType: 'text/plain', buffer: Buffer.from(rollback.text.replace('012.30', '12.30')) };
  await archiveInputs(info, stage, [forbidden, altered]);
  await candidate.setInputFiles(forbidden);
  await submit.click();
  await expect(verdict).toHaveText('FAIL_UNSAFE');
  await expect(verify.locator('[data-issue-code="amazon-forbidden-column"]')).toContainText('handling-time');
  await candidate.setInputFiles(rollback.path);
  await verify.locator('summary').filter({ hasText: 'Check a rollback with its matching update' }).click();
  await verify.getByLabel('Choose matching Amazon update file', { exact: true }).setInputFiles(update.path);
  await submit.click();
  await expect(verdict).toHaveText('PASS');
  await expect(verify.getByTestId('verify-residual-diffs')).toHaveText('0 residual differences');
  await expect(verify.locator('[data-custody-field="candidate"]')).toHaveText(rollbackSha256);
  await expect(verify.locator('[data-custody-field="paired-update"]')).toHaveText(updateSha256);
  await candidate.setInputFiles(altered);
  await submit.click();
  await expect(verdict).toHaveText('FAIL_UNSAFE');
  await expect(verify.locator('[data-issue-code="amazon-rollback-residual"]')).toContainText('price');
  info.annotations.push({ type: 'm21-amazon-replay', description: JSON.stringify({ viewport: page.viewportSize(), browser: page.context().browser()?.version(), ...audit.custody, access }) });
});

test('QuickBooks holds a signed multiline duplicate pair and a one-cent tax error across Issues, audit and offline sign-off', async ({ page, beginProcessing }, info) => {
  const stage = 'm21-quickbooks';
  const vendor = '<audit-note title="A&B">Depot</audit-note>\r\nNovember';
  const source = csv('november-ledger.csv', [
    ['Date', 'Description', 'Amount', 'Net', 'Tax', 'Total', 'Currency'],
    ['11/21/2026', vendor, '-11.75', '-10.00', '-1.75', '-11.75', 'USD'],
    ['2026-11-21', vendor, '-11.750', '-10.00', '-1.75', '-11.74', 'USD'],
    ['11/21/2026', vendor, '11.75', '10.00', '1.75', '11.75', 'USD'],
    ['11/21/2026', vendor, '-11.75', '-10.00', '-1.75', '-11.75', 'EUR'],
  ]);
  await archiveInputs(info, stage, [source]);
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'QuickBooks Bank', exact: true }).click();
  await field(page, 'Date format').selectOption('MDY');
  await page.waitForLoadState('networkidle');
  beginProcessing();
  await field(page, 'Choose CSV file').setInputFiles(source);
  await page.getByRole('tab', { name: 'Issues & Review' }).click();
  const duplicates = page.getByTestId('duplicate-transaction-alerts');
  const tax = page.getByTestId('tax-reconciliation');
  await expect(duplicates).toContainText('1 duplicate group · 2 affected source lines');
  await expect(tax).toHaveAttribute('data-tax-status', 'FAIL_TAX_MISMATCH');
  await expect(tax).toContainText('4 rows checked in exact cents. 1 mismatch.');
  await page.getByRole('combobox', { name: 'Filter issues', exact: true }).selectOption('review');
  const pairs = page.locator('[data-issue-code="FAIL_DUPLICATE_TRANSACTION"]');
  await expect(pairs).toHaveCount(2);
  for (const [index, line] of ['2', '4'].entries()) {
    await expect(pairs.nth(index)).toHaveAttribute('data-source-row', line);
    await expect(pairs.nth(index).getByTestId('duplicate-source-lines').locator('code')).toHaveText('2, 4');
  }
  const mismatch = page.locator('[data-issue-code="FAIL_TAX_MISMATCH"]');
  await expect(mismatch).toHaveAttribute('data-source-row', '4');
  await expect(mismatch.getByTestId('tax-reconciliation-details').locator('dd')).toHaveText(['-10.00', '-1.75', '-11.74', '-11.75', '0.01']);
  await expect(button(page, 'Download Repaired CSV')).toBeDisabled();
  const sourceSha256 = sha(source.buffer);
  await expect(page.locator('[data-custody-field="source"]')).toHaveText(sourceSha256);
  await expect(page.locator('[data-custody-field="repaired"]')).toHaveCount(0);
  const access = await auditPage(page, 'workbench');
  if (info.project.name === 'desktop') await capture(page, duplicates, 'desktop-m21-tax-duplicate-audit');
  const audit = JSON.parse((await save(page, info, 'Download Audit Report (.json)', 'november-ledger.audit.json', stage)).text);
  expect(audit.canDownload).toBe(false);
  expect(audit.custody).toEqual({ sourceSha256 });
  expect(audit.duplicateTransactions).toMatchObject({ groupCount: 1, affectedRows: 2, groups: [
    { lines: [2, 4], date: '2026-11-21', amount: '-11.75', currency: 'USD' },
  ] });
  expect(audit.taxReconciliation).toEqual({ checkedRows: 4, mismatchCount: 1, status: 'FAIL_TAX_MISMATCH', unverifiableCount: 0, reasons: [],
    mismatches: [{ row: 4, net: '-10.00', tax: '-1.75', gross: '-11.74', expectedGross: '-11.75', delta: '0.01' }] });
  const { report, source: html } = await offlineReport(page, info, bookkeeper, 'november-ledger-bookkeeper-sign-off.html');
  const dupTable = report.locator('section').filter({ has: report.getByRole('heading', { name: 'Duplicate transaction alerts', exact: true }) });
  await expect(dupTable.locator('tbody tr')).toHaveCount(1);
  await expect(dupTable.locator('tbody tr').locator('th,td')).toHaveText(['1', '2, 4', '2026-11-21', '-11.75 USD', vendor]);
  const taxTable = report.locator('section').filter({ has: report.getByRole('heading', { name: /Tax reconciliation \(Net/ }) });
  await expect(taxTable.locator('tbody tr').locator('th,td')).toHaveText(['4', '-10.00', '-1.75', '-11.74', '-11.75', '0.01']);
  await expect(report.locator('footer dd code')).toHaveText([sourceSha256]);
  expect(html).toContain('&lt;audit-note');
  expect(html).not.toContain('<audit-note');
  await report.close();
  await page.context().setOffline(false);
  const columns = ['Date', 'Description', 'Amount', 'Net', 'Tax', 'Total', 'Currency'];
  const row = ['11/21/2026', 'November depot', '-11.75', '-10.00', '-1.75', '-11.75', 'USD'];
  const taxOnly = csv('one-cent-only.csv', [columns, [...row.slice(0, 5), '-11.74', 'USD']]);
  const duplicateOnly = csv('duplicate-only.csv', [columns, row, [...row]]);
  const clean = csv('corrected-ledger.csv', [columns, row]);
  await archiveInputs(info, stage, [taxOnly, duplicateOnly, clean]);
  for (const [file, expected] of [[taxOnly, 'FAIL_TAX_MISMATCH'], [duplicateOnly, 'FAIL_DUPLICATE_TRANSACTION']] as const) {
    await field(page, 'Choose CSV file').setInputFiles(file);
    await expect(page.getByRole('region', { name: 'Repair results' }).getByText(file.name, { exact: true })).toBeVisible();
    await expect(page.locator('[data-issue-code="' + expected + '"]').first()).toBeVisible();
    await expect(button(page, 'Download Repaired CSV')).toBeDisabled();
  }
  await field(page, 'Choose CSV file').setInputFiles(clean);
  await expect(tax).toHaveAttribute('data-tax-status', 'VERIFIED');
  await expect(page.getByTestId('manual-review-count')).toHaveText('0');
  await expect(button(page, 'Download Repaired CSV')).toBeEnabled();
  info.annotations.push({ type: 'm21-quickbooks-audit', description: JSON.stringify({ viewport: page.viewportSize(), browser: page.context().browser()?.version(), sourceSha256, access }) });
});
