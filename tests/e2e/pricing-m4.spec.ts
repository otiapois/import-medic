import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import Papa from 'papaparse';
import { assertFits, downloadText, test } from './browser';

const route = '/shopify-price-update-diff';
const update = 'Download Safe Shopify Update CSV';
const rollback = 'Download Shopify Rollback CSV';
const save = 'Save Supplier Recipe (.json)';
const confirm = 'Confirm columns';
const price = 'Variant Price';
const compare = 'Variant Compare At Price';
const legacyCompare = 'Compare-at price';
const identity = ['Handle', 'Option1 Value', 'Option2 Value', 'Option3 Value'];
const native = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value',
  'Option3 Name', 'Option3 Value', 'Variant SKU', price];
const baseline = [
  [...native, legacyCompare, 'Body (HTML)', 'Tags'],
  ['canvas', '  Canvas Coat  ', 'Size', 'Small', 'Color', 'Navy', '', '', '00041', '20.000', '', '<p>café, canvas</p>', 'winter,sale'],
  ['canvas', '', '', 'Medium', '', 'Navy', '', '', '00042', '21.500', '30.000', '', ''],
  ['canvas', '', '', 'Large', '', 'Navy', '', '', '00043', '23', '', '', ''],
  ['linen', 'Linen Shirt', 'Size', 'Small', 'Color', 'Navy', '', '', '00077', '18.250', '26.000', 'untouched', 'summer'],
];
const file = (name: string, text: string) => ({ name, mimeType: name.endsWith('.json') ? 'application/json' : 'text/csv', buffer: Buffer.from(text, 'utf8') });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const formula = (page: Page) => page.getByText('Pricing formula & rounding', { exact: true });
const rule = { mode: 'multiplier', multiplier: '2.2', rounding: 'ending-99' };

async function start(page: Page, begin: () => void, supplier: string[][]) {
  await page.goto(route, { waitUntil: 'networkidle' });
  begin();
  await page.getByLabel('Choose Shopify baseline CSV').setInputFiles(file('catalog.csv', Papa.unparse(baseline)));
  await page.getByLabel('Choose supplier price sheet').setInputFiles(file('batch1.csv', Papa.unparse(supplier)));
}

async function setMultiplier(page: Page) {
  await formula(page).click();
  await page.getByLabel('Pricing mode', { exact: true }).selectOption('multiplier');
  await page.getByLabel('Multiplier', { exact: true }).fill('2.2');
  await page.getByLabel('Rounding', { exact: true }).selectOption('ending-99');
}

async function assertPair(page: Page, enabled: boolean) {
  for (const name of [update, rollback]) {
    if (enabled) await expect(button(page, name)).toBeEnabled();
    else await expect(button(page, name)).toBeDisabled();
  }
}

function parseCsv(text: string) {
  const csv = Papa.parse<string[]>(text, { delimiter: ',' });
  expect(csv.errors).toEqual([]);
  return csv.data;
}

// Match the downloaded variant by its native handle and three option values.
// The fixture deliberately spells the baseline compare-at header differently.
function overlay(matrix: string[][], [headers, ...rows]: string[][]) {
  const [columns, ...catalog] = matrix;
  const key = (row: string[], headings: string[]) => JSON.stringify(identity.map((field) => row[headings.indexOf(field)]));
  const patches = new Map(rows.map((row) => [key(row, headers), row]));
  expect(patches.size).toBe(rows.length);
  const result = catalog.map((row) => {
    const originalKey = key(row, columns);
    const patch = patches.get(originalKey);
    if (!patch) return row;
    patches.delete(originalKey);
    const cells = [...row];
    for (const [index, header] of headers.entries()) {
      const position = columns.indexOf(header === compare ? legacyCompare : header);
      expect(position, header).toBeGreaterThanOrEqual(0);
      cells[position] = patch[index];
    }
    return cells;
  });
  expect(patches.size).toBe(0);
  return [columns, ...result];
}

