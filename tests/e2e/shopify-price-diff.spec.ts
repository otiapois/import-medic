import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import Papa from 'papaparse';
import { assertFits, downloadText, m2Screenshot, test } from './browser';

const fixture = (name: string) => resolve('fixtures/shopify-price-diff', name);
const csvDownload = 'Download Safe Shopify Update CSV';
const compareAt = 'Variant Compare At Price';
const requiredHeaders = [
  'Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value',
  'Variant SKU', 'Variant Price',
];
const verification = { checked: true, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 };

interface AuditedRow {
  sku: string;
  handle: string | null;
  status: string;
  baselineRow: number | null;
  supplierRow: number | null;
  oldPrice: string | null;
  newPrice: string | null;
  deltaPercent: string | null;
  baselineCells: { value: string | null; kind: string }[] | null;
  supplierCells: { value: string | null; kind: string }[] | null;
  priceOutput: string;
  compareAtOutput: string;
  resolution: object | null;
  issues: object[];
}

async function loadPair(page: Page, baseline: string, supplier: string) {
  await page.getByLabel('Choose Shopify baseline CSV').setInputFiles(fixture(baseline));
  await page.getByLabel('Choose supplier price sheet').setInputFiles(fixture(supplier));
  await expect(page.getByText(supplier, { exact: true })).toBeVisible();
}

async function verifyUpdate(page: Page, firstPrice: string, mapped: boolean) {
  const button = page.getByRole('button', { name: csvDownload });
  await expect(button).toBeEnabled();
  await expect(page.getByTestId('price-verification')).toHaveText('Local CSV check · 0 non-target fields changed · 0 variant groups broken.');
  const csv = await downloadText(page, csvDownload, 'baseline-agency-price-update.csv');
  expect(csv).toContain('\n');
  expect(csv).not.toContain('\r');
  const parsed = Papa.parse<string[]>(csv, { delimiter: ',', newline: '\n' });
  expect(parsed.errors).toEqual([]);
  const [headers, ...records] = parsed.data;
  const allowed = mapped ? [...requiredHeaders, compareAt] : requiredHeaders;
  expect(headers).toEqual(allowed);
  const original = Papa.parse<Record<string, string>>(await readFile(fixture('baseline-agency.csv'), 'utf8'), { header: true, skipEmptyLines: true });
  expect(original.errors).toEqual([]);
  const siblings = original.data.filter((row) => row.Handle === 'canvas-jacket' && row['Variant SKU']);
  expect(siblings.map((row) => row['Variant SKU'])).toEqual(['00123', '00045-XL', '00046-L']);
  expect(siblings[0].Title).toBe('  Canvas Jacket  ');
  // Derive the expected projection from the independent baseline bytes, including blank option names and titles.
  expect(records).toEqual(siblings.map((row) => allowed.map((header) => {
    if (header === 'Variant Price' && row['Variant SKU'] === '00123') return firstPrice;
    if (header === 'Variant Price' && row['Variant SKU'] === '00045-XL') return '24.00';
    if (header === compareAt && row['Variant SKU'] === '00045-XL') return '32.00';
    return row[header];
  })));
  return headers;
}

