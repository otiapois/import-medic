import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Papa from 'papaparse';
import { assertFits, test } from './browser';

const native = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value',
  'Option3 Name', 'Option3 Value', 'Variant SKU', 'Variant Price'];
const inventory = 'Variant Inventory Qty';
const baseline = [
  [...native, inventory, 'Tags', 'Body (HTML)', 'Image Src', 'Variant Compare At Price'],
  ['canvas', '  Canvas, lined  ', 'Size', 'S', '', '', '', '', '00123', '040.000', '0019', 'new, summer', '<p>First\nline</p>', '', '052.00'],
  ['canvas', '', '', 'XL', '', '', '', '', '00045-XL', '023.000', '0007', '', '', '', ''],
  ['canvas', '', '', 'L', '', '', '', '', 'SIBLING', '025.00', '0000', '', '', '', '035.00'],
  ['canvas', '', '', '', '', '', '', '', '', '', '', '', '', 'https://shop.invalid/image.jpg', ''],
  ['pouch', 'Pouch', 'Title', 'Default Title', '', '', '', '', 'AGENCY-NEW', '12.00', '3', 'retained', '', '', ''],
];
const csv = (name: string, rows: string[][]) => ({
  name, mimeType: 'text/csv', buffer: Buffer.from(Papa.unparse(rows, { newline: '\r\n' }), 'utf8'),
});
const baselineUpload = csv('canvas-store.csv', baseline);
const csvSupplier = csv('west.csv', [
  ['SKU', 'Price', 'Stock', 'Notes'], ['00123', '36.00', '12.5', 'Cotton\nouterwear'], ['00045-XL', '26.00', '7', ''],
]);
const workbook = resolve('fixtures/shopify-price-diff/supplier-agency.xlsx');
const skuRow = (page: Page, sku: string) => page.getByRole('row').filter({ has: page.getByRole('rowheader').getByText(sku, { exact: true }) });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const add = (page: Page) => button(page, '+ Add another supplier sheet');
const conflictPolicy = (page: Page) => page.getByLabel('Supplier conflict policy', { exact: true });
const confirmPolicy = (page: Page) => button(page, 'Confirm supplier conflict policy');
const formats = {
  update: ['Download Safe Shopify Update CSV', 'price-update.csv'],
  rollback: ['Download Shopify Rollback CSV', 'price-rollback.csv'],
  csvAudit: ['Download Full Diff Audit (.csv)', 'price-diff.audit.csv'],
  jsonAudit: ['Download Full Diff Audit (.json)', 'price-diff.audit.json'],
  signoff: ['Download Client Sign-Off (.html)', 'client-sign-off.html'],
} as const;

async function openBatch(page: Page, beginProcessing: () => void) {
  await page.goto('/shopify-price-update-diff', { waitUntil: 'networkidle' });
  beginProcessing();
  await page.getByLabel('Choose Shopify baseline CSV', { exact: true }).setInputFiles(baselineUpload);
  await page.getByLabel('Choose supplier price sheet', { exact: true }).setInputFiles(csvSupplier);
}

async function pair(page: Page, ready: boolean) {
  for (const [label] of [formats.update, formats.rollback]) {
    if (ready) await expect(button(page, label)).toBeEnabled();
    else await expect(button(page, label)).toBeDisabled();
  }
}

