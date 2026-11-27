import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertFits, test } from './browser';
import { auditPage } from './m10-accessibility';
import { button, csv, field, openSignoff, openStudio, pair, parseCsv, save, skuRow } from './m7-files';

const book = resolve('fixtures/supplier-delta/synthetic-pricebook.xlsx');
const sheets = ['Instructions', 'Q4_Prices', 'Q3_Prices'];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const status = (page: Page) => page.getByTestId('supplier-delta-status');
const fingerprints = (page: Page, name: string) => page.locator('code[data-custody-field="' + name + '"]');
const nativeHeader = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value',
  'Option3 Name', 'Option3 Value', 'Variant SKU', 'Variant Price'];
const original = [
  [...nativeHeader, 'Tags', 'Body (HTML)'],
  ['case', '  Case, lined  ', 'Size', 'S', '', '', '', '', '00123', '025.000', 'keep, exactly', 'Two\r\nlines'],
  ['case', '', '', 'L', '', '', '', '', '0045-BLK', '012.200', '', ''],
  ['same', 'Unchanged', 'Title', 'Default Title', '', '', '', '', 'KEPT', '1.005', '', 'Retain'],
  ['new', 'New', 'Title', 'Default Title', '', '', '', '', 'NEW-ONLY', '6.00', '', ''],
];
const catalog = csv('agency-quarter.csv', original);

async function capture(page: Page, info: TestInfo, anchor: Locator, name: string) {
  await assertFits(page);
  if (process.env.IMPORT_MEDIC_CAPTURE_M13_SCREENSHOTS !== '1') return;
  const dir = process.env.IMPORT_MEDIC_M13_SCREENSHOTS || resolve('docs/reports/screenshots/m13');
  await mkdir(dir, { recursive: true });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  const margin = info.project.name === 'desktop' && name === 'supplier-delta' ? 10 : 18;
  await anchor.evaluate((el, offset) => window.scrollBy(0, el.getBoundingClientRect().top - offset), margin);
  await page.screenshot({ path: resolve(dir, info.project.name + '-m13-' + name + '.png'), animations: 'disabled' });
}

function nativeImport(matrix: string[][], downloaded: string) {
  const [header, ...rows] = parseCsv(downloaded);
  expect(header).toEqual(nativeHeader);
  expect(rows.map(row => row[8])).toEqual(['00123', '0045-BLK']);
  const applied = matrix.map(row => [...row]);
  for (const row of rows) {
    const target = applied.find(item => item[8] === row[8])!;
    expect(row.slice(0, 9)).toEqual(target.slice(0, 9));
    expect(row).toHaveLength(nativeHeader.length);
    target[9] = row[9];
  }
  return applied;
}

async function hashLayout(elements: Locator) {
  const clipped = await elements.evaluateAll(hashes => hashes.flatMap(digest => {
    const box = digest.closest('li,dd')!.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(digest);
    const bounds = [...range.getClientRects()];
    return !bounds.length || bounds.some(line => line.left < box.left - 1 || line.right > box.right + 1)
      ? [digest.textContent] : [];
  }));
  expect(clipped, 'Each complete digest fits its own panel').toEqual([]);
}

async function compareFiles(page: Page, beginProcessing: () => void) {
  await openStudio(page, beginProcessing);
  const tabs = page.getByRole('tablist', { name: /studio/i });
  await expect(tabs.getByRole('tab')).toHaveCount(4);
  await expect(tabs.getByRole('tab', { name: 'Build Update' })).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByRole('tab').nth(3)).toHaveAccessibleName('Supplier Delta');
  await tabs.getByRole('tab', { name: 'Supplier Delta' }).click();
}

