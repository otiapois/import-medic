import { expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertFits, test } from './browser';
import { button, csv, field, openStudio, pair, parseCsv, save } from './m7-files';
import { bookkeeper, offlineReport } from './m8-reports';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const jsonAudit = 'Download Audit Report (.json)';
const repairedCsv = 'Download Repaired CSV';

async function openFingerprints(page: Page) {
  const strip = page.getByTestId('custody-fingerprints');
  const summary = strip.locator('summary');
  await expect(summary).toHaveText('SHA-256 file fingerprints');
  if (!(await strip.evaluate(element => (element as HTMLDetailsElement).open))) await summary.click();
  return strip;
}

async function expectUiDigest(strip: Locator, field: string, expected: string) {
  const code = strip.locator('code[data-custody-field="' + field + '"]');
  await expect(code).toBeVisible();
  await expect(code).toHaveText(expected);
}

async function expectFooter(report: Page, entries: [string, string][]) {
  const footer = report.locator('footer');
  await expect(footer.getByRole('heading', { name: /SHA-256/ })).toBeVisible();
  await expect(footer.locator('dt')).toHaveText(entries.map(([label]) => label));
  await expect(footer.locator('dd code')).toHaveText(entries.map(([, hash]) => hash));
}

async function capture(page: Page, anchor: Locator, filename: string, spaceAbove: number) {
  await assertFits(page);
  if (process.env.IMPORT_MEDIC_CAPTURE_M9_SCREENSHOTS !== '1') return;
  await page.evaluate(() => document.fonts.ready);
  await anchor.evaluate((element, offset) => window.scrollBy(0, element.getBoundingClientRect().top - offset), spaceAbove);
  const dir = resolve('docs/reports/screenshots/m9');
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, filename + '.png'), animations: 'disabled' });
}