async function verifyAudits(page: Page, headers: string[], skipped: boolean) {
  const base = 'baseline-agency-price-diff.audit';
  const audit = JSON.parse(await downloadText(page, 'Download Full Diff Audit (.json)', base + '.json'));
  const csv = await downloadText(page, 'Download Full Diff Audit (.csv)', base + '.csv');
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, delimiter: ',' });
  expect(parsed.errors).toEqual([]);
  expect(audit).toMatchObject({
    status: 'ready', verification, baseline: { name: 'baseline-agency.csv' }, supplier: { name: 'Agency prices' },
    columns: { included: headers, compareAtMapped: !skipped, omittedBaselineHeaders: expect.arrayContaining(['Body (HTML)', 'Tags', 'Image Src']) },
  });
  expect(audit.unclassifiedSupplierRows).toEqual([]);
  const rows: AuditedRow[] = audit.rows;
  expect(rows.map((row) => [row.sku, row.baselineRow, row.supplierRow, row.status])).toEqual([
    ['00123', 2, 2, skipped ? 'Skipped' : 'Updated'], ['00045-XL', 4, 5, 'Updated'], ['00046-L', 5, null, 'Missing in Supplier'],
    ['P-01', 7, null, 'Missing in Supplier'], ['P-02', 8, null, 'Missing in Supplier'], ['AGENCY-NEW', null, 8, 'Unmatched Supplier Row'],
  ]);
  expect(rows[0]).toMatchObject({ oldPrice: '100.00', newPrice: skipped ? '100.00' : '92.00', priceOutput: 'value',
    resolution: skipped ? { skip: true } : { price: '92.00' }, supplierCells: expect.arrayContaining([expect.objectContaining({ value: '00123', kind: 'text' })]) });
  expect(rows[1]).toMatchObject({ oldPrice: '20.00', newPrice: '24.00', deltaPercent: '20' });
  expect(rows[2].compareAtOutput).toBe(skipped ? 'omitted' : 'empty');
  expect(audit.preservedBaselineRows.map((row: { line: number }) => row.line)).toEqual([6]);
  const [summary, ...auditRows] = parsed.data;
  expect(summary.Status).toBe('Run summary');
  expect(JSON.parse(summary['Review and Resolution (JSON)'])).toMatchObject({ verification, columns: audit.columns, mapping: audit.mapping, status: 'ready' });
  expect(auditRows).toHaveLength(rows.length + 1);
  for (const [index, row] of rows.entries()) {
    const record = auditRows[index];
    expect(record).toMatchObject({
      Status: row.status, SKU: row.sku, Handle: row.handle ?? '', 'Baseline Row': String(row.baselineRow ?? ''), 'Supplier Row': String(row.supplierRow ?? ''),
      'Old Price': row.oldPrice ?? '', 'New Price': row.newPrice ?? '', 'Delta %': row.deltaPercent ?? '', 'Price Output': row.priceOutput, 'Compare At Output': row.compareAtOutput,
    });
    expect(JSON.parse(record['Original Supplier Cells (JSON)'])).toEqual(row.supplierCells);
    expect(JSON.parse(record['Original Baseline Cells (JSON)'])).toEqual(row.baselineCells);
    expect(JSON.parse(record['Review and Resolution (JSON)'])).toEqual({ issues: row.issues, resolution: row.resolution });
  }
  expect(auditRows.at(-1)).toMatchObject({ Status: 'Preserved baseline record', 'Baseline Row': '6' });
  expect(JSON.parse(auditRows.at(-1)!['Original Baseline Cells (JSON)'])).toEqual(audit.preservedBaselineRows[0].cells);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/shopify-price-update-diff', { waitUntil: 'networkidle' });
});