test('Build Update binds the selected worksheet to exact Shopify bytes, v6 recipe and offline custody', async ({ page, beginProcessing }, info) => {
  await openStudio(page, beginProcessing);
  await field(page, 'Choose Shopify baseline CSV').setInputFiles(catalog);
  const upload = field(page, 'Choose supplier price sheet');
  const picker = field(page, 'Supplier worksheet');
  await upload.setInputFiles(book);
  await expect(picker).toHaveValue('Instructions');
  await expect(picker.locator('option')).toHaveText(sheets);
  await pair(page, 'Shopify', false);
  await picker.selectOption('Q4_Prices');
  await expect(field(page, 'SKU column')).toHaveValue('0');
  await expect(field(page, 'New price column')).toHaveValue('1');
  await button(page, 'Confirm columns').click();
  await pair(page, 'Shopify', true);
  await expect(skuRow(page, '00123')).toContainText('28.50');
  await expect(skuRow(page, '0045-BLK')).toContainText('10.00');
  if (info.project.name === 'desktop') await capture(page, info, page.getByRole('list', { name: 'Supplier sheet order' }), 'xlsx-sheet-picker');
  await field(page, 'Supplier label').fill('Quarterly');
  const recipe = await save(page, info, 'Save Supplier Recipe (.json)', 'quarterly-supplier-recipe.json', 'm13-build');
  expect(JSON.parse(recipe.text)).toMatchObject({ version: 6, selectedSheet: 'Q4_Prices', sheetName: 'Q4_Prices', priceColumn: 'Cost' });
  const prefix = 'agency-quarter-';
  const update = await save(page, info, 'Download Safe Shopify Update CSV', prefix + 'price-update.csv', 'm13-build');
  const rollback = await save(page, info, 'Download Shopify Rollback CSV', prefix + 'price-rollback.csv', 'm13-build');
  const audit = JSON.parse((await save(page, info, 'Download Full Diff Audit (.json)', prefix + 'price-diff.audit.json', 'm13-build')).text);
  const bytes = await readFile(book);
  const custody = { baselineSha256: hash(catalog.buffer), suppliers: [
    { filename: 'synthetic-pricebook.xlsx', selectedSheet: 'Q4_Prices', bytes: bytes.length, sha256: hash(bytes) },
  ], updateCsvSha256: hash(await readFile(update.path)), rollbackCsvSha256: hash(await readFile(rollback.path)) };
  expect(audit.custody).toEqual(custody);
  expect(audit.supplier.selectedSheet).toBe('Q4_Prices');
  for (const [sku, line, raw] of [['00123', 2, '28.50'], ['0045-BLK', 4, '10.00']] as const) {
    expect(audit.rows.find((row: { sku: string }) => row.sku === sku)).toMatchObject({
      sku, supplierRow: line, supplierPrice: raw, newPrice: raw, status: 'Updated',
    });
  }
  const updated = nativeImport(original, update.text);
  const expected = original.map(row => [...row]);
  expected[1][9] = '28.50';
  expected[2][9] = '10.00';
  expect(updated).toEqual(expected);
  const restored = csv(catalog.name, nativeImport(updated, rollback.text)).buffer;
  expect(restored.equals(catalog.buffer)).toBe(true);
  await writeFile(resolve(dirname(update.path), catalog.name), catalog.buffer);
  const offline = await openSignoff(page, info, 'agency-quarter', 'm13-build');
  await expect(offline.locator('footer')).toContainText('Worksheet: Q4_Prices');
  for (const digest of [custody.baselineSha256, custody.suppliers[0].sha256, custody.updateCsvSha256, custody.rollbackCsvSha256]) {
    await expect(offline.locator('footer')).toContainText(digest);
  }
  await offline.close();
  await upload.setInputFiles(book);
  await expect(picker).toHaveValue('Instructions');
  await pair(page, 'Shopify', false);
  await field(page, 'Load Supplier Recipe (.json)').setInputFiles(recipe.path);
  await expect(picker).toHaveValue('Q4_Prices');
  await expect(page.getByRole('status').filter({ hasText: 'Recipe needs review: Quarterly' })).toBeVisible();
  await pair(page, 'Shopify', false);
  await button(page, 'Confirm columns').click();
  await pair(page, 'Shopify', true);
  info.annotations.push({ type: 'm13-build', description: JSON.stringify({ custody, restoredBytes: restored.length, changedSkus: ['00123', '0045-BLK'] }) });
});

