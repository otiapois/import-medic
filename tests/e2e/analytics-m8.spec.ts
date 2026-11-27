import { expect } from '@playwright/test';
import { assertFits, test } from './browser';
import { button, csv, field, openStudio } from './m7-files';
import { marker, metric, offlineReport, picture } from './m8-reports';

const buckets = ['< -20%', '-20% to -5%', '-5% to 0%', '0% (unchanged)', '0% to +5%', '+5% to +20%', '> +20%'];
// Each seven-row cohort has a $100 baseline and hits both exact 5% and 20% boundaries.
const costs = ['75.30', '80', '95', '100', '105', '120', '125', '75', '80', '95', '100', '104.60', '119.60', '124.60'];

for (const platform of ['Shopify', 'WooCommerce'] as const) {
  test(platform + ' rounded retail, landed margins, inventory and paginated watchlist survive actual offline sign-off', async ({ page, beginProcessing }, info) => {
    const woo = platform === 'WooCommerce';
    const skus = costs.map((_, i) => !woo && i === 0 ? 'SKU-' + marker : 'SKU-' + String(i + 1).padStart(2, '0'));
    await openStudio(page, beginProcessing);
    if (woo) await button(page, platform).click();
    const headers = woo ? ['ID', 'Type', 'SKU', 'Name', 'Parent', 'Regular price', 'Sale price', 'Stock']
      : ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Variant Inventory Qty'];
    const baseline = costs.map((_, i) => woo
      ? [String(i + 1), 'simple', skus[i], 'Coat ' + (i + 1), '', '100', i === 0 ? '50.00' : '', '10']
      : ['coat-' + i, 'Coat ' + (i + 1), 'Title', 'Default Title', skus[i], '100', '10']);
    await field(page, 'Choose ' + platform + ' baseline CSV').setInputFiles(csv('coats.csv', [headers, ...baseline]));
    await field(page, 'Choose supplier price sheet').setInputFiles(csv('wholesale.csv', [
      ['SKU', 'Cost', 'Stock'], ...costs.map((cost, i) => [skus[i], cost, '12']),
    ]));
    await field(page, woo ? 'Regular price column' : 'New price column').selectOption('1');
    await field(page, woo ? 'Stock column (optional)' : 'Inventory qty column (optional)').selectOption('2');
    await page.getByText('Pricing formula & rounding', { exact: true }).click();
    await field(page, 'Pricing mode').selectOption('multiplier');
    await field(page, 'Multiplier').fill('1');
    await field(page, 'Rounding').selectOption('nearest-whole');
    await button(page, 'Confirm columns').click();

    const panel = page.getByRole('region', { name: 'Batch Impact & Margin Summary' });
    const histogram = panel.getByRole('list', { name: 'Retail price movement buckets' }).getByRole('listitem');
    await expect(histogram).toHaveCount(7);
    for (const [i, bucket] of buckets.entries()) await expect(histogram.nth(i)).toHaveAccessibleName(bucket + ': 2');
    const average = woo ? '-3.54%' : '0.05%';
    const lowest = woo ? '-50.60%' : '-0.40%';
    for (const [label, value] of [['Average', average], ['Lowest', lowest], ['Highest', '0.38%'],
      ['Units before', '140'], ['Units after', '168'], ['Net unit change', '+28'], ['Newly zeroed', '0']]) await metric(panel, label, value);

    const chip = panel.getByRole('button', { name: /Zero \/ Negative Margin Alert/ });
    const table = page.getByRole('table', { name: platform + ' price diff' });
    const rows = table.locator('tbody tr');
    const pager = page.getByRole('navigation', { name: 'Pagination' });
    await expect(pager).toContainText('1–10 of 14');
    await expect(chip).toContainText('11');
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(pager).toContainText('1–10 of 11');
    await expect(rows.first()).toContainText(skus[0]);
    await expect(rows.first()).toContainText('75.30');
    await expect(rows.first()).toContainText(lowest);
    await assertFits(page);
    if (info.project.name === 'desktop') {
      const review = table.getByRole('columnheader', { name: 'Review', exact: true });
      const edit = rows.first().getByRole('button', { name: 'Edit price', exact: true });
      const layout = await table.evaluate(element => {
        const frame = element.closest('.table-scroll')!;
        const { left, right } = frame.getBoundingClientRect();
        return { left, right, scrollLeft: frame.scrollLeft };
      });
      const reviewBox = (await review.boundingBox())!;
      const editBox = (await edit.boundingBox())!;
      info.annotations.push({ type: 'm8-watchlist-layout', description: JSON.stringify({ layout, reviewBox, editBox }) });
      expect(layout.scrollLeft).toBe(0);
      for (const box of [reviewBox, editBox]) {
        expect(box.x).toBeGreaterThanOrEqual(layout.left - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(layout.right + 1);
      }
      await edit.click();
      await expect(edit).toHaveAttribute('aria-expanded', 'true');
      await rows.first().getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(edit).toHaveAttribute('aria-expanded', 'false');
    }
    if (!woo) await picture(page, panel, info.project.name === 'desktop' ? 'desktop-m8-margin-analytics' : 'mobile-m8-analytics');
    await pager.getByRole('button', { name: 'Next page' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('SKU-11');
    await expect(table.getByText('SKU-12', { exact: true })).toHaveCount(0);
    const search = page.getByRole('searchbox');
    await search.fill('SKU-14');
    await expect(page.getByText(/No rows match/i)).toBeVisible();
    await chip.click();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('SKU-14');
    const { report, source } = await offlineReport(page, info, 'Download Client Sign-Off (.html)', 'coats-client-sign-off.html');
    if (!woo) expect(source).toContain('&lt;audit-note');
    const analytics = report.getByRole('heading', { name: 'Batch Impact & Margin Summary' }).locator('..');
    for (const [label, value] of [['Average gross margin', average], ['Lowest gross margin', lowest], ['Highest gross margin', '0.38%'],
      ['Rows with a calculable margin', '14'], ['At or below landed cost', '11'], ['Inventory before', '140'], ['Inventory after', '168'],
      ['Net inventory change', '28'], ['Newly zeroed', '0']]) await metric(analytics, label, value);
    const distro = analytics.getByRole('table', { name: /movement among admitted matches/ });
    for (const bucket of buckets) await expect(distro.getByRole('rowheader', { name: bucket, exact: true }).locator('..').locator('td')).toHaveText('2');
    const watch = analytics.getByRole('table').last();
    await expect(watch.locator('tbody tr')).toHaveCount(11);
    const first = watch.getByRole('rowheader', { name: skus[0], exact: true }).locator('..');
    await expect(first.locator('td')).toHaveText([woo ? '50.00' : '75.00', '75.30', lowest]);
    await report.close();
  });
}
