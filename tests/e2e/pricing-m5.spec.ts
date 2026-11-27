import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import Papa from 'papaparse';
import { assertFits, downloadText, loadFile, test } from './browser';

const fixtures = resolve('fixtures/shopify-price-diff');
const baseline = resolve(fixtures, 'baseline-fx.csv');
const update = 'Download Safe Shopify Update CSV';
const rollback = 'Download Shopify Rollback CSV';
const reviewColumn = 'Review and Resolution (JSON)';
const native = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value',
  'Variant SKU', 'Variant Price', 'Variant Compare At Price'];
const fx = { sourceCurrency: 'EUR', storeCurrency: 'USD', fxRate: '1.0850' };
const pricing = { mode: 'multiplier', multiplier: '2.2', rounding: 'ending-99', fx, compareAtRule: { multiplier: '1.25' } };
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const confirm = (page: Page) => button(page, 'Confirm columns');
const recheck = (page: Page) => page.getByRole('checkbox', { name: /verified.*FX rate/ });
const formula = (page: Page) => page.getByText('Pricing formula & rounding', { exact: true });
const guard = (page: Page) => page.getByRole('checkbox', { name: /Guard spreadsheet formulas/ });
const edits = (page: Page, line: number) => page.getByRole('group', { name: 'Review supplier row ' + line, exact: true });
const file = (name: string, content: string) => ({ name, mimeType: name.endsWith('.json') ? 'application/json' : 'text/csv', buffer: Buffer.from(content) });

function csv(content: string) {
  const parsed = Papa.parse<string[]>(content, { delimiter: ',', skipEmptyLines: true });
  expect(parsed.errors).toEqual([]);
  return parsed.data;
}

async function upload(page: Page, begin: () => void, supplier?: string) {
  await page.goto('/shopify-price-update-diff', { waitUntil: 'networkidle' });
  begin();
  await page.getByLabel('Choose Shopify baseline CSV').setInputFiles(baseline);
  await page.getByLabel('Choose supplier price sheet').setInputFiles(supplier === undefined
    ? resolve(fixtures, 'supplier-fx.csv') : file('batch.csv', supplier));
  await page.getByLabel('New price column').selectOption('1');
}

async function configureFx(page: Page) {
  await formula(page).click();
  await page.getByLabel('Pricing mode', { exact: true }).selectOption('multiplier');
  await page.getByLabel('Multiplier', { exact: true }).fill('2.2');
  await page.getByLabel('Rounding', { exact: true }).selectOption('ending-99');
  await page.getByLabel('Convert supplier currency (manual rate)', { exact: true }).check();
  await page.getByLabel('Source currency code', { exact: true }).fill('EUR');
  await page.getByLabel('Store currency code', { exact: true }).fill('USD');
  await page.getByLabel('Exact rate', { exact: true }).fill(fx.fxRate);
  await page.getByLabel('Calculate compare-at price automatically', { exact: true }).check();
  await page.getByLabel('Compare-at multiplier', { exact: true }).fill('1.25');
}

async function pair(page: Page, ready: boolean) {
  for (const name of [update, rollback]) {
    if (ready) await expect(button(page, name)).toBeEnabled();
    else await expect(button(page, name)).toBeDisabled();
  }
}

async function capture(page: Page, name: string, anchor: Locator, top: number) {
  if (process.env.IMPORT_MEDIC_CAPTURE_M5_SCREENSHOTS !== '1') return;
  await assertFits(page);
  await anchor.evaluate((element, offset) => window.scrollBy(0, element.getBoundingClientRect().top - offset), top);
  await page.evaluate(() => document.fonts.ready);
  const dir = resolve('docs/reports/screenshots/m5');
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, name + '.png'), animations: 'disabled' });
}