test('Three supplier slots preserve independent worksheet choices across replacement and reordering', async ({ page, beginProcessing }) => {
  await openStudio(page, beginProcessing);
  await field(page, 'Choose Shopify baseline CSV').setInputFiles(catalog);
  await field(page, 'Choose supplier price sheet').setInputFiles(csv('price.csv', [['SKU', 'Price'], ['00123', '28.50']]));
  const add = button(page, '+ Add another supplier sheet');
  await add.click();
  await field(page, 'Choose supplier price sheet 2').setInputFiles(book);
  await expect(field(page, 'Supplier worksheet 2')).toHaveValue('Instructions');
  await field(page, 'Supplier worksheet 2').selectOption('Q3_Prices');
  await add.click();
  await field(page, 'Choose supplier price sheet 3').setInputFiles(book);
  await expect(field(page, 'Supplier worksheet 3')).toHaveValue('Instructions');
  await field(page, 'Supplier worksheet 3').selectOption('Q4_Prices');
  await expect(field(page, 'Supplier worksheet 2')).toHaveValue('Q3_Prices');
  await button(page, 'Move supplier sheet 3 up').click();
  await expect(field(page, 'Supplier worksheet 2')).toHaveValue('Q4_Prices');
  await expect(field(page, 'Supplier worksheet 3')).toHaveValue('Q3_Prices');
  await field(page, 'Choose supplier price sheet 2').setInputFiles(csv('single.csv', [['SKU', 'Price'], ['00123', '28.50']]));
  await expect(field(page, 'Supplier worksheet 2')).toHaveCount(0);
  await expect(field(page, 'Supplier worksheet 3')).toHaveValue('Q3_Prices');
  await assertFits(page);
});

