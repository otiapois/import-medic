import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { expect, test as base } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import Papa from 'papaparse';

// File processing may start or restart a bundled Worker. Only exact, same-origin
// script paths from the production build are allowed after local inputs arrive.
export const test = base.extend<{ beginProcessing: () => void }>({
  beginProcessing: [async ({ context, baseURL, page }, use, testInfo) => {
    const violations: string[] = [];
    const errors: string[] = [];
    const origin = new URL(baseURL!).origin;
    const scripts = new Set((await readdir(resolve('dist', 'assets')))
      .filter((filename) => filename.endsWith('.js'))
      .map((filename) => `/assets/${filename}`));
    const isBuiltScript = (request: Request, url: URL) => url.origin === origin && !url.search &&
      scripts.has(url.pathname) && request.resourceType() === 'script' && request.method() === 'GET' && request.postData() === null;
    let processing = false;
    const requests = { localHTTP: 0, externalHTTP: 0, processingHTTP: 0, processingScriptHTTP: 0, webSockets: 0 };

    context.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    context.on('weberror', (error) => errors.push(error.error().message));
    context.on('request', (request) => {
      const url = new URL(request.url());
      if (!['http:', 'https:'].includes(url.protocol)) return;
      if (url.origin === origin) requests.localHTTP++;
      else requests.externalHTTP++;
      const builtScript = isBuiltScript(request, url);
      if (processing && builtScript) requests.processingScriptHTTP++;
      else if (processing) requests.processingHTTP++;
      if ((processing && !builtScript) || url.origin !== origin) violations.push(`${request.method()} ${url.href}`);
    });
    await context.route(/^https?:/, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if ((processing && !isBuiltScript(request, url)) || url.origin !== origin) await route.abort();
      else await route.continue();
    });
    await context.routeWebSocket(/.*/, (socket) => {
      requests.webSockets++;
      violations.push(`WebSocket ${socket.url()}`);
      socket.close();
    });
    await use(() => { processing = true; });
    testInfo.annotations.push({ type: 'browser-observations', description: JSON.stringify({ ...requests, consoleOrPageErrors: errors.length }) });
    await assertFits(page);
    expect(violations, 'External requests, or non-bundled HTTP requests during repair and export').toEqual([]);
    expect(errors, 'Browser console and unhandled page errors').toEqual([]);
  }, { auto: true }],
});

export async function assertFits(page: Page) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, 'Horizontal page overflow').toBeLessThanOrEqual(page.viewportSize()!.width);
}

export async function loadFile(page: Page, fixture: string) {
  await page.getByLabel('Choose CSV file').setInputFiles(resolve('fixtures', fixture));
  await expect(page.getByRole('region', { name: 'Repair results' }).getByText(basename(fixture), { exact: true })).toBeVisible();
}

export async function editIssue(page: Page, row: number, column: string, before: string, after: string) {
  await page.getByRole('tab', { name: 'Issues & Review' }).click();
  await page.getByLabel('Filter issues').selectOption('review');
  const issue = page.getByRole('listitem', { name: `Line ${row} · ${column}`, exact: true });
  await expect(issue.getByText(before, { exact: true })).toBeVisible();
  await issue.getByRole('button', { name: 'Edit', exact: true }).click();
  const input = issue.getByLabel('Corrected value');
  await expect(input).toHaveValue(before);
  await input.fill(after);
  await issue.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('manual-review-count')).toHaveText('0');
}

export async function downloadText(page: Page, button: string, filename: string) {
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const download = await waiting;
  expect(download.suggestedFilename()).toBe(filename);
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path!);
  expect(bytes.length).toBeGreaterThan(0);
  expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export async function downloadCsv(page: Page, basename: string, lineEnding: 'LF' | 'CRLF') {
  const text = await downloadText(page, 'Download Repaired CSV', basename + '-repaired.csv');
  const newline = lineEnding === 'LF' ? '\n' : '\r\n';
  expect(text).toContain(newline);
  if (lineEnding === 'LF') expect(text).not.toContain('\r');
  else expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
  const parsed = Papa.parse<string[]>(text, { delimiter: ',', newline });
  expect(parsed.errors).toEqual([]);
  return parsed.data;
}

export async function screenshot(page: Page, filename: string) {
  if (process.env.IMPORT_MEDIC_CAPTURE_SCREENSHOTS !== '1') return;
  const dir = resolve('docs/reports/screenshots');
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, filename + '.png'), animations: 'disabled' });
}

export async function m2Screenshot(page: Page, filename: string, heading: string) {
  if (process.env.IMPORT_MEDIC_CAPTURE_M2_SCREENSHOTS !== '1') return;
  const dir = resolve('docs/reports/screenshots/m2');
  await mkdir(dir, { recursive: true });
  await page.getByRole('heading', { name: heading, exact: true }).evaluate((element) =>
    window.scrollBy(0, element.getBoundingClientRect().top - 24));
  await page.screenshot({ path: resolve(dir, filename + '.png'), animations: 'disabled' });
}