test('a sparse XLSX price drop can be skipped or overridden with two real exports and lossless audits', async ({ page, beginProcessing }, info) => {
  beginProcessing();
  await loadPair(page, 'baseline-agency.csv', 'supplier-agency.xlsx');
  const sheet = page.getByLabel('Supplier worksheet');
  await sheet.selectOption({ label: 'Secondary' });
  await expect(page.getByTestId('price-diff-status')).toHaveText('Ready to download');
  await sheet.selectOption({ label: 'Agency prices' });
  const row = page.locator('[data-supplier-row="2"]');
  const filters = page.getByRole('group', { name: 'Filter price diff' });
  await filters.getByRole('button', { name: 'Flagged' }).click();
  await expect(page.getByRole('table', { name: 'Shopify price diff' }).locator('tbody tr')).toHaveCount(1);
  await expect(row).toHaveAttribute('data-status', 'Blocked');
  await expect(row).toContainText('00123');
  await expect(row.getByRole('cell', { name: '-60%', exact: true })).toBeVisible();
  await expect(row).toContainText('This price drops more than the selected threshold.');
  await expect(page.getByRole('button', { name: csvDownload })).toBeDisabled();
  await assertFits(page);
  if (info.project.name === 'desktop') await m2Screenshot(page, 'desktop-shopify-flagged', 'Before / after price diff');
  await filters.getByRole('button', { name: 'All rows' }).click();
  await row.getByLabel('Skip row').check();
  await expect(row).toHaveAttribute('data-status', 'Skipped');
  await expect(row).toContainText('Included unchanged with product group');
  await verifyAudits(page, await verifyUpdate(page, '100.00', false), true);
  // Mapping a compare-at column clears the previous skip and requires a fresh confirmation.
  await page.getByLabel('Compare-at price column').selectOption('2');
  await expect(page.getByRole('button', { name: csvDownload })).toBeDisabled();
  await page.getByRole('button', { name: 'Confirm columns' }).click();
  await expect(row).toHaveAttribute('data-status', 'Blocked');
  await row.getByRole('button', { name: 'Edit price' }).click();
  await row.getByLabel('Override price', { exact: true }).fill('92.00');
  await row.getByRole('button', { name: 'Apply override' }).click();
  await expect(row).toHaveAttribute('data-status', 'Updated');
  await expect(page.getByTestId('price-diff-status')).toHaveText('Ready to download');
  await filters.getByRole('button', { name: 'Updated' }).click();
  await expect(page.getByRole('table', { name: 'Shopify price diff' }).locator('tbody tr')).toHaveCount(2);
  // Clicking review controls can scroll the inner table right. Restore its SKU / Before / After view for the evidence.
  await page.getByRole('region', { name: 'Price diff scrollable table' }).evaluate((region) => { region.scrollLeft = 0; });
  await m2Screenshot(page, info.project.name + '-shopify-diff', 'Before / after price diff');
  await verifyAudits(page, await verifyUpdate(page, '92.00', true), false);
});

test('ambiguous supplier columns need an explicit choice and confirmation, and the single-click demo is labeled synthetic', async ({ page, beginProcessing }) => {
  beginProcessing();
  await page.getByRole('button', { name: 'Load Synthetic Agency Demo' }).click();
  await expect(page.getByText('Synthetic file', { exact: true })).toHaveCount(2);
  await expect(page.locator('[data-supplier-row="3"]')).toContainText('00045-XL');
  await page.getByLabel('Choose supplier price sheet').setInputFiles(fixture('supplier-ambiguous-mapping.csv'));
  const sku = page.getByLabel('SKU column');
  const price = page.getByLabel('New price column');
  await expect(sku).toHaveValue('');
  await expect(price).toHaveValue('');
  await expect(page.getByRole('button', { name: csvDownload })).toBeDisabled();
  await sku.selectOption('0');
  await price.selectOption('2');
  await expect(page.getByRole('button', { name: csvDownload })).toBeDisabled();
  await expect(page.getByRole('table', { name: 'Shopify price diff' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Confirm columns' }).click();
  await expect(page.getByRole('button', { name: csvDownload })).toBeEnabled();
  const matched = page.locator('[data-supplier-row="2"]');
  await expect(matched).toContainText('00045-XL');
  await expect(matched.getByRole('cell', { name: '23.00', exact: true })).toBeVisible();
  await assertFits(page);
});

test('both duplicate sources and scientific Excel SKU cells block the update at the exact source lines', async ({ page, beginProcessing }) => {
  beginProcessing();
  await loadPair(page, 'baseline-duplicate-sku.csv', 'supplier-agency.csv');
  const button = page.getByRole('button', { name: csvDownload });
  await expect(page.getByText('Baseline rows 2, 5 · Variant SKU', { exact: true })).toBeVisible();
  await expect(button).toBeDisabled();
  await loadPair(page, 'baseline-agency.csv', 'supplier-duplicate-sku.csv');
  await expect(page.getByText('Supplier rows 2, 3 · SKU', { exact: true })).toBeVisible();
  await expect(button).toBeDisabled();
  await page.getByLabel('Choose supplier price sheet').setInputFiles(fixture('supplier-scientific.xlsx'));
  const invalid = page.locator('[data-supplier-row="7"]');
  await expect(invalid).toHaveAttribute('data-status', 'Blocked');
  await expect(invalid).toContainText('scientific notation');
  await expect(button).toBeDisabled();
  await assertFits(page);
});
