import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertFits } from './browser';
import { save } from './m7-files';

export const bookkeeper = 'Download Bookkeeper Sign-Off (.html)';
export const marker = '<audit-note title="A&B">review</audit-note>';

// Open the bytes delivered to the download event, with the browser network offline.
export async function offlineReport(page: Page, info: TestInfo, name: string, filename: string) {
  const file = await save(page, info, name, filename, 'm8-offline');
  expect(file.text).not.toMatch(/<script\b|https?:\/\//i);
  await page.context().setOffline(true);
  const report = await page.context().newPage();
  await report.goto(pathToFileURL(file.path).href);
  expect(new URL(report.url()).protocol).toBe('file:');
  await expect(report.locator('a[href], script, link[href], [src], [srcset], iframe, form, base, object, embed, audit-note')).toHaveCount(0);
  expect(await report.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toBe(
    "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  );
  expect(await report.locator('*').evaluateAll(nodes => nodes.flatMap(node => node.getAttributeNames().filter(key => /^on/i.test(key))))).toEqual([]);
  await assertFits(report);
  return { report, source: file.text };
}

export async function metric(root: Page | Locator, label: string, value: string) {
  await expect(root.locator('dt').filter({ hasText: new RegExp('^' + label + '$') }).locator('..').locator('dd')).toHaveText(value);
}

export async function picture(page: Page, anchor: Locator, filename: string) {
  if (process.env.IMPORT_MEDIC_CAPTURE_M8_SCREENSHOTS !== '1') return;
  await assertFits(page);
  await page.evaluate(() => document.fonts.ready);
  await anchor.evaluate(element => window.scrollBy(0, element.getBoundingClientRect().top - 18));
  const folder = resolve('docs/reports/screenshots/m8');
  await mkdir(folder, { recursive: true });
  await page.screenshot({ path: resolve(folder, filename + '.png'), animations: 'disabled' });
}