async function download(page: Page, info: TestInfo, format: keyof typeof formats) {
  const [label, suffix] = formats[format];
  const [file] = await Promise.all([page.waitForEvent('download'), button(page, label).click()]);
  expect(file.suggestedFilename()).toBe('canvas-store-' + suffix);
  const destination = process.env.IMPORT_MEDIC_M6_DOWNLOADS;
  const path = destination
    ? resolve(destination, info.project.name, info.title.split(' ')[0].toLowerCase(), file.suggestedFilename())
    : info.outputPath(file.suggestedFilename());
  await mkdir(dirname(path), { recursive: true });
  await file.saveAs(path);
  expect(await file.failure()).toBeNull();
  const bytes = await readFile(path);
  expect(bytes.length).toBeGreaterThan(0);
  expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  return { path, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
}

function parse(text: string) {
  const parsed = Papa.parse<string[]>(text, { delimiter: ',', skipEmptyLines: true });
  expect(parsed.errors).toEqual([]);
  return parsed.data;
}

// Rebuild the user's entire original matrix from actual download cells, including the untouched image and product.
// Identity is the handle and three exact option values; present native cells are all applied, even if blank.
function overlay(current: string[][], [head, ...patches]: string[][]) {
  const result = current.map(row => [...row]);
  for (const row of patches) {
    const identity = ['Handle', 'Option1 Value', 'Option2 Value', 'Option3 Value'];
    const matched = result.slice(1).filter(original => identity.every(col => original[current[0].indexOf(col)] === row[head.indexOf(col)]));
    expect(matched).toHaveLength(1);
    expect(row).toHaveLength(head.length);
    head.forEach((column, index) => { matched[0][current[0].indexOf(column)] = row[index]; });
  }
  return result;
}

async function checkPair(page: Page, info: TestInfo, prices: string[], qty?: string[]) {
  const update = parse((await download(page, info, 'update')).text);
  const rollback = parse((await download(page, info, 'rollback')).text);
  const headers = qty ? [...native, inventory] : native;
  const original = parse(new TextDecoder().decode(baselineUpload.buffer));
  const expected = original.map(row => [...row]);
  prices.forEach((price, i) => { expected[i + 1][native.indexOf('Variant Price')] = price; });
  qty?.forEach((stock, i) => { expected[i + 1][original[0].indexOf(inventory)] = stock; });
  const extractGroup = (rows: string[][]) => [headers, ...rows.slice(1, 4).map(row => headers.map(header => row[original[0].indexOf(header)]))];
  expect(update).toEqual(extractGroup(expected));
  expect(rollback).toEqual(extractGroup(original));
  const applied = overlay(original, update);
  expect(applied).toEqual(expected);
  const restored = overlay(applied, rollback);
  expect(csv('restored.csv', restored).buffer.equals(baselineUpload.buffer)).toBe(true);
}

async function picture(page: Page, info: TestInfo, name: string, anchor: Locator) {
  if (process.env.IMPORT_MEDIC_CAPTURE_M6_SCREENSHOTS !== '1') return;
  const dir = resolve('docs/reports/screenshots/m6');
  await mkdir(dir, { recursive: true });
  await assertFits(page);
  await page.evaluate(() => document.fonts.ready);
  await anchor.evaluate(element => window.scrollBy(0, element.getBoundingClientRect().top - 20));
  await page.screenshot({ path: resolve(dir, info.project.name + '-m6-' + name + '.png'), animations: 'disabled' });
}

const contenders = [
  { sku: '00123', csvRow: 2, csvPrice: '36.00', xlsRow: 2, xlsPrice: '40.00', winner: 'West Supply', winnerFile: 'west.csv', price: '36.00' },
  { sku: '00045-XL', csvRow: 4, csvPrice: '26.00', xlsRow: 5, xlsPrice: '24.00', winner: 'Agency East', winnerFile: 'supplier-agency.xlsx', price: '24.00' },
];

test('Two suppliers block conflicting source rows and confirm the lowest exact prices before issuing the verified pair', async ({ page, beginProcessing }, info) => {
  await openBatch(page, beginProcessing);
  await add(page).click();
  await page.getByLabel('Choose supplier price sheet 2', { exact: true }).setInputFiles(workbook);
  const sources = page.getByRole('list', { name: 'Supplier sheet order' }).getByRole('listitem');
  await expect(sources.nth(0)).toContainText('2 rows in selected sheet');
  await expect(sources.nth(1)).toContainText('3 rows in selected sheet');
  await page.getByLabel('Supplier sheet label 1', { exact: true }).fill('West Supply');
  await page.getByLabel('Supplier sheet label 2', { exact: true }).fill('Agency East');
  await expect(conflictPolicy(page)).toHaveValue('block-conflicts');
  await pair(page, false);
  for (const { sku, csvRow, csvPrice, xlsRow, xlsPrice } of contenders) {
    const row = skuRow(page, sku);
    await expect(row).toHaveAttribute('data-status', 'Blocked');
    const evidence = row.locator('.price-source-contenders > li');
    await expect(evidence).toHaveCount(2);
    await expect(evidence.nth(0)).toContainText('West Supply · row ' + csvRow);
    await expect(evidence.nth(0)).toContainText('west.csv');
    await expect(evidence.nth(0)).toContainText('Price ' + csvPrice);
    await expect(evidence.nth(1)).toContainText('Agency East · row ' + xlsRow);
    await expect(evidence.nth(1)).toContainText('supplier-agency.xlsx · Agency prices');
    await expect(evidence.nth(1)).toContainText('Price ' + xlsPrice);
  }
  if (info.project.name === 'desktop') {
    await picture(page, info, 'multi-supplier-conflict', conflictPolicy(page).locator('..'));
  } else {
    const sourceColumn = page.getByRole('columnheader', { name: 'Supplier source', exact: true });
    await sourceColumn.evaluate(element => {
      const scroller = element.closest('.table-scroll')!;
      const first = element.parentElement!.firstElementChild!;
      scroller.scrollLeft += element.getBoundingClientRect().left - scroller.getBoundingClientRect().left - first.getBoundingClientRect().width;
    });
    await picture(page, info, 'multi-supplier', page.getByRole('heading', { name: 'Before / after price diff' }));
  }
  await conflictPolicy(page).selectOption({ label: 'Prefer lowest price' });
  await expect(confirmPolicy(page)).toBeEnabled();
  await pair(page, false);
  await confirmPolicy(page).click();
  await pair(page, true);
  await checkPair(page, info, ['36.00', '24.00', '025.00']);
  const audit = JSON.parse((await download(page, info, 'jsonAudit')).text);
  const [head, ...rows] = parse((await download(page, info, 'csvAudit')).text);
  const report = await download(page, info, 'signoff');
  expect(report.text).not.toMatch(/<script\b|https?:\/\//i);
  const offline = await page.context().newPage();
  await offline.goto(pathToFileURL(report.path).href);
  await assertFits(offline);
  await expect(offline.getByText('Supplier updates', { exact: true }).locator('..')).toContainText('West Supply (1) · Agency East (1)');
  expect(audit.rollbackVerification).toMatchObject({ checked: true, restoredVariants: 3 });
  for (const { sku, csvRow, csvPrice, xlsRow, xlsPrice, winner, winnerFile, price } of contenders) {
    await expect(skuRow(page, sku).locator('.price-source-badge')).toHaveText(winner);
    const jsonRow = audit.rows.find((row: { sku: string }) => row.sku === sku);
    const csvRowValues = rows.find(row => row[head.indexOf('SKU')] === sku)!;
    const sourceRows = [
      { label: 'West Supply', filename: 'west.csv', worksheet: 'west.csv', row: csvRow, price: csvPrice },
      { label: 'Agency East', filename: 'supplier-agency.xlsx', worksheet: 'Agency prices', row: xlsRow, price: xlsPrice },
    ];
    expect(jsonRow).toMatchObject({ newPrice: price, supplierSource: winner, supplierFilename: winnerFile, supplierContenders: sourceRows });
    expect(csvRowValues[head.indexOf('Supplier Source')]).toBe(winner);
    expect(csvRowValues[head.indexOf('New Price')]).toBe(price);
    expect(JSON.parse(csvRowValues[head.indexOf('Supplier Contenders (JSON)')])).toEqual(jsonRow.supplierContenders);
    const reportRow = offline.getByRole('row').filter({ has: offline.getByRole('cell', { name: sku, exact: true }) });
    await expect(reportRow).toContainText(winner);
    await expect(reportRow).toContainText('Row ' + csvRow + ' · Price: ' + csvPrice);
    await expect(reportRow).toContainText('Row ' + xlsRow + ' · New Price: ' + xlsPrice);
  }
  await offline.close();
  await button(page, 'Move supplier sheet 2 up').click();
  await expect(page.getByLabel('Supplier sheet label 1')).toHaveValue('Agency East');
  await expect(confirmPolicy(page)).toBeEnabled();
  await pair(page, false);
  await add(page).click();
  await expect(sources).toHaveCount(3);
  await expect(add(page)).toBeDisabled();
  await button(page, 'Remove supplier sheet 3').click();
  await expect(sources).toHaveCount(2);
});

test('Renaming suppliers during worksheet loading completes the original upload and shows its conflicts', async ({ page, context, beginProcessing }) => {
  await openBatch(page, beginProcessing);
  await pair(page, true);
  await add(page).click();
  let signalRequest!: () => void;
  let releaseRequest!: () => void;
  const requested = new Promise<void>(resolve => { signalRequest = resolve; });
  const release = new Promise<void>(resolve => { releaseRequest = resolve; });
  await context.route('**/assets/diff.worker-*.js', async route => {
    signalRequest();
    await release;
    await route.fallback();
  });
  try {
    await page.getByLabel('Choose supplier price sheet 2', { exact: true }).setInputFiles(workbook);
    await requested;
    await page.getByLabel('Supplier sheet label 1', { exact: true }).fill('West Supply');
    await page.getByLabel('Supplier sheet label 2', { exact: true }).fill('Agency East');
  } finally {
    releaseRequest();
  }
  const sources = page.getByRole('list', { name: 'Supplier sheet order' }).getByRole('listitem');
  await expect(sources.nth(0)).toContainText('2 rows in selected sheet');
  await expect(sources.nth(1)).toContainText('3 rows in selected sheet');
  await expect(conflictPolicy(page)).toHaveValue('block-conflicts');
  await expect(skuRow(page, '00045-XL')).toContainText('Agency East · row 5');
  await pair(page, false);
});

test('Mapped stock rejects a fractional quantity and preserves padded originals and siblings after inline repair', async ({ page, beginProcessing }, info) => {
  await openBatch(page, beginProcessing);
  const stock = page.getByLabel('Inventory qty column (optional)', { exact: true });
  await expect(stock.locator('option:checked')).toHaveText('Leave unchanged');
  await stock.selectOption('2');
  await button(page, 'Confirm columns').click();
  const row = skuRow(page, '00123');
  await expect(row).toHaveAttribute('data-status', 'Blocked');
  await expect(row).toContainText('Supplier qty 12.5');
  await pair(page, false);
  await row.getByRole('button', { name: 'Edit price', exact: true }).click();
  const override = row.getByLabel('Override inventory qty', { exact: true });
  await expect(override).toHaveValue('12.5');
  await override.fill('12');
  await row.getByRole('button', { name: 'Apply override', exact: true }).click();
  await pair(page, true);
  await expect(row).toHaveAttribute('data-status', 'Updated');
  await expect(row.getByRole('cell', { name: '0019', exact: true })).toBeVisible();
  await expect(row.getByRole('cell', { name: '12', exact: true })).toBeVisible();
  if (info.project.name === 'desktop') await picture(page, info, 'inventory-ready', page.getByRole('heading', { name: 'Before / after price diff' }));
  await checkPair(page, info, ['36.00', '26.00', '025.00'], ['12', '0007', '0000']);
  const audit = JSON.parse((await download(page, info, 'jsonAudit')).text);
  expect(audit.rows.find((r: { sku: string }) => r.sku === '00123')).toMatchObject({
    supplierInventoryQty: '12.5', oldInventoryQty: '0019', newInventoryQty: '12', resolution: { inventoryQty: '12' },
  });
  const report = await download(page, info, 'signoff');
  const offline = await page.context().newPage();
  await offline.goto(pathToFileURL(report.path).href);
  await assertFits(offline);
  await expect(offline.getByText('Inventory changes', { exact: true }).locator('..')).toContainText('1');
  await expect(offline.getByRole('cell', { name: '0019 → 12', exact: true })).toBeVisible();
  await offline.close();
  await row.getByRole('button', { name: 'Edit price', exact: true }).click();
  await override.fill('0');
  await row.getByRole('button', { name: 'Apply override', exact: true }).click();
  await pair(page, false);
  await row.getByRole('button', { name: 'Confirm proposed inventory qty', exact: true }).click();
  await pair(page, true);
});

test('Sign-off keeps each supplier formula and exact manual FX rate attached to its source', async ({ page, beginProcessing }, info) => {
  await openBatch(page, beginProcessing);
  await add(page).click();
  await page.getByLabel('Choose supplier price sheet 2', { exact: true }).setInputFiles(csv('euro.csv', [
    ['SKU', 'Price'], ['SIBLING', '12.00'],
  ]));
  const euro = page.getByRole('group', { name: 'Settings for euro.csv', exact: true });
  await euro.getByText('Pricing formula & rounding', { exact: true }).click();
  await euro.getByLabel('Pricing mode', { exact: true }).selectOption('multiplier');
  await euro.getByLabel('Multiplier', { exact: true }).fill('2');
  await euro.getByLabel('Convert supplier currency (manual rate)', { exact: true }).check();
  await euro.getByLabel('Source currency code', { exact: true }).fill('EUR');
  await euro.getByLabel('Store currency code', { exact: true }).fill('USD');
  await euro.getByLabel('Exact rate', { exact: true }).fill('1.1000');
  await euro.getByRole('checkbox', { name: /verified.*FX rate/ }).check();
  await euro.getByRole('button', { name: 'Confirm columns', exact: true }).click();
  await pair(page, true);
  const html = await download(page, info, 'signoff');
  const offline = await page.context().newPage();
  await offline.goto(pathToFileURL(html.path).href);
  await assertFits(offline);
  const description = await offline.getByText('Pricing formula', { exact: true }).locator('..').locator('dd').innerText();
  const [direct, fx] = description.split(' | ');
  expect(direct).toBe('west.csv · Direct supplier price');
  expect(fx).toContain('euro.csv · Multiplier × 2');
  expect(fx).toContain('EUR → USD × 1.1000');
  const converted = offline.getByRole('row').filter({ has: offline.getByRole('cell', { name: 'SIBLING', exact: true }) });
  await expect(converted).toContainText('26.40');
  await expect(converted).toContainText('euro.csv');
  await offline.close();
});