async function downloadPair(page: Page, expectedPrice: string, expectedCompare?: string) {
  const after = parseCsv(await downloadText(page, update, 'catalog-price-update.csv'));
  const before = parseCsv(await downloadText(page, rollback, 'catalog-price-rollback.csv'));
  const headers = expectedCompare === undefined ? native : [...native, compare];
  const scopedRows = baseline.slice(1, 4).map((row) => row.slice(0, headers.length));
  const updatedRows = scopedRows.map((row) => [...row]);
  updatedRows[0][native.indexOf(price)] = expectedPrice;
  if (expectedCompare !== undefined) updatedRows[0][headers.indexOf(compare)] = expectedCompare;
  expect(after).toEqual([headers, ...updatedRows]);
  expect(before).toEqual([headers, ...scopedRows]);
  const expected = baseline.map((row) => [...row]);
  expected[1][baseline[0].indexOf(price)] = expectedPrice;
  if (expectedCompare !== undefined) expected[1][baseline[0].indexOf(legacyCompare)] = expectedCompare;
  const applied = overlay(baseline, after);
  expect(applied).toEqual(expected);
  expect(overlay(applied, before)).toEqual(baseline);
  return before.length - 1;
}

async function capture(page: Page, info: TestInfo, anchor: Locator, name: string, top = 24) {
  await assertFits(page);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  info.annotations.push({ type: 'm4-document-width', description: JSON.stringify({ name, width }) });
  if (process.env.IMPORT_MEDIC_CAPTURE_M4_SCREENSHOTS !== '1') return;
  await anchor.evaluate((element, y) => window.scrollBy(0, element.getBoundingClientRect().top - y), top);
  await page.evaluate(() => document.fonts.ready);
  const directory = resolve('docs/reports/screenshots/m4');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, name + '.png'), animations: 'disabled' });
}

