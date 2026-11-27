import { expect, type Page } from '@playwright/test';
import { editIssue, test } from './browser';
import { button, csv, field } from './m7-files';
import { bookkeeper, marker, metric, offlineReport, picture } from './m8-reports';

const summary = ['Total rows', 'Auto-fixed cells', 'Manually edited cells', 'Blocked / flagged lines', 'Excluded memo / non-transaction rows'];
const accounting = 'Stripe / PayPal transactions';

async function checkCounts(report: Page, counts: number[]) {
  for (const [i, label] of summary.entries()) await metric(report, label, String(counts[i]));
  const timestamp = await report.locator('time').getAttribute('datetime');
  expect(Date.parse(timestamp!)).toBeGreaterThan(Date.now() - 120_000);
  expect(Date.parse(timestamp!)).toBeLessThanOrEqual(Date.now());
}

async function checkAmounts(report: Page, expected: string[][]) {
  // Exact table shape rules out a mixed-currency total masquerading as another row or field.
  const rows = report.getByRole('heading', { name: 'Totals by currency' }).locator('+ table').locator('tbody tr');
  await expect(rows).toHaveCount(expected.length);
  for (const [i, cells] of expected.entries()) {
    const actual = await rows.nth(i).locator('th, td').allTextContents();
    expect(actual).toEqual(cells);
  }
}

test('Stripe mixed-currency repair preserves download Tab order and the offline report retains the raw manual entry', async ({ page, beginProcessing }, info) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Stripe / PayPal' }).click();
  beginProcessing();
  await field(page, 'Choose CSV file').setInputFiles(csv('stripe-ledger.csv', [
    ['created_utc', 'description', 'gross', 'fee', 'net', 'currency', 'balance_transaction_id'],
    ['2026-11-24', 'Booking', '$20.00', '2.00', marker, 'usd', 'txn_one'],
    ['2026-11-25', 'Return', '-8.00', '0.00', '-8.00', 'EUR', 'txn_two'],
    ['2026-11-26', 'Workshop', '6.50', '0.25', '6.25', 'USD', 'txn_three'],
  ]));
  await expect(page.getByTestId('manual-review-count')).toHaveText('1');
  await editIssue(page, 2, 'Net', marker, '18.00');
  await button(page, 'Download Repaired CSV').focus();
  for (const name of ['Download Audit Report (.json)', 'Download Audit Report (.txt)', bookkeeper]) {
    await page.keyboard.press('Tab');
    await expect(button(page, name)).toBeFocused();
  }
  const { report, source } = await offlineReport(page, info, bookkeeper, 'stripe-ledger-bookkeeper-sign-off.html');
  await expect(report.getByRole('heading', { name: 'Bookkeeper Sign-Off' })).toBeVisible();
  await expect(report.locator('main')).toContainText('stripe-ledger.csv');
  await expect(report.locator('main')).toContainText(accounting);
  await expect(report.locator('main')).toContainText(/Detected source\s*Stripe/i);
  await checkCounts(report, [3, 2, 1, 0, 0]);
  await checkAmounts(report, [['EUR', '1', '-8.00 1 value', '0.00 1 value', '-8.00 1 value'], ['USD', '2', '26.50 2 values', '2.25 2 values', '24.25 2 values']]);
  expect(source).toContain('&lt;audit-note');
  const audit = report.getByRole('rowheader', { name: '2', exact: true }).locator('..');
  await expect(audit).toContainText(marker);
  await expect(audit).toContainText(/Manual edit.*Net.*18.00/);
  if (info.project.name === 'desktop') await picture(report, report.locator('h1'), 'desktop-m8-bookkeeper-signoff');
  await report.close();
});

test('PayPal excludes the memo physical line and still reports a blocked mixed-currency bank projection offline', async ({ page, beginProcessing }, info) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Stripe / PayPal' }).click();
  await page.getByLabel('Export format').selectOption('quickbooks-3col');
  beginProcessing();
  await field(page, 'Choose CSV file').setInputFiles(csv('paypal-activity.csv', [
    ['Date', 'Name', 'Gross', 'Fee', 'Net', 'Currency', 'Transaction ID', 'Balance Impact'],
    ['11/24/2026', 'First', '10.00', '-1.00', '9.00', 'USD', 'P-1', 'Credit'],
    ['11/24/2026', marker, '999.00', '0.00', '999.00', 'USD', 'P-2', 'Memo'],
    ['11/25/2026', 'Refund', '-3.00', '0.00', '-3.00', 'EUR', 'P-3', 'Debit'],
  ]));
  await page.getByLabel('Exclude PayPal Memo rows').check();
  await expect(button(page, 'Download Repaired CSV')).toBeDisabled();
  await expect(page.getByTestId('manual-review-count')).toHaveText('1');
  const { report, source } = await offlineReport(page, info, bookkeeper, 'paypal-activity-bookkeeper-sign-off.html');
  await expect(report.locator('main')).toContainText(/Repaired CSV\s*Blocked/);
  await expect(report.locator('main')).toContainText(/Detected source\s*PayPal/i);
  await checkCounts(report, [3, 0, 0, 1, 1]);
  await checkAmounts(report, [['EUR', '1', '-3.00 1 value', '0.00 1 value', '-3.00 1 value'], ['USD', '1', '10.00 1 value', '-1.00 1 value', '9.00 1 value']]);
  expect(source).toContain('&lt;audit-note');
  await expect(report.getByRole('rowheader', { name: '3', exact: true }).locator('..')).toContainText(/Excluded.*audit-note/);
  await expect(report.getByRole('rowheader', { name: '4', exact: true }).locator('..')).toContainText(/Flagged.*Currency.*EUR/);
  await report.close();
});

test('QuickBooks bank and Intuit split conventions preserve signed per-currency totals after projection', async ({ page, beginProcessing }, info) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'QuickBooks Bank' }).click();
  await page.getByLabel('QuickBooks output layout').selectOption('4col');
  await page.getByLabel('Credit / Debit convention').selectOption('bank');
  beginProcessing();
  await field(page, 'Choose CSV file').setInputFiles(csv('bank-directions.csv', [
    ['Date', 'Description', 'Credit', 'Debit', 'Currency'],
    ['11/24/2026', 'Deposit', '40.00', '', 'USD'],
    ['11/24/2026', 'Refund', '', '8.00', 'USD'],
    ['11/25/2026', 'Fee', '', '7.00', 'EUR'],
  ]));
  for (const [mode, usd, eur] of [['bank', '32.00', '-7.00'], ['intuit', '-32.00', '7.00']]) {
    if (mode === 'intuit') await page.getByLabel('Credit / Debit convention').selectOption(mode);
    await expect(page.getByTestId('manual-review-count')).toHaveText('1');
    await expect(button(page, 'Download Repaired CSV')).toBeDisabled();
    const { report } = await offlineReport(page, info, bookkeeper, 'bank-directions-bookkeeper-sign-off.html');
    await expect(report.locator('main')).toContainText('QuickBooks bank (4-column target)');
    await checkCounts(report, [3, 0, 0, 1, 0]);
    await checkAmounts(report, [['EUR', '1', eur + ' 1 value'], ['USD', '2', usd + ' 2 values']]);
    await report.close();
    await page.context().setOffline(false);
  }
});
