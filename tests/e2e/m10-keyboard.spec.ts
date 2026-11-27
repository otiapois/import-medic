import { expect } from '@playwright/test';
import { assertFits, loadFile, test } from './browser';
import { auditPage, captureV1 } from './m10-accessibility';

const paths = [
  '/', '/shopify-csv-fixer', '/quickbooks-csv-fixer', '/stripe-paypal-csv-fixer', '/shopify-price-update-diff',
  '/fix/shopify-csv-invalid-utf8', '/fix/shopify-csv-missing-headers', '/fix/shopify-csv-variant-price-sku',
  '/fix/quickbooks-csv-date-format-error', '/fix/quickbooks-csv-negative-parentheses', '/fix/quickbooks-3-column-vs-4-column',
  '/fix/stripe-payout-csv-to-quickbooks', '/fix/paypal-balance-impact-csv',
];

for (const path of paths) {
  test('Edge names, contrast, focus and modal on ' + path, async ({ page, beginProcessing }, info) => {
    expect((await page.goto(path, { waitUntil: 'networkidle' }))?.status()).toBe(200);
    beginProcessing();
    const idle = await auditPage(page, 'idle');
    const brand = page.getByRole('link', { name: 'ImportMedic', exact: true });
    await brand.focus();
    await page.keyboard.press('?');
    const dialog = page.getByTestId('shortcuts-dialog');
    const close = page.getByTestId('shortcuts-close');
    const setting = page.getByTestId('shortcuts-single-character');
    await expect(dialog).toHaveAccessibleName('Keyboard shortcuts');
    await expect(close).toBeFocused();
    if (path === '/' && info.project.name === 'desktop') await captureV1(page, 'desktop-v1-shortcuts-modal');
    await page.keyboard.press('Shift+Tab');
    await expect(setting).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    const modal = await auditPage(page, 'dialog');
    await page.keyboard.press('Escape');
    await page.keyboard.press('?');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(brand).toBeFocused();
    const opener = page.getByTestId('shortcuts-open');
    await opener.click();
    await expect(close).toBeFocused();
    await setting.uncheck();
    await close.click();
    await expect(opener).toBeFocused();
    await page.keyboard.press('?');
    await expect(dialog).toHaveCount(0);
    await opener.click();
    await setting.check();
    await page.keyboard.press('Escape');
    await expect(opener).toBeFocused();
    await assertFits(page);
    info.annotations.push({ type: 'm10-accessibility', description: JSON.stringify({ path, idle, modal }) });
  });
}

test('Repair editor exposes current field label, controls and visible focus while preserving typed shortcut keys', async ({ page, beginProcessing }, info) => {
  await page.goto('/shopify-csv-fixer', { waitUntil: 'networkidle' });
  beginProcessing();
  await loadFile(page, 'shopify/invalid-variant-price.csv');
  await page.getByRole('tab', { name: 'Issues & Review' }).click();
  await page.getByLabel('Filter issues').selectOption('review');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const value = page.getByLabel('Corrected value');
  await value.focus();
  await page.keyboard.press('End');
  await page.keyboard.type('?/');
  await expect(value).toHaveValue(/\?\/$/);
  await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0);
  await value.fill('38.00');
  const editor = await auditPage(page, 'workbench');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('manual-review-count')).toHaveText('0');
  await page.getByRole('tab', { name: 'Before / After Table' }).click();
  await expect(page.getByRole('table', { name: 'Repaired CSV' })).toBeVisible();
  const results = await auditPage(page, 'workbench');
  info.annotations.push({ type: 'm10-accessibility', description: JSON.stringify({ editor, results }) });
});

test('Slash selects loaded Build search, remains literal in a field, and honors the single-character setting', async ({ page, beginProcessing }) => {
  await page.goto('/shopify-price-update-diff', { waitUntil: 'networkidle' });
  beginProcessing();
  await page.getByRole('button', { name: 'Load Synthetic Agency Demo', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search by SKU or Handle' });
  await expect(search).toBeVisible();
  const origin = page.getByRole('link', { name: 'ImportMedic', exact: true });
  await origin.focus();
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await page.keyboard.type('?/');
  await expect(search).toHaveValue('?/');
  await origin.focus();
  await page.keyboard.press('?');
  await page.getByTestId('shortcuts-single-character').uncheck();
  await page.keyboard.press('Escape');
  await expect(origin).toBeFocused();
  await page.keyboard.press('/');
  await expect(origin).toBeFocused();
});
