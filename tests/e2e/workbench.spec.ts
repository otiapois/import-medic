import { expect } from '@playwright/test';
import { assertFits, downloadCsv, downloadText, editIssue, loadFile, screenshot, test } from './browser';

const csvButton = 'Download Repaired CSV';
const bankHeader = ['Date', 'Description', 'Amount'];

test.beforeEach(async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
});

test('home, local samples, and platform switching', async ({ page, beginProcessing }, info) => {
  await expect(page.getByRole('heading', { name: 'Fix CSV import errors' })).toBeVisible();
  await expect(page.getByText('100% Local in Your Browser', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => [...document.styleSheets].every((sheet) =>
    sheet.href && new URL(sheet.href).origin === location.origin))).toBe(true);
  await assertFits(page);
  await screenshot(page, info.project.name + '-home');
  beginProcessing();
  for (const [tab, name, count] of [
    ['Shopify Products', 'shopify-products-sample.csv', '1'],
    ['QuickBooks Bank', 'quickbooks-bank-sample.csv', '2'],
    ['Stripe / PayPal', 'stripe-balance-sample.csv', '1'],
  ]) {
    await page.getByRole('tab', { name: tab }).click();
    await page.getByRole('button', { name: 'Try a Broken Sample CSV' }).click();
    await expect(page.getByRole('region', { name: 'Repair results' }).getByText(name, { exact: true })).toBeVisible();
    await expect(page.getByTestId('manual-review-count')).toHaveText(count);
    await assertFits(page);
  }
});

test('Shopify warns on unresolved values and exports the inline price edit', async ({ page, beginProcessing }, info) => {
  beginProcessing();
  await loadFile(page, 'shopify/invalid-variant-price.csv');
  const button = page.getByRole('button', { name: csvButton });
  await expect(button).toHaveAccessibleDescription(/Draft CSV.*1 unresolved issue/);
  await expect(page.getByTestId('manual-review-count')).toHaveText('1');
  const expected = [
    ['Handle', 'Title', 'Variant SKU', 'Variant Price'],
    ['desk-lamp', 'Desk Lamp', 'LAMP-A', 'call for price'],
    ['reading-lamp', 'Reading Lamp', 'LAMP-B', '52.00'],
  ];
  expect(await downloadCsv(page, 'invalid-variant-price', 'LF')).toEqual(expected);
  await editIssue(page, 2, 'Variant Price', 'call for price', '38.00');
  await expect(button).toHaveAccessibleDescription('');
  await page.getByRole('tab', { name: 'Before / After Table' }).click();
  const original = page.getByRole('table', { name: 'Original CSV' });
  const repaired = page.getByRole('table', { name: 'Repaired CSV' });
  await expect(original.getByRole('cell', { name: /call for price.*Changed/ })).toBeVisible();
  await expect(repaired.getByRole('cell', { name: /38\.00.*Changed/ })).toBeVisible();
  await assertFits(page);
  await page.getByRole('heading', { name: info.project.name === 'mobile' ? 'Before / after comparison' : 'Repair results' })
    .evaluate((heading) => window.scrollTo(0, window.scrollY + heading.getBoundingClientRect().top - 24));
  if (info.project.name === 'mobile') {
    for (const label of ['Original CSV scrollable table', 'Repaired CSV scrollable table']) {
      await page.getByRole('region', { name: label }).evaluate((region) => { region.scrollLeft = region.scrollWidth; });
    }
  }
  await screenshot(page, info.project.name === 'mobile' ? 'mobile-diff' : 'desktop-shopify-diff');
  expected[1][3] = '38.00';
  expect(await downloadCsv(page, 'invalid-variant-price', 'LF')).toEqual(expected);
  const audit = JSON.parse(await downloadText(page, 'Download Audit Report (.json)', 'invalid-variant-price.audit.json'));
  expect(audit).toMatchObject({
    filename: 'invalid-variant-price.csv', needsManualReviewCount: 0,
    roundtripCheck: { checked: true, autoFixableRemaining: 0, needsManualReviewCount: 0 },
  });
  expect(audit.changes).toContainEqual(expect.objectContaining({
    row: 2, column: 'Variant Price', before: 'call for price', after: '38.00', code: 'manual-edit',
  }));
});

test('QuickBooks requires an explicit date order and preserves both money directions', async ({ page, beginProcessing }, info) => {
  beginProcessing();
  await page.getByRole('tab', { name: 'QuickBooks Bank' }).click();
  await loadFile(page, 'quickbooks/ambiguous-dates.csv');
  await expect(page.getByTestId('manual-review-count')).toHaveText('2');
  await expect(page.getByRole('button', { name: csvButton })).toBeDisabled();
  await page.getByLabel('Date format').selectOption('MDY');
  await expect(page.getByTestId('manual-review-count')).toHaveText('0');
  await page.getByRole('tab', { name: 'Before / After Table' }).click();
  const repaired = page.getByRole('table', { name: 'Repaired CSV' });
  await expect(repaired.getByRole('row', { name: /03\/04\/2026.*Studio rent.*-400\.00/ })).toBeVisible();
  if (info.project.name === 'desktop') {
    await page.getByLabel('Date format')
      .evaluate((field) => window.scrollTo(0, window.scrollY + field.getBoundingClientRect().top - 48));
    await screenshot(page, 'desktop-qbo-fixed');
  }
  expect(await downloadCsv(page, 'ambiguous-dates', 'CRLF')).toEqual([
    bankHeader, ['03/04/2026', 'Studio rent', '-400.00'], ['06/07/2026', 'Wholesale deposit', '460.00'],
  ]);
  await page.getByLabel('QuickBooks output layout').selectOption('4col');
  expect(await downloadCsv(page, 'ambiguous-dates', 'CRLF')).toEqual([
    ['Date', 'Description', 'Credit', 'Debit'], ['03/04/2026', 'Studio rent', '400.00', ''], ['06/07/2026', 'Wholesale deposit', '', '460.00'],
  ]);
  await loadFile(page, 'quickbooks/split-direction-unconfirmed.csv');
  await expect(page.getByRole('button', { name: csvButton })).toBeDisabled();
  await page.getByLabel('Credit / Debit convention').selectOption('bank');
  await page.getByLabel('QuickBooks output layout').selectOption('3col');
  expect(await downloadCsv(page, 'split-direction-unconfirmed', 'CRLF')).toEqual([
    bankHeader, ['11/24/2026', 'Paper supplies', '-23.75'], ['11/25/2026', 'Shop deposit', '80.00'],
  ]);
});

