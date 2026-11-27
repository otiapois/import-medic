import { deepStrictEqual } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import Papa from 'papaparse';
import { assertFits, downloadCsv, downloadText, test } from './browser';

const route = '/shopify-price-update-diff';
const nativeButton = 'Download Safe Shopify Update CSV';
const saveRecipe = 'Save Supplier Recipe (.json)';
const formula = '=HYPERLINK("https://example.invalid")'; // Inert uploaded cell text, never executed.
const inputHeaders = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Tags', 'Body (HTML)', 'Image Src'];
const updateHeaders = [...inputHeaders.slice(0, 4), 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value', 'Variant SKU', 'Variant Price'];
const recipeName = 'north-supply-supplier-recipe.json';
const file = (name: string, text: string) => ({ name, mimeType: name.endsWith('.json') ? 'application/json' : 'text/csv', buffer: Buffer.from(text) });

function catalog(variants: number, firstTitle?: string) {
  const baseline: string[][] = [];
  const supplier: string[][] = [];
  for (let i = 0; i < variants; i++) {
    const group = Math.floor(i / 2);
    const sku = String(i + 1).padStart(7, '0');
    baseline.push([
      'coat-' + group, i % 2 ? '' : i === 0 && firstTitle ? firstTitle : `  Coat ${group}, "lined"  `,
      i % 2 ? '' : 'Size', i % 2 ? 'Large' : 'Small', sku, i % 2 ? '9.55' : '10.00',
      'original, tag', 'Keep this description', 'https://example.invalid/catalog.jpg',
    ]);
    if (i % 2 === 0) supplier.push([sku, '12.50']);
  }
  return {
    baseline: file('catalog.csv', Papa.unparse([inputHeaders, ...baseline])),
    supplier: file('supplier.csv', Papa.unparse([['SKU', 'New Price'], ...supplier.reverse()])),
  };
}

async function capture(page: Page, filename: string, heading: string) {
  if (process.env.IMPORT_MEDIC_CAPTURE_M3_SCREENSHOTS !== '1') return;
  const directory = resolve('docs/reports/screenshots/m3');
  await mkdir(directory, { recursive: true });
  await page.getByRole('heading', { name: heading, exact: true }).evaluate((element) =>
    window.scrollBy(0, element.getBoundingClientRect().top - 24));
  await page.screenshot({ path: resolve(directory, filename + '.png'), animations: 'disabled' });
}

async function uploadPair(page: Page, pair: ReturnType<typeof catalog>) {
  await page.getByLabel('Choose Shopify baseline CSV').setInputFiles(pair.baseline);
  await page.getByLabel('Choose supplier price sheet').setInputFiles(pair.supplier);
}

function parseDownload(text: string) {
  const parsed = Papa.parse<string[]>(text, { delimiter: ',', newline: '\n' });
  expect(parsed.errors).toEqual([]);
  return parsed.data;
}

async function recordWidth(page: Page, info: TestInfo) {
  await assertFits(page);
  info.annotations.push({ type: 'document-width', description: String(await page.evaluate(() => document.documentElement.scrollWidth)) });
}

test('supplier recipe downloaded for Batch 1 applies to reordered Batch 2 and fails closed on drift or invalid JSON', async ({ page, beginProcessing }, info) => {
  await page.goto(route, { waitUntil: 'networkidle' });
  beginProcessing();
  const small = catalog(2);
  await uploadPair(page, { ...small, supplier: file('batch1.csv', 'SKU,New Price,Notes\n0000001,$11.00,private batch note') });
  const currency = page.getByRole('checkbox', { name: /my Shopify store currency/ });
  const guard = page.getByRole('checkbox', { name: /Guard spreadsheet formulas/ });
  const exportCsv = page.getByRole('button', { name: nativeButton });
  await currency.check();
  await expect(exportCsv).toBeEnabled();
  await page.getByText(/^Price guardrails ·/).click();
  await page.getByLabel('Maximum drop (%)').fill('30');
  await page.getByLabel('Maximum increase (%)').fill('60');
  await page.getByRole('button', { name: 'Apply guardrails' }).click();
  await guard.check();
  await page.getByLabel('Supplier label').fill('North Supply');
  const saved = await downloadText(page, saveRecipe, recipeName);
  expect(JSON.parse(saved)).toEqual({
    version: 1, supplierLabel: 'North Supply', joinKey: { type: 'sku', skuColumn: 'SKU' },
    priceColumn: 'New Price', compareAtColumn: null, sheetName: null, dropThresholdPercent: 30,
    increaseThresholdPercent: 60, formulaGuard: true,
  });
  const supplier = page.getByLabel('Choose supplier price sheet');
  await supplier.setInputFiles(file('batch2.csv', 'New Price,Notes,SKU\n$12.75,next batch,0000001'));
  const recipe = page.getByLabel('Load Supplier Recipe (.json)');
  await recipe.setInputFiles(file(recipeName, saved));
  const panel = page.getByRole('region', { name: 'Supplier recipe' });
  await expect(panel.getByRole('status')).toContainText('Recipe needs review: North Supply');
  await expect(page.getByLabel('New price column')).toHaveValue('0');
  await expect(page.getByLabel('SKU column')).toHaveValue('2');
  await expect(guard).toBeChecked();
  await expect(page.getByText('Price guardrails · 30% drop / 60% increase')).toBeVisible();
  await expect(exportCsv).toBeDisabled();
  const confirm = page.getByRole('button', { name: 'Confirm columns' });
  await page.getByLabel('Compare-at price column').focus();
  await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
  expect(await confirm.evaluate((node) => getComputedStyle(node).outlineWidth)).toBe('3px');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Match supplier columns', { exact: true })).toBeFocused();
  await expect(currency).not.toBeChecked();
  await expect(exportCsv).toBeDisabled();
  await currency.check();
  await expect(exportCsv).toBeEnabled();
  await expect(panel.getByRole('status')).toHaveText('Recipe applied: North Supply.');
  await recordWidth(page, info);
  await capture(page, info.project.name === 'desktop' ? 'desktop-m3-recipe-applied' : 'mobile-m3-recipe', 'Supplier recipe');
  const output = parseDownload(await downloadText(page, nativeButton, 'catalog-price-update.csv'));
  expect(output[0]).toEqual(updateHeaders);
  expect(output.slice(1).map((row) => row.slice(-2))).toEqual([['0000001', '12.75'], ['0000002', '9.55']]);

  await supplier.setInputFiles(file('batch3.csv', 'Renamed Price,Notes,SKU\n13.00,choose manually,0000001'));
  await expect(panel.getByRole('alert')).toContainText('Column “New Price” is missing');
  const price = page.getByLabel('New price column');
  await expect(price).toHaveAttribute('aria-invalid', 'true');
  await expect(price).toHaveValue('');
  await expect(confirm).toBeDisabled();
  await expect(exportCsv).toBeDisabled();
  await price.selectOption('0');
  await expect(exportCsv).toBeDisabled();
  await confirm.click();
  await expect(panel.getByRole('status')).toHaveText('Recipe applied with remapping: North Supply.');
  expect(parseDownload(await downloadText(page, nativeButton, 'catalog-price-update.csv'))[1].at(-1)).toBe('13.00');
  await recipe.setInputFiles(file('invalid.json', '{'));
  await expect(panel.getByRole('alert')).toContainText('not valid UTF-8 recipe JSON');
  await expect(confirm).toBeDisabled();
  await expect(exportCsv).toBeDisabled();
});

test('a canceled single-file repair closes the worker before resuming from the original bank file', async ({ page, beginProcessing }) => {
  test.setTimeout(60_000);
  await page.goto('/quickbooks-csv-fixer', { waitUntil: 'networkidle' });
  const data = Array.from({ length: 20_000 }, (_, i) => ['2026-11-24', 'Transaction ' + i, '-12.50']);
  const created = page.waitForEvent('worker');
  const downloads: string[] = [];
  page.on('download', (item) => downloads.push(item.suggestedFilename()));
  beginProcessing();
  await page.getByLabel('Choose CSV file').setInputFiles(file('bank-large.csv', Papa.unparse([['Date', 'Description', 'Amount'], ...data])));
  const worker = await created;
  await page.waitForFunction(() => Boolean(document.querySelector('progress[aria-label="Repairing CSV"]')), { }, { polling: 'raf' });
  const closed = worker.waitForEvent('close');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await closed;
  await expect(page.getByRole('status').filter({ hasText: 'Processing canceled.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Repair results' })).toHaveCount(0);
  expect(downloads).toEqual([]);
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('region', { name: 'Repair results' }).getByText('20,000', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  expect(page.workers().some((item) => item !== worker && item.url() === worker.url())).toBe(true);
  const [, ...reparsed] = await downloadCsv(page, 'bank-large', 'CRLF');
  deepStrictEqual(reparsed, data.map(([, description, amount]) => ['11/24/2026', description, amount]));
  expect(downloads).toEqual(['bank-large-repaired.csv']);
});

test('20,000 variants run in a local Worker, cancel and resume, page and search, then roundtrip all groups', async ({ page, beginProcessing }, info) => {
  test.setTimeout(120_000);
  await page.goto(route, { waitUntil: 'networkidle' });
  const pair = catalog(20_000);
  const downloads: string[] = [];
  page.on('download', (item) => downloads.push(item.suggestedFilename()));
  beginProcessing();
  await uploadPair(page, pair);
  const comparisonPhase = 'progress[aria-label="Comparing prices"], progress[aria-label="Preparing local output"]';
  await page.waitForFunction((selector) => Boolean(document.querySelector(selector)), comparisonPhase, { polling: 'raf' });
  const worker = page.workers().find((item) => new URL(item.url()).pathname.includes('/assets/diff.worker-'))!;
  expect(new URL(worker.url()).origin).toBe(new URL(page.url()).origin);
  const closed = worker.waitForEvent('close');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await closed;
  await expect(page.getByRole('status').filter({ hasText: 'Processing canceled.' })).toBeVisible();
  await expect(page.locator('button:enabled').filter({ hasText: nativeButton })).toHaveCount(0);
  expect(downloads).toEqual([]);

  // The worker reports its comparison and export preparation separately.
  const probe = await page.evaluateHandle((selector) => {
    const state = { frames: 0, maxGapMs: 0, phases: [] as string[] };
    let prev = 0;
    let timer = 0;
    const record = (now: number) => {
      const phase = document.querySelector(selector)?.getAttribute('aria-label');
      if (phase) {
        if (!state.phases.includes(phase)) state.phases.push(phase);
        if (prev) state.maxGapMs = Math.max(state.maxGapMs, now - prev);
        state.frames++;
        prev = now;
      } else prev = 0;
      timer = requestAnimationFrame(record);
    };
    timer = requestAnimationFrame(record);
    return () => { cancelAnimationFrame(timer); return state; };
  }, comparisonPhase);
  const started = Date.now();
  const resume = page.getByRole('button', { name: 'Resume' });
  await resume.focus();
  await page.keyboard.press('Enter');
  const rows = page.getByRole('table', { name: 'Shopify price diff' }).locator('tbody tr');
  await expect(rows).toHaveCount(10, { timeout: 60_000 });
  const readyMs = Date.now() - started;
  const frameStats = await probe.evaluate((stop) => stop());
  expect(frameStats.frames).toBeGreaterThan(2);
  expect(frameStats.maxGapMs).toBeLessThan(1000);
  expect(frameStats.phases).toContain('Comparing prices');
  await expect(page.getByRole('status').filter({ hasText: 'Local processing complete.' })).toBeAttached();
  expect(page.workers().some((item) => item !== worker && item.url() === worker.url())).toBe(true);
  expect(downloads).toEqual([]);
  const pager = page.getByRole('navigation', { name: 'Pagination' });
  await expect(pager).toContainText('1–10 of 20,000');
  await pager.getByRole('button', { name: 'Next page' }).click();
  await expect(pager).toContainText('11–20 of 20,000');
  await expect(rows.first()).toContainText('0000011');
  if (info.project.name === 'desktop') await capture(page, 'desktop-m3-20k-queue', 'Before / after price diff');
  const search = page.getByRole('searchbox', { name: 'Search by SKU or Handle' });
  await search.fill('0020000');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('coat-9999');
  await search.fill('coat-9999');
  await expect(rows).toHaveCount(2);
  await recordWidth(page, info);
  const csv = await downloadText(page, nativeButton, 'catalog-price-update.csv');
  const downloadMs = Date.now() - started;
  const [headers, ...out] = parseDownload(csv);
  expect(headers).toEqual(updateHeaders);
  const baseline = Papa.parse<string[]>(pair.baseline.buffer.toString('utf8'), { delimiter: ',' }).data.slice(1);
  const changes = new Map(Papa.parse<string[]>(pair.supplier.buffer.toString('utf8'), { delimiter: ',' }).data.slice(1).map(([sku, amount]) => [sku, amount]));
  expect(changes.size).toBe(10_000);
  expect(out).toHaveLength(20_000);
  for (const [i, row] of baseline.entries()) {
    const [handle, title, name, option, sku, original] = row;
    deepStrictEqual(out[i], [handle, title, name, option, '', '', '', '', sku, changes.get(sku) ?? original], 'Export variant ' + (i + 1));
  }
  expect(downloads).toEqual(['catalog-price-update.csv']);
  info.annotations.push({ type: '20k-worker', description: JSON.stringify({
    readyMs, resumeThroughDownloadMs: downloadMs, ...frameStats, bytes: Buffer.byteLength(csv), rows: out.length,
    groups: changes.size, pageSize: 10, workerPath: new URL(worker.url()).pathname,
  }) });
});

test('the guarded bank CSV neutralizes literal formula text and preserves signed decimals in the downloaded bytes and audit', async ({ page, beginProcessing }, info) => {
  await page.goto('/quickbooks-csv-fixer', { waitUntil: 'networkidle' });
  const created = page.waitForEvent('worker');
  beginProcessing();
  await page.getByLabel('Choose CSV file').setInputFiles(resolve('tests/unit/core/guard-bank.csv'));
  const worker = await created;
  expect(new URL(worker.url()).pathname).toMatch(/^\/assets\/diff\.worker-.*\.js$/);
  const guard = page.getByRole('checkbox', { name: /Guard spreadsheet formulas/ });
  await expect(guard).not.toBeChecked();
  expect((await downloadCsv(page, 'guard-bank', 'CRLF'))[1].slice(1)).toEqual([formula, '-12.50']);
  await guard.check();
  await expect(page.getByRole('status').filter({ hasText: '2 spreadsheet formula cells neutralized.' })).toBeVisible();
  expect((await downloadCsv(page, 'guard-bank', 'CRLF')).slice(1).map((row) => row.slice(1))).toEqual([["'" + formula, '-12.50'], ["'+medical", '42.01']]);
  const audit = JSON.parse(await downloadText(page, 'Download Audit Report (.json)', 'guard-bank.audit.json'));
  expect(audit.formulaGuard).toEqual({ enabled: true, blocked: [], neutralized: [
    { row: 2, column: 'Description', before: formula, after: "'" + formula },
    { row: 3, column: 'Description', before: '+medical', after: "'+medical" },
  ] });
  await recordWidth(page, info);
});

test('a native Shopify formula guard blocks an affected title and keeps its exact source value in the downloadable audit', async ({ page, beginProcessing }) => {
  await page.goto(route, { waitUntil: 'networkidle' });
  beginProcessing();
  const title = '  ' + formula + '  ';
  await uploadPair(page, catalog(2, title));
  const guard = page.getByRole('checkbox', { name: /Guard spreadsheet formulas/ });
  await expect(guard).not.toBeChecked();
  const csv = parseDownload(await downloadText(page, nativeButton, 'catalog-price-update.csv'));
  expect(csv.slice(1).map((row) => row[1])).toEqual([title, '']);
  await guard.check();
  await expect(page.getByRole('status').filter({ hasText: '0 native CSV cells neutralized · 1 native CSV cells require protection.' })).toBeVisible();
  await expect(page.getByRole('button', { name: nativeButton })).toBeDisabled();
  const audit = JSON.parse(await downloadText(page, 'Download Full Diff Audit (.json)', 'catalog-price-diff.audit.json'));
  expect(audit.formulaGuard).toEqual({ enabled: true, neutralized: [], blocked: [{ row: 2, column: 'Title', before: title, after: "'" + title }] });
  expect(audit.rows[0].baselineCells[1].value).toBe(title);
});