test('Supplier Delta compares uploaded XLSX and CSV, filters exact rows and verifies the downloaded files offline', async ({ page, beginProcessing }, info) => {
  await compareFiles(page, beginProcessing);
  const previous = field(page, 'Choose previous supplier sheet');
  const next = field(page, 'Choose new supplier sheet');
  const previousPicker = field(page, 'Previous worksheet');
  const newCsv = csv('Q4 <tier> & agency.csv', [
    ['SKU', 'Quote', 'Stock', 'Memo'], ['00123', '28.50', '20', 'multi\r\nline'],
    ['0045-BLK', '10.00', '12', ''], ['KEPT', '1.05', '4', ''], ['=QA', '6.00', '8', ''],
  ]);
  await previous.setInputFiles(book);
  await expect(previousPicker).toHaveValue('Instructions');
  await expect(previousPicker.locator('option')).toHaveText(sheets);
  await previousPicker.selectOption('Q3_Prices');
  await next.setInputFiles(newCsv);
  await expect(field(page, 'New Cost column')).toHaveValue('');
  await field(page, 'New Cost column').selectOption('1');
  await expect(status(page)).toHaveText('Ready to download');
  const filterGroup = page.getByRole('group', { name: 'Filter supplier delta' });
  const table = page.getByRole('table', { name: 'Supplier cost delta' });
  for (const [label, skus] of [
    ['Cost Hikes', ['00123', 'KEPT']], ['Cost Drops', ['0045-BLK']], ['Added', ['=QA']], ['Removed', ['OLD-ONLY']],
    ['Blocked', []], ['All', ['00123', '0045-BLK', 'KEPT', 'OLD-ONLY', '=QA']],
  ] as const) {
    const filter = filterGroup.getByRole('button', { name: label, exact: true });
    await filter.click();
    await expect(filter).toHaveAttribute('aria-pressed', 'true');
    await expect(filter).toHaveText(new RegExp(skus.length + '$'));
    const rows = table.getByRole('rowheader').locator('code');
    await expect(rows).toHaveCount(skus.length);
    expect((await rows.allTextContents()).sort()).toEqual([...skus].sort());
  }
  const hike = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: '00123', exact: true }) });
  await expect(hike).toContainText('+3.50');
  await expect(hike).toContainText('+14.00%');
  const measurements = await auditPage(page, 'workbench');
  await capture(page, info, status(page), 'supplier-delta');
  const csvFile = await save(page, info, 'Supplier Delta CSV', 'supplier-delta-report.csv', 'm13-delta');
  const auditFile = await save(page, info, 'JSON Audit', 'supplier-delta-audit.json', 'm13-delta');
  const html = await save(page, info, 'Delta Sign-Off (.html)', 'supplier-delta-sign-off.html', 'm13-delta');
  const audit = JSON.parse(auditFile.text);
  const custody = { previousSha256: hash(await readFile(book)), newSha256: hash(newCsv.buffer),
    deltaCsvSha256: hash(await readFile(csvFile.path)), signOffHtmlSha256: hash(await readFile(html.path)) };
  await writeFile(resolve(dirname(csvFile.path), 'uploaded-new.csv'), newCsv.buffer);
  expect(audit).toMatchObject({ status: 'ready', custody, maxHikePercent: '14.00', sources: {
    previous: { selectedSheet: 'Q3_Prices' }, next: { filename: newCsv.name, selectedSheet: null },
  } });
  expect(audit.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ sku: '00123', previousRow: 2, newRow: 2, delta: '+3.50', deltaPercent: '+14.00' }),
    expect.objectContaining({ sku: '0045-BLK', previousRow: 4, newRow: 4, delta: '-2.20' }),
    expect.objectContaining({ sku: 'OLD-ONLY', previousRow: 10, newRow: null }),
    expect.objectContaining({ sku: '=QA', previousRow: null, newRow: 6 }),
  ]));
  const [headers, ...records] = parseCsv(csvFile.text);
  const values = records.map(record => Object.fromEntries(headers.map((header, i) => [header, record[i]])));
  expect(values).toHaveLength(5);
  expect(values).toEqual(expect.arrayContaining([
    expect.objectContaining({ SKU: '00123', Status: 'cost-increased', 'Cost delta': '+3.50', 'Cost change %': '+14.00' }),
    expect.objectContaining({ SKU: '0045-BLK', Status: 'cost-decreased', 'Cost delta': '-2.20' }),
    expect.objectContaining({ SKU: "'=QA", Status: 'added-sku' }),
  ]));
  const drawer = page.getByTestId('custody-fingerprints');
  await drawer.locator('summary').click();
  await expect(fingerprints(page, 'previous')).toBeHidden();
  await drawer.locator('summary').press('Enter');
  for (const [key, digest] of Object.entries({ previous: custody.previousSha256, new: custody.newSha256, 'delta-csv': custody.deltaCsvSha256, signoff: custody.signOffHtmlSha256 })) {
    await expect(fingerprints(page, key)).toBeVisible();
    await expect(fingerprints(page, key)).toHaveText(digest);
  }
  await hashLayout(drawer.locator('code'));
  await assertFits(page);
  const offline = await page.context().newPage();
  await offline.goto(pathToFileURL(html.path).href);
  expect(new URL(offline.url()).protocol).toBe('file:');
  await expect(offline.getByRole('heading', { name: 'Supplier Delta Executive Sign-Off' })).toBeVisible();
  await expect(offline.locator('header')).toContainText(newCsv.name);
  await expect(offline.locator('script, [src], [href], iframe, form, tier')).toHaveCount(0);
  expect(await offline.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toMatch(/default-src 'none'/);
  expect(html.text).toContain("connect-src 'none'");
  expect(html.text).toContain("script-src 'none'");
  await expect(offline.locator('footer dd')).toHaveText([custody.previousSha256, custody.newSha256, custody.deltaCsvSha256]);
  await hashLayout(offline.locator('footer dd code'));
  const major = offline.getByRole('checkbox', { name: 'Show hikes of at least 10%' });
  const labelGap = await major.evaluate(input => {
    const label = (input as HTMLInputElement).labels![0];
    return label.getBoundingClientRect().left - input.getBoundingClientRect().right;
  });
  const sourceLine = 'Previous: synthetic-pricebook.xlsx · Worksheet: Q3_Prices';
  expect.soft(await offline.locator('header p').innerText()).toContain(sourceLine);
  expect.soft(labelGap, 'Space between the checkbox and its label in CSS pixels').toBeGreaterThanOrEqual(8);
  const minorSku = offline.getByRole('rowheader', { name: 'KEPT' });
  await expect(minorSku).toBeVisible();
  await major.focus();
  await major.press('Space');
  await expect(major).toBeChecked();
  await expect(minorSku).toBeHidden();
  await expect(offline.getByRole('rowheader', { name: '00123' })).toBeVisible();
  await major.uncheck();
  await expect(minorSku).toBeVisible();
  await assertFits(offline);
  if (info.project.name === 'desktop') await capture(offline, info, offline.locator('header'), 'delta-signoff');
  await offline.close();
  info.annotations.push({ type: 'm13-delta', description: JSON.stringify({ custody, measurements, counts: audit.counts, labelGap, roundtrip: true }) });
});