test('wholesale pricing and compare-at produce paired downloads that restore the exact catalog', async ({ page, beginProcessing }, info) => {
  await start(page, beginProcessing, [['SKU', 'New Price', 'List'], ['00041', '10.00', '34.50']]);
  await page.getByLabel('Compare-at price column').selectOption('2');
  await setMultiplier(page);
  const preview = page.getByRole('status').filter({ hasText: 'Supplier row 2' });
  await expect(preview).toHaveText('Supplier row 2 10.00 → 22.99');
  await assertPair(page, false);
  await button(page, confirm).click();
  await assertPair(page, true);
  await expect(page.getByText('Active · Multiplier · End in .99', { exact: true })).toBeVisible();
  await expect(preview).toHaveText('Supplier row 2 10.00 → 22.99');
  await capture(page, info, formula(page), info.project.name === 'desktop' ? 'desktop-m4-pricing-formula' : 'mobile-m4-pricing');
  const table = page.getByRole('table', { name: 'Shopify price diff' });
  const headings = await table.getByRole('columnheader').allTextContents();
  const cells = table.getByRole('row').filter({ has: page.getByRole('rowheader').filter({ hasText: '00041' }) }).locator('th,td');
  for (const [field, value] of Object.entries({ Before: '20.000', 'Supplier raw': '10.00', 'Computed price': '22.99', After: '22.99', 'Compare-at after': '34.50' })) {
    expect(headings).toContain(field);
    await expect(cells.nth(headings.indexOf(field))).toHaveText(value);
  }
  if (info.project.name === 'desktop') {
    await capture(page, info, page.getByRole('heading', { name: 'Download the update, rollback, and audit' }), 'desktop-m4-rollback-ready', 495);
  }
  const restored = await downloadPair(page, '22.99', '34.50');
  await expect(page.getByText('Local rollback check · 3 variants restored to baseline.', { exact: true })).toBeVisible();
  const audit = JSON.parse(await downloadText(page, 'Download Full Diff Audit (.json)', 'catalog-price-diff.audit.json'));
  expect(audit.pricingRule).toEqual(rule);
  expect(audit.verification).toEqual({ checked: true, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 });
  expect(audit.rollbackVerification).toEqual({ checked: true, restoredVariants: restored });
  expect(audit.columns).toEqual({ included: [...native, compare], omittedBaselineHeaders: ['Body (HTML)', 'Tags'], compareAtMapped: true });
  expect(audit.rows).toHaveLength(baseline.length - 1);
  const [first] = audit.rows;
  expect(first).toMatchObject({ sku: '00041', status: 'Updated', supplierRow: 2, baselineRow: 2, supplierPrice: '10.00', computedPrice: '22.99', newPrice: '22.99',
    oldPrice: '20.000', oldCompareAtPrice: '', supplierCompareAtPrice: '34.50', newCompareAtPrice: '34.50', compareAtOutput: 'value' });
  expect(first.baselineCells.map((cell: { value: string }) => cell.value)).toEqual(baseline[1]);
  expect(first.supplierCells.map((cell: { value: string }) => cell.value)).toEqual(['00041', '10.00', '34.50']);
  const [auditHeaders, summary, ...rows] = parseCsv(await downloadText(page, 'Download Full Diff Audit (.csv)', 'catalog-price-diff.audit.csv'));
  expect(rows).toHaveLength(audit.rows.length);
  expect(JSON.parse(summary.at(-1)!)).toMatchObject({ pricingRule: rule, rollbackVerification: audit.rollbackVerification });
  const csvRow = Object.fromEntries(auditHeaders.map((header, index) => [header, rows[0][index]]));
  expect(csvRow).toMatchObject({ SKU: '00041', 'Old Price': '20.000', 'Raw Supplier Price': '10.00', 'Computed Price': '22.99', 'New Price': '22.99',
    'Old Compare At Price': '', 'New Compare At Price': '34.50', 'Raw Supplier Compare At Price': '34.50', 'Compare At Output': 'value' });
  expect(JSON.parse(csvRow['Original Baseline Cells (JSON)'])).toEqual(first.baselineCells);
  expect(JSON.parse(csvRow['Original Supplier Cells (JSON)'])).toEqual(first.supplierCells);
  await button(page, 'Edit price').click();
  await page.getByLabel('Override price', { exact: true }).fill('24.75');
  await button(page, 'Apply override').click();
  await expect(cells.nth(headings.indexOf('Computed price'))).toHaveText('22.99');
  await expect(cells.nth(headings.indexOf('After'))).toContainText('24.75');
  await expect(cells.nth(headings.indexOf('After'))).toContainText('Manual override');
  await downloadPair(page, '24.75', '34.50');
  const revised = JSON.parse(await downloadText(page, 'Download Full Diff Audit (.json)', 'catalog-price-diff.audit.json'));
  expect(revised.rows[0]).toMatchObject({ supplierPrice: '10.00', computedPrice: '22.99', newPrice: '24.75', resolution: { price: '24.75' } });
});