async function measureGuard(page: Page, info: TestInfo, workbench: string) {
  const box = guard(page);
  await expect(box).toBeVisible();
  const measurements = await box.evaluate((input) => {
    const label = (input as HTMLInputElement).labels![0];
    const span = label.querySelector('span')!;
    return { css: parseFloat(getComputedStyle(label).columnGap), pixels: span.getBoundingClientRect().left - input.getBoundingClientRect().right,
      width: document.documentElement.scrollWidth };
  });
  expect(measurements.css).toBeGreaterThan(0);
  expect(measurements.pixels).toBeGreaterThan(0);
  expect(measurements.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  info.annotations.push({ type: 'm5-checkbox-gap', description: JSON.stringify({ workbench, ...measurements }) });
}

// The baseline omits unused options. The native pair includes their names and values as empty strings.
function replay([headers, ...catalog]: string[][], [fields, ...rows]: string[][]) {
  const identity = (row: string[], columns: string[]) => JSON.stringify(
    ['Handle', 'Option1 Value', 'Option2 Value', 'Option3 Value'].map((name) => row[columns.indexOf(name)] ?? ''),
  );
  const remaining = new Map(rows.map((row) => [identity(row, fields), row]));
  expect(remaining.size).toBe(rows.length);
  const result = catalog.map((row) => {
    const key = identity(row, headers);
    const patch = remaining.get(key);
    if (!patch) return row;
    remaining.delete(key);
    return headers.map((field, index) => fields.includes(field) ? patch[fields.indexOf(field)] : row[index]);
  });
  expect(remaining.size).toBe(0);
  return [headers, ...result];
}

test('manual FX and automatic compare-at survive real downloads and rollback restores every original cell', async ({ page, beginProcessing }, info) => {
  await upload(page, beginProcessing);
  await configureFx(page);
  const preview = page.getByTestId('fx-pricing-preview');
  const computed = page.getByTestId('compare-at-pricing-preview');
  const trace = '10.00 EUR × 1.0850 → 23.99 USD';
  await expect(preview).toHaveText(trace);
  await expect(computed).toHaveText('Compare-at 29.99 USD');
  await expect(confirm(page)).toBeDisabled();
  await pair(page, false);
  await recheck(page).check();
  await confirm(page).click();
  await pair(page, true);
  await expect(preview).toHaveText(trace);
  await expect(computed).toHaveText('Compare-at 29.99 USD');
  const desktop = info.project.name === 'desktop';
  await capture(page, desktop ? 'desktop-m5-fx-compare-at' : 'mobile-m5-fx', desktop ? formula(page) : page.getByLabel('Convert supplier currency (manual rate)'), desktop ? 28 : 24);
  await expect(page.getByRole('table', { name: 'Shopify price diff' }).locator('tbody tr').first()).toContainText('FX applied · EUR → USD @ 1.0850');
  await edits(page, 3).getByLabel('Skip row').check();
  await pair(page, true);
  await measureGuard(page, info, 'price-diff');
  if (desktop) await capture(page, 'desktop-m5-checkbox-gap', page.getByRole('heading', { name: 'Download the update, rollback, and audit' }), 116);
  const after = csv(await downloadText(page, update, 'baseline-fx-price-update.csv'));
  const before = csv(await downloadText(page, rollback, 'baseline-fx-price-rollback.csv'));
  const catalog = csv(readFileSync(baseline, 'utf8'));
  const identity = ['boots', '  Alpine, "Black"  ', 'Color', 'Black', '', '', '', '', '001'];
  const sibling = ['boots', '', '', 'Blue', '', '', '', '', '002', '25.000', '035.000'];
  expect(after).toEqual([native, [...identity, '23.99', '29.99'], sibling]);
  expect(before).toEqual([native, [...identity, '020.000', ''], sibling]);
  const expected = catalog.map((row) => [...row]);
  expected[1][catalog[0].indexOf('Variant Price')] = '23.99';
  expected[1][catalog[0].indexOf('Variant Compare At Price')] = '29.99';
  const applied = replay(catalog, after);
  expect(applied).toEqual(expected);
  expect(replay(applied, before)).toEqual(catalog);
  const audit = JSON.parse(await downloadText(page, 'Download Full Diff Audit (.json)', 'baseline-fx-price-diff.audit.json'));
  expect(audit).toMatchObject({ pricingRule: pricing, verification: { checked: true, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 },
    rollbackVerification: { checked: true, restoredVariants: 2 }, columns: { included: native, omittedBaselineHeaders: ['Tags', 'Image Src'] } });
  expect(audit.rows[0]).toMatchObject({ sku: '001', supplierPrice: '10.00 EUR', oldPrice: '020.000', oldCompareAtPrice: '',
    computedPrice: '23.99', newPrice: '23.99', newCompareAtPrice: '29.99', fxApplied: fx });
  expect(audit.rows[1]).toMatchObject({ sku: '002', status: 'Skipped' });
  const [headers, summary, first] = csv(await downloadText(page, 'Download Full Diff Audit (.csv)', 'baseline-fx-price-diff.audit.csv'));
  expect(headers.slice(-2)).toEqual(['FX Applied', reviewColumn]);
  const auditRow = Object.fromEntries(headers.map((header, index) => [header, first[index]]));
  expect(auditRow).toMatchObject({ 'FX Applied': 'EUR -> USD @ 1.0850', 'Raw Supplier Price': '10.00 EUR', 'Computed Price': '23.99', 'New Compare At Price': '29.99' });
  expect(JSON.parse(auditRow['Original Supplier Cells (JSON)'])).toEqual(audit.rows[0].supplierCells);
  expect(JSON.parse(summary.at(-1)!)).toMatchObject({ pricingRule: pricing, rollbackVerification: audit.rollbackVerification });
});

test('mapped compare-at cannot be approved at or below the effective retail price; correction and skip produce scoped files', async ({ page, beginProcessing }) => {
  await upload(page, beginProcessing, 'SKU,Price,Compare\n001,80,80\n002,26,32');
  await page.getByLabel('Compare-at price column').selectOption('2');
  await confirm(page).click();
  const row = page.getByRole('row').filter({ has: edits(page, 2) });
  await expect(row.locator('.compare-at-block')).toBeVisible();
  await expect(row).toContainText('This price increases more than the selected threshold.');
  await expect(row.getByRole('button', { name: 'Confirm proposed price' })).toHaveCount(0);
  await pair(page, false);
  const edit = edits(page, 2).getByRole('button', { name: 'Edit price' });
  await edit.focus();
  await page.keyboard.press('/');
  const search = page.getByRole('searchbox', { name: 'Search by SKU or Handle' });
  await expect(search).toBeFocused();
  await edit.click();
  const draft = row.getByLabel('Override compare-at price');
  await draft.fill('120');
  await draft.press('Escape');
  await expect(edit).toBeFocused();
  await expect(draft).toHaveCount(0);
  await expect(row.locator('.compare-at-block')).toBeVisible();
  await edit.click();
  await row.getByLabel('Override price', { exact: true }).fill('81');
  await row.getByRole('button', { name: 'Apply override' }).click();
  await expect(row.locator('.compare-at-block')).toBeVisible();
  await pair(page, false);
  await edit.click();
  await draft.fill('82');
  await row.getByRole('button', { name: 'Apply override' }).click();
  await expect(row.locator('.compare-at-block')).toHaveCount(0);
  await pair(page, false);
  await row.getByRole('button', { name: 'Confirm proposed price' }).click();
  await pair(page, true);
  expect(csv(await downloadText(page, update, 'baseline-fx-price-update.csv'))[1].slice(-2)).toEqual(['81', '82']);
  await edits(page, 2).getByLabel('Skip row').check();
  await pair(page, true);
  const [, skipped, kept] = csv(await downloadText(page, update, 'baseline-fx-price-update.csv'));
  expect(skipped.slice(-3)).toEqual(['001', '020.000', '']);
  expect(kept.slice(-3)).toEqual(['002', '26', '32']);
});

test('an automatic compare-at equal after rounding blocks both downloads until fixed or skipped', async ({ page, beginProcessing }) => {
  await upload(page, beginProcessing, 'SKU,Price\n001,21.99\n002,26');
  await formula(page).click();
  await page.getByLabel('Rounding', { exact: true }).selectOption('ending-99');
  await page.getByLabel('Calculate compare-at price automatically').check();
  await page.getByLabel('Compare-at multiplier').fill('1');
  await confirm(page).click();
  await expect(page.locator('.compare-at-block')).toHaveCount(2);
  await pair(page, false);
  await edits(page, 2).getByLabel('Skip row').check();
  const second = page.getByRole('row').filter({ has: edits(page, 3) });
  await second.getByRole('button', { name: 'Edit price' }).click();
  await second.getByLabel('Override compare-at price').fill('34.99');
  await second.getByRole('button', { name: 'Apply override' }).click();
  await pair(page, true);
  const [, skipped, fixed] = csv(await downloadText(page, update, 'baseline-fx-price-update.csv'));
  expect(skipped.slice(-3)).toEqual(['001', '020.000', '']);
  expect(fixed.slice(-3)).toEqual(['002', '26.99', '34.99']);
});

test('v3 FX recipes recheck the exact rate on the next batch; v1 and v2 keep their pricing semantics', async ({ page, beginProcessing }) => {
  await upload(page, beginProcessing);
  await configureFx(page);
  await recheck(page).check();
  await confirm(page).click();
  await pair(page, true);
  await page.getByLabel('Supplier label').fill('Alpine');
  const saved = await downloadText(page, 'Save Supplier Recipe (.json)', 'alpine-supplier-recipe.json');
  const recipe = JSON.parse(saved);
  expect(recipe).toMatchObject({ version: 3, fxRateNeedsRecheck: true, pricingRule: pricing });
  expect(recipe).not.toHaveProperty('fxRateConfirmed');
  await page.getByLabel('Choose supplier price sheet').setInputFiles(file('batch2.csv', 'Cost,SKU\n10.00,001'));
  const load = page.getByLabel('Load Supplier Recipe (.json)');
  await load.setInputFiles(file('alpine.json', saved));
  await expect(page.getByText(/This recipe includes a saved FX rate/)).toBeVisible();
  await expect(recheck(page)).not.toBeChecked();
  await expect(confirm(page)).toBeDisabled();
  await pair(page, false);
  await formula(page).click();
  const rate = page.getByLabel('Exact rate', { exact: true });
  await expect(rate).toHaveValue('1.0850');
  await recheck(page).check();
  await confirm(page).click();
  await pair(page, true);
  for (const invalid of ['0', '-1', 'n/a', '']) {
    await rate.fill(invalid);
    await expect(recheck(page)).toBeDisabled();
    await expect(confirm(page)).toBeDisabled();
    await pair(page, false);
  }
  await rate.fill('1.085');
  await expect(recheck(page)).not.toBeChecked();
  await expect(confirm(page)).toBeDisabled();
  await recheck(page).check();
  await confirm(page).click();
  expect(csv(await downloadText(page, update, 'baseline-fx-price-update.csv'))[1].slice(-2)).toEqual(['23.99', '29.99']);
  const legacy = { supplierLabel: 'Alpine', joinKey: { type: 'sku', skuColumn: 'SKU' }, priceColumn: 'Cost', compareAtColumn: null,
    sheetName: null, dropThresholdPercent: 50, increaseThresholdPercent: 200, formulaGuard: false };
  for (const [data, expected] of [
    [{ ...legacy, version: 1 }, '10.00'],
    [{ ...legacy, version: 2, pricingRule: { mode: 'multiplier', multiplier: '2.2', rounding: 'ending-99' } }, '22.99'],
  ] as const) {
    await load.setInputFiles(file('legacy.json', JSON.stringify(data)));
    await expect(page.getByRole('status').filter({ hasText: 'Recipe needs review: Alpine' })).toBeVisible();
    await expect(recheck(page)).toHaveCount(0);
    await pair(page, false);
    await confirm(page).click();
    const [headers, first] = csv(await downloadText(page, update, 'baseline-fx-price-update.csv'));
    expect(headers).not.toContain('Variant Compare At Price');
    expect(first[headers.indexOf('Variant Price')]).toBe(expected);
  }
});

test('single-file repair leaves visible space between the formula checkbox and label', async ({ page, beginProcessing }, info) => {
  await page.goto('/shopify-csv-fixer', { waitUntil: 'networkidle' });
  beginProcessing();
  await loadFile(page, 'shopify/invalid-variant-price.csv');
  await measureGuard(page, info, 'single-file');
});