test('The synthetic quarter demo stays local and a conflicting upload with physical multiline rows holds both reports', async ({ page, beginProcessing }, info) => {
  await compareFiles(page, beginProcessing);
  await button(page, 'Load Synthetic Supplier Delta Demo').click();
  await expect(field(page, 'Previous worksheet')).toHaveValue('Q3_Prices');
  await expect(field(page, 'New worksheet')).toHaveValue('Q4_Prices');
  await expect(status(page)).toHaveText('Ready to download');
  const json = 'supplier-delta-audit.json';
  const demo = JSON.parse((await save(page, info, 'JSON Audit', json, 'm13-demo')).text);
  expect(demo.counts).toMatchObject({ 'cost-increased': 1, 'cost-decreased': 1, 'removed-sku': 1, 'added-sku': 1, unchanged: 1 });
  expect(demo.custody.previousSha256).toBe(hash(await readFile(book)));
  expect(demo.custody.newSha256).toBe(demo.custody.previousSha256);
  await field(page, 'New worksheet').selectOption('Q3_Prices');
  await expect(page.getByRole('button', { name: 'Cost Hikes', exact: true })).toHaveText(/0$/);
  const noHikes = await save(page, info, 'Delta Sign-Off (.html)', 'supplier-delta-sign-off.html', 'm13-same-quarter');
  const unchanged = await page.context().newPage();
  await unchanged.goto(pathToFileURL(noHikes.path).href);
  await expect(unchanged.getByText('No cost hikes were found.')).toBeVisible();
  await expect(unchanged.locator('dt').filter({ hasText: 'Max hike' }).locator('+ dd')).toHaveText('—');
  await unchanged.close();
  await field(page, 'Choose new supplier sheet').setInputFiles(csv('conflicting.csv', [
    ['SKU', 'Cost', 'Notes'], ['00123', '28.50', '1\r\n2'], ['0045-BLK', 'bad', ''], ['00123', '99.00', ''],
  ]));
  await expect(status(page)).toHaveText('Review required');
  await expect(field(page, 'New worksheet')).toHaveCount(0);
  await expect(field(page, 'Previous worksheet')).toHaveValue('Q3_Prices');
  await button(page, 'Blocked').click();
  const issues = page.getByRole('list', { name: 'Supplier delta issues' });
  await expect(issues).toContainText('rows 2, 5');
  await expect(issues).toContainText('row 4');
  await expect(button(page, 'Supplier Delta CSV')).toBeDisabled();
  await expect(button(page, 'Delta Sign-Off (.html)')).toBeDisabled();
  const held = JSON.parse((await save(page, info, 'JSON Audit', json, 'm13-held')).text);
  expect(held.status).toBe('blocked');
  expect(held.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'blocked-duplicate-sku', side: 'next', rows: [2, 5] }),
    expect.objectContaining({ code: 'blocked-invalid-cost', side: 'next', row: 4 }),
  ]));
  expect(Object.keys(held.custody).sort()).toEqual(['newSha256', 'previousSha256']);
  await expect(fingerprints(page, 'delta-csv')).toHaveCount(0);
  await expect(fingerprints(page, 'signoff')).toHaveCount(0);
});
