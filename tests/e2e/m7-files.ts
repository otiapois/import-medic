import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Papa from 'papaparse';
import { assertFits } from './browser';

export const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
export const field = (page: Page, name: string) => page.getByLabel(name, { exact: true });
export const csv = (name: string, matrix: string[][]) => ({
  name, mimeType: 'text/csv', buffer: Buffer.from(Papa.unparse(matrix, { newline: '\r\n' }), 'utf8'),
});
export const skuRow = (page: Page, sku: string) => page.getByRole('row').filter({
  has: page.getByRole('rowheader').getByText(sku, { exact: true }),
});
export function parseCsv(text: string) {
  const parsed = Papa.parse<string[]>(text, { delimiter: ',', skipEmptyLines: true });
  expect(parsed.errors).toEqual([]);
  return parsed.data;
}
export async function openStudio(page: Page, begin: () => void) {
  await page.goto('/shopify-price-update-diff', { waitUntil: 'networkidle' });
  begin();
}
export async function pair(page: Page, platform: 'Shopify' | 'WooCommerce', enabled: boolean) {
  for (const name of ['Download Safe ' + platform + ' Update CSV', 'Download ' + platform + ' Rollback CSV']) {
    if (enabled) await expect(button(page, name)).toBeEnabled();
    else await expect(button(page, name)).toBeDisabled();
  }
}
export async function save(page: Page, info: TestInfo, label: string, filename: string, stage: string) {
  const [item] = await Promise.all([page.waitForEvent('download'), button(page, label).click()]);
  expect(item.suggestedFilename()).toBe(filename);
  const root = process.env.IMPORT_MEDIC_M7_DOWNLOADS;
  const path = root ? resolve(root, info.project.name, stage, filename) : info.outputPath(stage, filename);
  await mkdir(dirname(path), { recursive: true });
  await item.saveAs(path);
  expect(await item.failure()).toBeNull();
  const bytes = await readFile(path);
  expect(bytes.length).toBeGreaterThan(0);
  expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  return { path, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
}
export async function openSignoff(page: Page, info: TestInfo, name: string, stage: string) {
  const report = await save(page, info, 'Download Client Sign-Off (.html)', name + '-client-sign-off.html', stage);
  const offline = await page.context().newPage();
  await offline.goto(pathToFileURL(report.path).href);
  await assertFits(offline);
  expect(new URL(offline.url()).protocol).toBe('file:');
  expect(basename(report.path)).toBe(name + '-client-sign-off.html');
  await expect(offline.locator('a[href], script, link[href], [src], iframe, form')).toHaveCount(0);
  const csp = await offline.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp?.split('; ')).toEqual(expect.arrayContaining(["default-src 'none'", "script-src 'none'", "connect-src 'none'"]));
  return offline;
}
export async function capture(page: Page, info: TestInfo, anchor: Locator, filename: string) {
  await assertFits(page);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  info.annotations.push({ type: 'm7-document-width', description: JSON.stringify({ filename, width }) });
  if (process.env.IMPORT_MEDIC_CAPTURE_M7_SCREENSHOTS !== '1') return;
  await page.evaluate(() => document.fonts.ready);
  await anchor.evaluate(element => window.scrollBy(0, element.getBoundingClientRect().top - 18));
  const dir = resolve('docs/reports/screenshots/m7');
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, filename + '.png'), animations: 'disabled' });
}