test('SHA-256 across original BOM catalog, CSV and XLSX suppliers, native downloads, audit and offline client sign-off', async ({ page, beginProcessing }, info) => {
  const catalog = csv('provenance.csv', [
    ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price'],
    ['canvas', 'Canvas', 'Size', 'S', '00123', '39.00'],
    ['pack', 'Pack', 'Size', 'XL', '00045-XL', '24.00'],
    ['case', 'Case', 'Size', 'M', 'AGENCY-NEW', '12.00'],
    ['linen', 'Linen', 'Size', 'L', 'LINEN', '15.00'],
  ]);
  catalog.buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), catalog.buffer]);
  const csvSupplier = csv('linen.csv', [['SKU', 'Price'], ['LINEN', '16.00'], ['00045-XL', '24']]);
  const workbookName = 'supplier-agency.xlsx';
  const workbookPath = resolve('fixtures/shopify-price-diff', workbookName);
  const workbook = await readFile(workbookPath);
  expect(workbook.subarray(0, 2).toString()).toBe('PK');
  await openStudio(page, beginProcessing);
  await field(page, 'Choose Shopify baseline CSV').setInputFiles(catalog);
  await field(page, 'Choose supplier price sheet').setInputFiles(csvSupplier);
  await button(page, '+ Add another supplier sheet').click();
  await field(page, 'Choose supplier price sheet 2').setInputFiles(workbookPath);
  const strip = await openFingerprints(page);
  await expectUiDigest(strip, 'supplier-2', digest(workbook));
  await pair(page, 'Shopify', true);
  await field(page, 'Supplier conflict policy').selectOption({ label: 'Prefer lowest price' });
  await pair(page, 'Shopify', false);
  await expect(strip.locator('[data-custody-field="update"], [data-custody-field="rollback"]')).toHaveCount(0);
  const pending = await save(page, info, 'Download Full Diff Audit (.json)', 'provenance-price-diff.audit.json', 'm9-price-unconfirmed');
  const pendingCustody = JSON.parse(pending.text).custody;
  expect(pendingCustody.baselineSha256).toBe(digest(catalog.buffer));
  expect(pendingCustody).not.toHaveProperty('updateCsvSha256');
  expect(pendingCustody).not.toHaveProperty('rollbackCsvSha256');
  const pendingReport = await offlineReport(page, info, 'Download Client Sign-Off (.html)', 'provenance-client-sign-off.html');
  await expect(pendingReport.report.locator('footer dt')).toHaveCount(3);
  await expect(pendingReport.report.locator('footer code')).toHaveText([digest(catalog.buffer), digest(csvSupplier.buffer), digest(workbook)]);
  await info.attach('price-unconfirmed.html', { body: pendingReport.source, contentType: 'text/html' });
  await pendingReport.report.close();
  await page.context().setOffline(false);
  await button(page, 'Confirm supplier conflict policy').click();
  await pair(page, 'Shopify', true);
  await openFingerprints(page);
  const update = await save(page, info, 'Download Safe Shopify Update CSV', 'provenance-price-update.csv', 'm9-price');
  const rollback = await save(page, info, 'Download Shopify Rollback CSV', 'provenance-price-rollback.csv', 'm9-price');
  const updateRows = parseCsv(update.text);
  const rollbackRows = parseCsv(rollback.text);
  for (const [matrix, prices] of [[updateRows, ['40.00', '16.00']], [rollbackRows, ['39.00', '15.00']]] as const) {
    const [headers, ...rows] = matrix;
    expect(rows.map(row => [row[headers.indexOf('Variant SKU')], row[headers.indexOf('Variant Price')]])).toEqual([
      ['00123', prices[0]], ['LINEN', prices[1]],
    ]);
  }
  const custody = {
    baselineSha256: digest(catalog.buffer),
    suppliers: [
      { filename: csvSupplier.name, bytes: csvSupplier.buffer.length, sha256: digest(csvSupplier.buffer) },
      { filename: workbookName, bytes: workbook.length, sha256: digest(workbook) },
    ],
    updateCsvSha256: digest(await readFile(update.path)),
    rollbackCsvSha256: digest(await readFile(rollback.path)),
  };
  const audit = await save(page, info, 'Download Full Diff Audit (.json)', 'provenance-price-diff.audit.json', 'm9-price');
  expect(JSON.parse(audit.text).custody).toEqual(custody);
  for (const [name, hash] of [
    ['baseline', custody.baselineSha256], ['supplier-1', custody.suppliers[0].sha256],
    ['supplier-2', custody.suppliers[1].sha256], ['update', custody.updateCsvSha256], ['rollback', custody.rollbackCsvSha256],
  ]) await expectUiDigest(strip, name, hash);
  for (const supplier of custody.suppliers) await expect(strip).toContainText(supplier.filename + ' · ' + supplier.bytes.toLocaleString('en-US') + ' bytes');
  const desktop = info.project.name === 'desktop';
  await capture(page, strip, desktop ? 'desktop-m9-custody-hashes' : 'mobile-m9-custody', desktop ? 300 : 145);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
  await page.bringToFront();
  const copy = button(page, 'Copy Baseline SHA-256');
  await copy.click();
  await expect(copy).toHaveText(/^(Copied|Selected)$/);
  const copied = (await copy.textContent()) === 'Copied'
    ? await page.evaluate(() => navigator.clipboard.readText())
    : await page.evaluate(() => window.getSelection()?.toString());
  expect(copied).toBe(custody.baselineSha256);
  info.annotations.push({ type: 'm9-custody', description: JSON.stringify({ ...custody, copy: await copy.textContent() }) });
  const { report } = await offlineReport(page, info, 'Download Client Sign-Off (.html)', 'provenance-client-sign-off.html');
  await expectFooter(report, [
    ['Baseline CSV', custody.baselineSha256],
    ...custody.suppliers.map(s => ['Supplier ' + s.filename + ' (' + s.bytes + ' bytes)', s.sha256] as [string, string]),
    ['Update CSV', custody.updateCsvSha256], ['Rollback CSV', custody.rollbackCsvSha256],
  ]);
  await report.close();
});

const payments = [
  { provider: 'Stripe', convention: 'deduction', header: ['created_utc', 'description', 'gross', 'fee', 'net', 'currency', 'balance_transaction_id'], refundFee: '-0.30', brokenFee: '0.75', formula: 'Gross − Fee' },
  { provider: 'PayPal', convention: 'signed-movement', header: ['Date', 'Name', 'Gross', 'Fee', 'Net', 'Currency', 'Transaction ID'], refundFee: '0.30', brokenFee: '-0.75', formula: 'Gross + Fee' },
] as const;

