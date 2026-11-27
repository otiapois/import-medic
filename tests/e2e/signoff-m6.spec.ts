import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import Papa from 'papaparse';
import { assertFits, test } from './browser';

const signoff = 'Download Client Sign-Off (.html)';
const title = '<script src="https://example.invalid/agency.js">A & B</script>';
const sku = '001<&"\'';
const csv = (name: string, rows: string[][]) => ({
  name, mimeType: 'text/csv', buffer: Buffer.from(Papa.unparse(rows, { newline: '\n' }), 'utf8'),
});

test('downloads an escaped offline sign-off from a synthetic agency comparison', async ({ page, beginProcessing }, info) => {
  await page.goto('/shopify-price-update-diff', { waitUntil: 'networkidle' });
  beginProcessing();
  await page.getByLabel('Choose Shopify baseline CSV').setInputFiles(csv('agency-signoff.csv', [
    ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Variant Compare At Price'],
    ['canvas', title, 'Size', 'S', sku, '20.00', '28.00'],
    ['canvas', '', '', 'L', '002', '22.00', ''],
    ['pouch', 'Travel Pouch', 'Title', 'Default Title', '003', '10.00', ''],
    ['hat', 'Hat', 'Title', 'Default Title', '004', '10.00', ''],
  ]));
  await page.getByLabel('Choose supplier price sheet').setInputFiles(csv('agency-supplier.csv', [
    ['SKU', 'Price'], [sku, '24.00'], ['002', '22.00'], ['003', '11.00'], ['004', '0'],
  ]));
  await page.getByRole('group', { name: 'Review supplier row 4', exact: true }).getByLabel('Skip row').check();
  await expect(page.getByRole('button', { name: 'Download Safe Shopify Update CSV', exact: true })).toBeDisabled();
  const button = page.getByRole('button', { name: signoff, exact: true });
  await expect(button).toBeEnabled();

  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(download.suggestedFilename()).toBe('agency-signoff-client-sign-off.html');
  const path = info.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  expect(await download.failure()).toBeNull();
  const html = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
  expect(html).toContain('001&lt;&amp;&quot;&#39;');
  expect(html).toContain('&lt;script src=&quot;https&#58;//example.invalid/agency.js&quot;&gt;A &amp; B&lt;/script&gt;');
  expect(html).not.toMatch(/https?:\/\/|<script\b/i);
  const offline = await page.context().newPage();
  await offline.goto(pathToFileURL(path).href);
  await assertFits(offline);
  const report = await offline.evaluate(() => {
    const doc = document;
    return {
      title: doc.title,
      metrics: Object.fromEntries([...doc.querySelectorAll('.summary div')].map(card =>
        [card.querySelector('dt')?.textContent, card.querySelector('dd')?.textContent])),
      names: [...doc.querySelectorAll('tbody tr > td:first-child')].map(cell => cell.textContent),
      productTitles: [...doc.querySelectorAll('tbody small')].map(element => element.textContent),
      csp: doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
    };
  });
  await offline.close();
  expect(report.title).toBe('Shopify Price Update — Client Sign-Off Summary');
  expect(report.metrics).toEqual({
    'Updated variants': '1', 'Skipped / unchanged': '1 / 1', 'Blocked / flagged': '1',
    'Avg price delta %': '20.00%', 'Pricing formula': 'Direct supplier price',
    'Rollback CSV pair': 'Unavailable for this comparison',
  });
  expect(report.names).toEqual(['004', sku]);
  expect(report.productTitles).toEqual(['Hat', title]);
  expect(report.csp?.split('; ')).toEqual(expect.arrayContaining(["default-src 'none'", "script-src 'none'", "connect-src 'none'"]));
});
