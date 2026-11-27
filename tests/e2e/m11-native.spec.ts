import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertFits, test } from './browser';
import { button, csv, field, openSignoff, openStudio, pair, parseCsv, save, skuRow } from './m7-files';

const market = 'Price / UAE';
const compare = 'Compare At Price / UAE';
const shopIdentity = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Variant SKU'];
const shopHeaders = [...shopIdentity, 'Variant Price', 'Variant Compare At Price', market, compare,
  'Price / European Union', 'Compare At Price / European Union', 'Included / UAE', 'Variant Inventory Qty', 'Body (HTML)', 'Tags', 'Image Src'];
const shop = [
  shopHeaders,
  ['canvas', 'Canvas Tote', 'Size', 'S', 'Color', 'Green', '00123', '012.500', '020.00', '049.500', '70.00',
    '022.2500', '31.00', 'true', '0008', '<p>Retain,\nexactly</p>', 'green, summer', 'https://example.invalid/tote.jpg'],
  ['canvas', '', '', 'L', '', 'Green', '00124', '014.00', '', '060.000', '80.00',
    '025.25', '', 'true', '0010', '', '', ''],
  ['case', 'Case', 'Size', 'M', 'Color', 'White', '00888', '020.00', '', '', '',
    '018.990', '', 'false', '0002', 'Untouched', 'travel', ''],
];
const bigIdentity = ['Item Type', 'Product ID', 'Product Name', 'Product Code/SKU'];
const bigScope = [...bigIdentity, 'Price', 'Sale Price', 'Current Stock Level'];
const big = [
  [...bigScope, 'Track Inventory', 'Product Description', 'Category', 'Product Image File - 1', 'Meta Keywords'],
  ['Product', '101', 'Harbor mug', '00123', '20.00', '18.00', '24', 'by product', 'Synthetic ceramic mug', 'Home', 'harbor-mug.jpg', 'mug'],
  ['Product', '202', 'Ridge shirt', '00200', '32.00', '28.00', '18', 'by option', 'Synthetic cotton shirt', 'Apparel', 'ridge-shirt.jpg', 'shirt'],
  ['SKU', '203', '[RB]Size=Small', '00201', '32.00', '', '12', '', '', '', '', ''],
  ['SKU', '204', '[RB]Size=Large', '00202', '32.00', '', '6', '', '', '', '', ''],
];
const bigSupplier = csv('bigcommerce-supplier-synthetic.csv', [
  ['SKU', 'New Price', 'Sale Price', 'Stock'], ['00123', '24.00', '21.00', '30'], ['00201', '32.00', '', '10'],
]);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const confirm = (page: Page) => button(page, 'Confirm columns');
const jsonDownload = 'Download Full Diff Audit (.json)';
const csvDownload = 'Download Full Diff Audit (.csv)';
const clone = (matrix: string[][]) => matrix.map(row => [...row]);

// Apply the actual native bytes to a copy of the full catalog, independently of the application.
function overlay(original: string[][], [headers, ...records]: string[][], key: string, ignoreEmpty: boolean) {
  const result = clone(original);
  const keys = records.map(row => row[headers.indexOf(key)]);
  expect(new Set(keys).size).toBe(records.length);
  for (const [index, record] of records.entries()) {
    expect(record).toHaveLength(headers.length);
    const matches = result.slice(1).filter(row => row[original[0].indexOf(key)] === keys[index]);
    expect(matches, keys[index]).toHaveLength(1);
    for (const [column, header] of headers.entries()) {
      const position = original[0].indexOf(header);
      expect(position, header).toBeGreaterThanOrEqual(0);
      if (!ignoreEmpty || record[column] !== '') matches[0][position] = record[column];
    }
  }
  return result;
}

async function capture(page: Page, anchor: Locator, name: string) {
  await assertFits(page);
  if (process.env.IMPORT_MEDIC_CAPTURE_M11_SCREENSHOTS !== '1') return;
  await page.evaluate(() => document.fonts.ready);
  await anchor.evaluate(element => window.scrollBy(0, element.getBoundingClientRect().top - 18));
  const dir = resolve('docs/reports/screenshots/m11');
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, name + '.png'), animations: 'disabled' });
}