for (const payment of payments) {
  test(payment.provider + ' refund sign and one-cent mismatch across accounting and bank export, source-bound offline repair', async ({ page, beginProcessing }, info) => {
    const name = payment.provider.toLowerCase() + '-custody';
    const source = csv(name + '.csv', [
      [...payment.header],
      ['2026-11-25', 'Refund', '-15.00', payment.refundFee, '-14.70', 'USD', 'R-01'],
      ['2026-11-26', 'Invoice', '20.00', payment.brokenFee, '19.24', 'USD', 'P-02'],
    ]);
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Stripe / PayPal' }).click();
    beginProcessing();
    await field(page, 'Choose CSV file').setInputFiles(source);
    const sourceSha256 = digest(source.buffer);
    for (const format of ['accounting', 'quickbooks-3col']) {
      await page.getByLabel('Export format').selectOption(format);
      await expect(page.getByTestId('manual-review-count')).toHaveText('1');
      await page.getByRole('tab', { name: 'Issues & Review' }).click();
      await page.getByLabel('Filter issues').selectOption('review');
      const issue = page.locator('[data-issue-code="reconciliation-mismatch"]');
      await expect(issue).toHaveAttribute('aria-label', 'Line 3 · Net');
      const details = issue.getByTestId('reconciliation-details');
      await expect(details.locator('dt')).toHaveText(['Gross', 'Fee', 'Net', 'Expected Net']);
      await expect(details.locator('code')).toHaveText(['20.00', payment.brokenFee, '19.24', '19.25']);
      await expect(details).toContainText(payment.formula);
      await expect(button(page, repairedCsv)).toBeDisabled();
      if (info.project.name === 'desktop' && payment.provider === 'Stripe' && format === 'accounting')
        await capture(page, issue, 'desktop-m9-reconciliation-guard', 240);
      const strip = await openFingerprints(page);
      await expectUiDigest(strip, 'source', sourceSha256);
      await expect(strip.locator('[data-custody-field="repaired"]')).toHaveCount(0);
      const blocked = JSON.parse((await save(page, info, jsonAudit, name + '.audit.json', 'm9-' + format + '-blocked')).text);
      expect(blocked).toMatchObject({ custody: { sourceSha256 }, canDownload: false, stripePayPalFeeConvention: payment.convention });
      expect(blocked.custody).toEqual({ sourceSha256 });
      expect(blocked.issues.filter((entry: { code: string }) => entry.code === 'reconciliation-mismatch')).toMatchObject([{
        row: 3, column: 'Net', rawValue: '19.24', autoFixed: false,
        reconciliation: { gross: '20.00', fee: payment.brokenFee, net: '19.24', expectedNet: '19.25', feeConvention: payment.convention },
      }]);
    }
    const blockedReport = await offlineReport(page, info, bookkeeper, name + '-bookkeeper-sign-off.html');
    const line = blockedReport.report.locator('table.lines tbody tr').filter({ has: blockedReport.report.getByRole('rowheader', { name: '3', exact: true }) });
    await expect(line).toContainText('Expected Net from ' + payment.formula);
    await expect(line.locator('code')).toHaveText(['20.00', payment.brokenFee, '19.24', '19.25']);
    await expectFooter(blockedReport.report, [['Source CSV', sourceSha256]]);
    await info.attach(name + '-blocked-report.html', { body: blockedReport.source, contentType: 'text/html' });
    await blockedReport.report.close();
    await page.context().setOffline(false);
    await page.getByLabel('Export format').selectOption('accounting');
    const issue = page.locator('[data-issue-code="reconciliation-mismatch"]');
    await issue.getByRole('button', { name: 'Edit', exact: true }).click();
    const corrected = issue.getByLabel('Corrected value');
    await expect(corrected).toHaveValue('19.24');
    await corrected.fill('19.25');
    await issue.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByTestId('manual-review-count')).toHaveText('0');
    const repaired = await save(page, info, repairedCsv, name + '-repaired.csv', 'm9-corrected');
    const [, refund, invoice] = parseCsv(repaired.text);
    expect(refund.slice(2, 5)).toEqual(['-15.00', payment.refundFee, '-14.70']);
    expect(invoice.slice(2, 5)).toEqual(['20.00', payment.brokenFee, '19.25']);
    const repairedCsvSha256 = digest(await readFile(repaired.path));
    const audit = JSON.parse((await save(page, info, jsonAudit, name + '.audit.json', 'm9-corrected')).text);
    expect(audit.custody).toEqual({ sourceSha256, repairedCsvSha256 });
    const strip = await openFingerprints(page);
    await expectUiDigest(strip, 'source', sourceSha256);
    await expectUiDigest(strip, 'repaired', repairedCsvSha256);
    const { report } = await offlineReport(page, info, bookkeeper, name + '-bookkeeper-sign-off.html');
    await expectFooter(report, [['Source CSV', sourceSha256], ['Repaired CSV', repairedCsvSha256]]);
    await expect(report.locator('table.lines')).toContainText(/Manual edit.*19\.24.*19\.25/);
    info.annotations.push({ type: 'm9-repair', description: JSON.stringify({ provider: payment.provider, sourceSha256, repairedCsvSha256 }) });
    await report.close();
  });
}

