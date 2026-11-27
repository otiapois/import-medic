import { expect } from '@playwright/test';
import { assertFits, editIssue, loadFile, m2Screenshot, test } from './browser';

test.beforeEach(async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
});

test('manual financial corrections leave automatic repair counts intact and source lines stay pinned during scroll', async ({ page, beginProcessing }, info) => {
  beginProcessing();
  await loadFile(page, 'shopify/legacy-compare-at-price.csv');
  const fixed = page.getByTestId('auto-fixed-count');
  const manual = page.getByTestId('manually-edited-count');
  await expect(manual).toHaveText('0');
  const autoBefore = await fixed.innerText();
  expect(Number(autoBefore)).toBeGreaterThan(0);
  await editIssue(page, 2, 'Variant Compare At Price', 'ask first', '38.00');
  await expect(manual).toHaveText('1');
  await expect(fixed).toHaveText(autoBefore);
  await loadFile(page, 'shopify/modern-shopify-headers.csv');
  await expect(manual).toHaveText('0');
  await page.getByRole('tab', { name: 'Before / After Table' }).click();
  if (info.project.name !== 'mobile') return;
  for (const title of ['Original CSV', 'Repaired CSV']) {
    const region = page.getByRole('region', { name: title + ' scrollable table' });
    await region.scrollIntoViewIfNeeded();
    const measures = () => region.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const head = element.querySelector('th[scope=col]')!.getBoundingClientRect();
      const row = element.querySelector('th[scope=row]')!.getBoundingClientRect();
      return {
        scroll: element.scrollLeft, left: bounds.left, right: bounds.right, headerX: head.left,
        rowX: row.left, rowRight: row.right, firstDataX: element.querySelector('td')!.getBoundingClientRect().left,
      };
    });
    const before = await measures();
    expect(before.scroll).toBe(0);
    await region.hover();
    await page.mouse.wheel(1400, 0);
    await expect.poll(async () => (await measures()).scroll).toBeGreaterThan(120);
    const after = await measures();
    expect(after.firstDataX).toBeLessThan(before.firstDataX - 100);
    expect(Math.abs(after.rowX - before.rowX)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.headerX - before.headerX)).toBeLessThanOrEqual(2);
    expect(after.rowX).toBeGreaterThanOrEqual(after.left);
    expect(after.rowRight).toBeLessThan(after.right);
    await expect(region.getByRole('rowheader', { name: '2', exact: true })).toBeInViewport();
  }
  await assertFits(page);
  await m2Screenshot(page, 'mobile-sticky-lines', 'Before / after comparison');
});

test('mixed Shopify and QuickBooks headers keep the selected platform until the visitor confirms a suggestion', async ({ page, beginProcessing }) => {
  beginProcessing();
  await loadFile(page, 'platform-suggestion/mixed-shopify-quickbooks.csv');
  const banner = page.getByRole('region', { name: 'Platform suggestion' });
  await expect(banner).toContainText('These headers fit more than one platform');
  await expect(banner.getByRole('button', { name: 'Use Shopify' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Shopify Products', selected: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'QuickBooks Bank' })).toHaveAttribute('aria-selected', 'false');
  await banner.getByRole('button', { name: 'Use QuickBooks' }).click();
  await expect(page.getByRole('tab', { name: 'QuickBooks Bank', selected: true })).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Repair results' })).toContainText('mixed-shopify-quickbooks.csv');
  await assertFits(page);
});