async function reviewGeometry(table: Locator, info: TestInfo, platform: string) {
  const result = await table.evaluate(element => {
    const frame = element.closest('.table-scroll')!.getBoundingClientRect();
    const inside = (rect: DOMRect, bounds: DOMRect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
    const clipped: string[] = [];
    for (const cell of element.querySelectorAll('tbody td')) {
      for (const value of cell.querySelectorAll('code, .price-row-status, .price-row-status + .price-row-detail')) {
        const text = value.firstChild as Text | null;
        if (!text) continue;
        for (const word of text.data.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(text, word.index);
          range.setEnd(text, word.index + word[0].length);
          const boxes = [...range.getClientRects()];
          if (boxes.length !== 1 || !inside(boxes[0], cell.getBoundingClientRect())) clipped.push(word[0]);
        }
      }
    }
    const controls = [...element.querySelectorAll('td:last-child, td:last-child label, td:last-child input, td:last-child button')];
    return { clipped, outsideReview: controls.filter(el => !inside(el.getBoundingClientRect(), frame)).map(el => ({
      text: el.textContent?.trim(), x: Math.round(el.getBoundingClientRect().x), right: Math.round(el.getBoundingClientRect().right),
    })), frameRight: Math.round(frame.right), columnCount: element.querySelectorAll('thead th').length };
  });
  info.annotations.push({ type: 'm11-review-geometry', description: JSON.stringify({ platform, ...result }) });
  expect(result.clipped).toEqual([]);
  expect(result.outsideReview).toEqual([]);
}

async function files(page: Page, info: TestInfo, platform: string, stem: string) {
  const stage = 'm11-' + platform;
  const update = await save(page, info, 'Download Safe ' + platform + ' Update CSV', stem + '-price-update.csv', stage);
  const rollback = await save(page, info, 'Download ' + platform + ' Rollback CSV', stem + '-price-rollback.csv', stage);
  const audit = JSON.parse((await save(page, info, jsonDownload, stem + '-price-diff.audit.json', stage)).text);
  const [headers, summary, ...rows] = parseCsv((await save(page, info, csvDownload, stem + '-price-diff.audit.csv', stage)).text);
  expect(headers.at(-1)).toBe('Review and Resolution (JSON)');
  const updateHash = hash(await readFile(update.path));
  const rollbackHash = hash(await readFile(rollback.path));
  expect(audit.custody).toMatchObject({ updateCsvSha256: updateHash, rollbackCsvSha256: rollbackHash });
  info.annotations.push({ type: 'm11-custody', description: JSON.stringify({ platform, ...audit.custody }) });
  return { audit, headers, summary, rows, update: parseCsv(update.text), rollback: parseCsv(rollback.text), updateHash, rollbackHash };
}

test('Shopify Markets applies confirmed USD to AED only to UAE and restores the full original catalog', async ({ page, beginProcessing }, info) => {
  await openStudio(page, beginProcessing);
  const original = csv('markets.csv', shop);
  const supplier = csv('usd.csv', [['SKU', 'Price'], ['00123', '10.00']]);
  await field(page, 'Choose Shopify baseline CSV').setInputFiles(original);
  await field(page, 'Choose supplier price sheet').setInputFiles(supplier);
  const target = field(page, 'Target price list');
  await expect(target.locator('option:checked')).toHaveText('Base store (Variant Price)');
  await expect(target.locator('option')).toHaveText(['Base store (Variant Price)', market, 'Price / European Union']);
  await target.selectOption({ label: market });
  await page.getByText('Pricing formula & rounding', { exact: true }).click();
  await field(page, 'Pricing mode').selectOption('multiplier');
  await field(page, 'Multiplier').fill('1.5');
  await field(page, 'Rounding').selectOption('ending-99');
  await field(page, 'Convert supplier currency (manual rate)').check();
  await field(page, 'Source currency code').fill('USD');
  await field(page, 'Target market currency code').fill('AED');
  await field(page, 'Exact rate').fill('3.6725');
  const fx = page.getByRole('checkbox', { name: /verified.*FX rate/ });
  await expect(fx).not.toBeChecked();
  await pair(page, 'Shopify', false);
  await fx.check();
  await confirm(page).click();
  await pair(page, 'Shopify', true);
  const table = page.getByRole('table', { name: 'Shopify price diff · Price / UAE', exact: true });
  await expect(table.getByRole('columnheader', { name: market + ' after', exact: true })).toBeVisible();
  await expect(skuRow(page, '00123')).toContainText('55.99');
  await expect(skuRow(page, '00123')).toContainText('3.6725');
  if (info.project.name === 'desktop') {
    await capture(page, page.locator('.price-search'), 'desktop-m11-shopify-markets');
    await reviewGeometry(table, info, 'Shopify Markets');
  }
  const output = await files(page, info, 'Shopify', 'markets');
  const expected = clone(shop);
  expected[1][shopHeaders.indexOf(market)] = '55.99';
  const project = (matrix: string[][]) => [[...shopIdentity, market], ...matrix.slice(1, 3).map(row => [...shopIdentity, market].map(column => row[shopHeaders.indexOf(column)]))];
  expect(output.update).toEqual(project(expected));
  expect(output.rollback).toEqual(project(shop));
  const applied = overlay(shop, output.update, 'Variant SKU', false);
  expect(applied).toEqual(expected);
  expect(csv('restored.csv', overlay(applied, output.rollback, 'Variant SKU', false)).buffer).toEqual(original.buffer);
  expect(output.audit.market).toMatchObject({ name: 'UAE', priceHeader: market, compareAtHeader: compare });
  expect(output.audit.custody).toMatchObject({ baselineSha256: hash(original.buffer), suppliers: [{ sha256: hash(supplier.buffer) }] });
  const row = output.rows.find(values => values[output.headers.indexOf('SKU')] === '00123')!;
  expect(row[output.headers.indexOf('Market')]).toBe('UAE');
  expect(row[output.headers.indexOf('New Price')]).toBe('55.99');
  expect(row.at(-2)).toBe('USD -> AED @ 3.6725');
  expect(JSON.parse(output.summary.at(-1)!)).toMatchObject({ market: { priceHeader: market } });
  const offline = await openSignoff(page, info, 'markets', 'm11-Shopify');
  await expect(offline.getByText(market, { exact: true })).toBeVisible();
  await expect(offline.getByText('55.99', { exact: true }).first()).toBeVisible();
  await offline.close();
  if (!await field(page, 'Multiplier').isVisible()) await page.getByText('Pricing formula & rounding', { exact: true }).click();
  await field(page, 'Multiplier').fill('2');
  if (!await fx.isChecked()) await fx.check();
  await confirm(page).click();
  await pair(page, 'Shopify', false);
  const held = JSON.parse((await save(page, info, jsonDownload, 'markets-price-diff.audit.json', 'm11-market-guard')).text);
  expect(held.issues).toContainEqual(expect.objectContaining({ code: 'compare-at-not-above-price', column: compare }));
  expect(held.custody).not.toHaveProperty('updateCsvSha256');
});

test('BigCommerce native Product and SKU patches, offline custody, paired replay and unsafe standalone candidates', async ({ page, beginProcessing }, info) => {
  await openStudio(page, beginProcessing);
  await button(page, 'BigCommerce').click();
  await button(page, 'Load Synthetic BigCommerce Demo').click();
  const original = csv('bigcommerce-baseline-synthetic.csv', big);
  for (const [label, header, index] of [
    ['Regular price column', 'New Price', '1'], ['Sale price column (optional)', 'Sale Price', '2'], ['Stock column (optional)', 'Stock', '3'],
  ]) {
    const column = field(page, label);
    await column.selectOption(index);
    await expect(column.locator('option:checked')).toContainText(header);
  }
  await confirm(page).click();
  const table = page.getByRole('table', { name: 'BigCommerce price diff', exact: true });
  await expect(button(page, 'Download Safe BigCommerce Update CSV')).toBeEnabled();
  await expect(skuRow(page, '00201')).toContainText('SKU · ID 203');
  await expect(table.getByRole('columnheader', { name: 'Stock after', exact: true })).toBeVisible();
  if (info.project.name === 'desktop') {
    await reviewGeometry(table, info, 'BigCommerce');
    const skip = skuRow(page, '00201').getByRole('checkbox', { name: 'Skip row' });
    await skip.check();
    await expect(skuRow(page, '00201')).toHaveAttribute('data-status', 'Skipped');
    await skip.uncheck();
    await expect(skuRow(page, '00201')).toHaveAttribute('data-status', 'Updated');
    await capture(page, page.locator('.price-search'), 'desktop-m11-bigcommerce-diff');
  }
  const stem = 'bigcommerce-baseline-synthetic';
  const output = await files(page, info, 'BigCommerce', stem);
  const native = (rollback: boolean) => [
    bigScope, [...big[1].slice(0, 4), ...(rollback ? ['20.00', '18.00', '24'] : ['24.00', '21.00', '30'])],
    [...big[2].slice(0, 4), '', '', ''], [...big[3].slice(0, 4), '', '', rollback ? '12' : '10'], [...big[4].slice(0, 4), '', '', ''],
  ];
  expect(output.update).toEqual(native(false));
  expect(output.rollback).toEqual(native(true));
  const expected = clone(big);
  expected[1].splice(4, 3, '24.00', '21.00', '30');
  expected[3][6] = '10';
  const applied = overlay(big, output.update, 'Product ID', true);
  expect(applied).toEqual(expected);
  expect(csv('restored.csv', overlay(applied, output.rollback, 'Product ID', true)).buffer).toEqual(original.buffer);
  expect(output.audit.custody).toMatchObject({ baselineSha256: hash(original.buffer), suppliers: [{ sha256: hash(bigSupplier.buffer) }] });
  expect(output.audit.rows).toContainEqual(expect.objectContaining({ sku: '00201', bigcommerce: expect.objectContaining({ id: '203', productId: '202' }), newInventoryQty: '10' }));
  const entry = output.rows.find(row => row[output.headers.indexOf('SKU')] === '00201')!;
  expect(entry[output.headers.indexOf('Product ID')]).toBe('203');
  expect(entry[output.headers.indexOf('New Stock')]).toBe('10');
  const offline = await openSignoff(page, info, stem, 'm11-BigCommerce');
  await expect(offline.getByRole('heading', { name: /BigCommerce Price Update/ })).toBeVisible();
  await expect(offline.getByText(/Ignore blank values/)).toBeVisible();
  for (const digest of [hash(original.buffer), hash(bigSupplier.buffer), output.updateHash, output.rollbackHash]) {
    await expect(offline.getByText(digest, { exact: true })).toBeVisible();
  }
  await offline.close();
  await page.getByRole('tab', { name: 'Verify Update / Rollback CSV' }).click();
  await page.getByTestId('verify-load-pair').click();
  const verdict = page.getByTestId('verify-verdict');
  const verifyHash = page.locator('.verify-report [data-custody-field="candidate"]');
  await expect(verdict).toHaveText('PASS');
  await expect(verifyHash).toHaveText(output.updateHash);
  await expect(page.getByTestId('verify-metric-changed-skus')).toHaveText('2');
  await expect(page.getByTestId('verify-metric-non-target-mutations')).toHaveText('0');
  await expect(page.getByTestId('verify-metric-broken-groups')).toHaveText('0');
  await page.getByTestId('verify-rollback').click();
  await expect(verdict).toHaveText('PASS');
  await expect(verifyHash).toHaveText(output.rollbackHash);
  await expect(page.getByTestId('verify-residual-diffs')).toHaveText('0 residual differences');
  if (info.project.name === 'mobile') await capture(page, page.locator('.verify-generated'), 'mobile-m11-bigcommerce');
  await button(page, 'Use local CSV files').click();
  await page.getByRole('combobox', { name: 'Store platform', exact: true }).selectOption('bigcommerce');
  await button(page, 'Load Synthetic BigCommerce Demo').click();
  await expect(verdict).toHaveText('PASS');
  await field(page, 'Choose baseline CSV').setInputFiles(original);
  const skuPrice = clone(output.update);
  skuPrice[3][4] = '34.00';
  const corruptSku = clone(output.update);
  corruptSku[1][3] = '123';
  const forbidden = output.update.map((row, i) => [...row, i === 0 ? 'Product Description' : '']);
  for (const [index, candidate] of [skuPrice, forbidden, corruptSku].entries()) {
    const unsafe = csv('unsafe-' + index + '.csv', candidate);
    await field(page, 'Choose update or rollback CSV').setInputFiles(unsafe);
    await page.getByTestId('verify-submit').click();
    await expect(verdict).toHaveText('FAIL_UNSAFE');
    await expect(verifyHash).toHaveText(hash(unsafe.buffer));
    await expect(page.getByTestId('verify-issues')).toContainText(['Price', 'Product Description', 'Product Code/SKU'][index]);
  }
});