for (const layout of ['3col', '4col']) {
  test('QuickBooks ' + layout + ' blocks mixed explicit currencies and lists multiline physical source lines in the offline report', async ({ page, beginProcessing }, info) => {
    const rows = [['First\ncontinued', '50.00', 'USD'], ['Second', '20.00', 'EUR'], ['Third', '12.00', 'USD']];
    const split = layout === '4col';
    const name = 'mixed-' + layout;
    const source = csv(name + '.csv', [
      ['Date', 'Description', ...(split ? ['Credit', 'Debit'] : ['Amount']), 'Currency'],
      ...rows.map(([description, amount, currency]) => ['11/26/2026', description, amount, ...(split ? [''] : []), currency]),
    ]);
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'QuickBooks Bank' }).click();
    await page.getByLabel('QuickBooks output layout').selectOption(layout);
    if (split) await page.getByLabel('Credit / Debit convention').selectOption('bank');
    beginProcessing();
    await field(page, 'Choose CSV file').setInputFiles(source);
    await page.getByRole('tab', { name: 'Issues & Review' }).click();
    const groups = page.getByRole('region', { name: 'Currency split' });
    await expect(groups.locator('[data-currency]')).toHaveCount(2);
    for (const [currency, lines] of [['USD', [2, 5]], ['EUR', [4]]] as const) {
      const group = groups.locator('[data-currency="' + currency + '"]');
      await expect(group.locator('summary')).toHaveText(currency + ' · ' + lines.length + (lines.length === 1 ? ' line' : ' lines'));
      await group.locator('summary').click();
      await expect(group.getByTestId('currency-source-lines')).toHaveText(lines.join(', '));
    }
    await expect(button(page, repairedCsv)).toBeDisabled();
    const audit = JSON.parse((await save(page, info, jsonAudit, name + '.audit.json', 'm9-currency')).text);
    expect(audit.custody).toEqual({ sourceSha256: digest(source.buffer) });
    expect(audit.currencySplit).toEqual(expect.arrayContaining([{ currency: 'USD', lines: [2, 5] }, { currency: 'EUR', lines: [4] }]));
    const { report } = await offlineReport(page, info, bookkeeper, name + '-bookkeeper-sign-off.html');
    const table = report.getByRole('heading', { name: 'Currency split required' }).locator('..').getByRole('table');
    await expect(table.getByRole('rowheader', { name: 'USD' }).locator('..').locator('td')).toHaveText(['2', '2, 5']);
    await expect(table.getByRole('rowheader', { name: 'EUR' }).locator('..').locator('td')).toHaveText(['1', '4']);
    await expectFooter(report, [['Source CSV', digest(source.buffer)]]);
    await report.close();
  });
}