test('Stripe repairs the source Net cell and exports itemized accounting values', async ({ page, beginProcessing }) => {
  beginProcessing();
  await page.getByRole('tab', { name: 'Stripe / PayPal' }).click();
  await loadFile(page, 'stripe-paypal/stripe-invalid-net.csv');
  await expect(page.getByTestId('manual-review-count')).toHaveText('1');
  await editIssue(page, 2, 'Net', 'pending', '101.65');
  await page.getByRole('tab', { name: 'Before / After Table' }).click();
  await expect(page.getByRole('table', { name: 'Original CSV' }).getByText('pending')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Repaired CSV' }).getByText('101.65')).toBeVisible();
  expect(await downloadCsv(page, 'stripe-invalid-net', 'CRLF')).toEqual([
    ['Date', 'Description', 'Gross', 'Fee', 'Net', 'Currency', 'Reference ID'],
    ['2026-11-24', 'Studio booking', '105.00', '3.35', '101.65', 'USD', 'txn_demo200'],
    ['2026-11-25', 'Workshop ticket', '40.00', '1.46', '38.54', 'USD', 'txn_demo201'],
  ]);
});

test('PayPal excludes only the chosen Memo row and records its physical line in both audits', async ({ page, beginProcessing }) => {
  beginProcessing();
  await page.getByRole('tab', { name: 'Stripe / PayPal' }).click();
  await loadFile(page, 'stripe-paypal/paypal-memo-filter.csv');
  await page.getByLabel('Export format').selectOption('quickbooks-3col');
  await expect(page.getByRole('button', { name: csvButton })).toBeDisabled();
  await expect(page.getByTestId('manual-review-count')).toHaveText('1');
  await page.getByLabel('Exclude PayPal Memo rows').check();
  await expect(page.getByTestId('manual-review-count')).toHaveText('0');
  await page.getByRole('tab', { name: 'Removed Rows' }).click();
  const raw = '11/24/2026,10:10:18,PST,Workshop Shop,Authorization,Pending,USD,14.00,0.00,14.00,DEMO-PP-002,126.31,Memo';
  const removed = page.getByRole('tabpanel', { name: 'Removed Rows' });
  await expect(removed.getByText('Line 3', { exact: true })).toBeVisible();
  await expect(removed.getByText(raw, { exact: true })).toBeVisible();
  expect(await downloadCsv(page, 'paypal-memo-filter', 'CRLF')).toEqual([
    bankHeader, ['11/24/2026', 'Workshop Shop', '82.23'], ['11/25/2026', 'Workshop Shop', '-15.00'],
  ]);
  const json = JSON.parse(await downloadText(page, 'Download Audit Report (.json)', 'paypal-memo-filter.audit.json'));
  expect(json.removedRows).toEqual([expect.objectContaining({ row: 3, code: 'paypal-memo-removed', rawPreview: raw })]);
  const text = await downloadText(page, 'Download Audit Report (.txt)', 'paypal-memo-filter.audit.txt');
  expect(text).toContain('REMOVED ROWS (1)');
  expect(text).toContain('Line 3 | paypal-memo-removed');
  expect(text).toContain(raw);
});

test('browser decodes the legacy and Unicode input bytes before emitting UTF-8', async ({ page, beginProcessing }) => {
  beginProcessing();
  await loadFile(page, 'shopify/utf16le-supplier-export.csv');
  await expect(page.getByText(/UTF-16LE \/ /)).toBeVisible();
  expect(await downloadCsv(page, 'utf16le-supplier-export', 'LF')).toEqual([
    ['Handle', 'Title', 'Variant SKU', 'Variant Price', 'Published'],
    ['matcha-scoop', '抹茶スプーン', 'TEA-SCOOP', '12.00', 'TRUE'],
  ]);
  await loadFile(page, 'shopify/windows-1252-smart-punctuation.csv');
  await expect(page.getByText(/Windows-1252 \/ /)).toBeVisible();
  const rows = await downloadCsv(page, 'windows-1252-smart-punctuation', 'LF');
  expect(rows[1][1]).toBe("Café cup - chef's choice");
  expect(rows[1][2]).toBe('<p>Our "stoneware" mug</p>');
  expect(rows[2][1]).toBe("Maker's wall bracket");
});