test('a saved v2 recipe on reordered Batch 2 and a subsequent v1 import each require fresh confirmation', async ({ page, beginProcessing }) => {
  await start(page, beginProcessing, [['SKU', 'New Price', 'Notes'], ['00041', '10.00', 'batch one']]);
  await setMultiplier(page);
  await button(page, confirm).click();
  await assertPair(page, true);
  await page.getByLabel('Supplier label').fill('North Supply');
  await page.getByLabel('Store label (optional)').fill('Loft');
  const recipeName = 'north-supply-supplier-recipe.json';
  const saved = await downloadText(page, save, recipeName);
  const shared = { supplierLabel: 'North Supply', joinKey: { type: 'sku', skuColumn: 'SKU' }, priceColumn: 'New Price', compareAtColumn: null,
    sheetName: null, dropThresholdPercent: 50, increaseThresholdPercent: 200, formulaGuard: false };
  expect(JSON.parse(saved)).toEqual({ ...shared, version: 2, storeLabel: 'Loft', pricingRule: rule });
  await page.getByLabel('Choose supplier price sheet').setInputFiles(file('batch2.csv', 'Notes,New Price,SKU\nsecond batch,12.50,00041'));
  const load = page.getByLabel('Load Supplier Recipe (.json)');
  const panel = page.getByRole('region', { name: 'Supplier recipe' });
  await load.setInputFiles(file(recipeName, saved));
  await expect(panel.getByRole('status')).toContainText('Recipe needs review: North Supply');
  await expect(page.getByLabel('SKU column')).toHaveValue('2');
  await expect(page.getByLabel('New price column')).toHaveValue('1');
  await expect(page.getByLabel('Store label (optional)')).toHaveValue('Loft');
  await formula(page).click();
  await expect(page.getByLabel('Pricing mode', { exact: true })).toHaveValue('multiplier');
  await expect(page.getByLabel('Multiplier', { exact: true })).toHaveValue('2.2');
  await expect(page.getByLabel('Rounding', { exact: true })).toHaveValue('ending-99');
  await expect(page.getByRole('status').filter({ hasText: 'Supplier row 2' })).toHaveText('Supplier row 2 12.50 → 27.99');
  await assertPair(page, false);
  await button(page, confirm).click();
  await expect(panel.getByRole('status')).toHaveText('Recipe applied: North Supply.');
  await downloadPair(page, '27.99');
  const v1 = { ...shared, version: 1, supplierLabel: 'Legacy Supply' };
  await load.setInputFiles(file('legacy.json', JSON.stringify(v1)));
  await expect(panel.getByRole('status')).toContainText('Recipe needs review: Legacy Supply');
  await expect(page.getByLabel('Store label (optional)')).toHaveValue('');
  await formula(page).click();
  await expect(page.getByLabel('Pricing mode', { exact: true })).toHaveValue('direct');
  await expect(page.getByLabel('Rounding', { exact: true })).toHaveValue('');
  await assertPair(page, false);
  await button(page, confirm).click();
  await expect(panel.getByRole('status')).toHaveText('Recipe applied: Legacy Supply.');
  await downloadPair(page, '12.50');
  expect(JSON.parse(await downloadText(page, save, 'legacy-supply-supplier-recipe.json'))).toEqual(v1);
});

test('100 percent margin invalidates a ready pair and final transformed price drives the movement guard', async ({ page, beginProcessing }) => {
  await start(page, beginProcessing, [['SKU', 'New Price'], ['00041', '12.50']]);
  await formula(page).click();
  await page.getByLabel('Pricing mode', { exact: true }).selectOption('target-margin');
  const margin = page.getByLabel('Target margin (%)');
  await margin.fill('25');
  await button(page, confirm).click();
  await assertPair(page, true);
  const downloads: string[] = [];
  page.on('download', (item) => downloads.push(item.suggestedFilename()));
  await margin.fill('100');
  for (const name of [confirm, update, rollback]) {
    expect(await button(page, name).isDisabled(), name).toBe(true);
    await button(page, name).evaluate((element: HTMLButtonElement) => element.click());
  }
  await expect(page.getByRole('alert').filter({ hasText: 'below 100%' })).toBeVisible();
  await margin.fill('85');
  await assertPair(page, false);
  await button(page, confirm).click();
  const row = page.getByRole('table', { name: 'Shopify price diff' }).locator('tbody tr').filter({ hasText: '00041' });
  await expect(row).toContainText('83.33');
  await expect(row).toContainText('This price increases more than the selected threshold.');
  await assertPair(page, false);
  expect(downloads).toEqual([]);
  await margin.fill('50');
  await button(page, confirm).click();
  await downloadPair(page, '25.00');
  expect(downloads).toEqual(['catalog-price-update.csv', 'catalog-price-rollback.csv']);
});

test('the live formula preview uses the explicit nonstandard SKU column and skips unmatched rows', async ({ page, beginProcessing }) => {
  await start(page, beginProcessing, [['Catalog Key', 'New Price'], ['NO-MATCH', '1.00'], ['00041', '10.00']]);
  await page.getByLabel('Join key').selectOption('sku');
  await page.getByLabel('SKU column').selectOption('0');
  await setMultiplier(page);
  await expect(page.getByRole('status').filter({ hasText: 'Supplier row 3' })).toHaveText('Supplier row 3 10.00 → 22.99');
  await assertPair(page, false);
});
