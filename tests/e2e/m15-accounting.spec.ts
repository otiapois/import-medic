import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertFits, loadFile, test } from './browser';
import { button, csv, field, parseCsv, save } from './m7-files';
import { bookkeeper, metric, offlineReport } from './m8-reports';

const csvButton = 'Download Repaired CSV';
const auditButton = 'Download Audit Report (.json)';
const chainTitle = 'Running-Balance Chain Audit';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fixtureDigest = async (fixture: string) => digest(await readFile(resolve('fixtures', fixture)));

async function openProfile(page: Page, name: string, startMonitoring: () => void) {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name, exact: true }).click();
  startMonitoring();
}

async function expectFingerprints(page: Page, source: string, repaired?: string) {
  const strip = page.getByTestId('custody-fingerprints');
  if (!(await strip.evaluate(element => (element as HTMLDetailsElement).open))) await strip.locator('summary').click();
  const hashes = strip.locator('code[data-custody-field]');
  await expect(hashes).toHaveText(repaired ? [source, repaired] : [source]);
  await expect(hashes.first()).toBeVisible();
  await expect(strip.locator('[data-custody-field="repaired"]')).toHaveCount(repaired ? 1 : 0);
}

async function expectChainContrast(root: Locator, info: TestInfo, state: string) {
  // Read actual Edge paint for the status, labels and amounts, including inherited transparent backgrounds.
  const samples = await root.locator('h2,h3,p,dt,dd,strong,td,th').evaluateAll(elements => {
    const rgb = (text: string) => text.match(/[\d.]+/g)!.map(Number);
    const luminance = (channels: number[]) => channels.slice(0, 3).reduce((sum, c, i) => {
      const value = c / 255;
      return sum + [0.2126, 0.7152, 0.0722][i]! * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    }, 0);
    return elements.filter(el => Array.from(el.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()))
      .map(el => {
        let surface: Element | null = el;
        while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
        const bg = luminance(surface ? rgb(getComputedStyle(surface).backgroundColor) : [255, 255, 255]);
        const fg = luminance(rgb(getComputedStyle(el).color));
        return { label: el.textContent?.trim(), ratio: (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05) };
      });
  });
  expect(samples.length).toBeGreaterThan(6);
  expect(samples.filter(x => x.ratio < 4.5)).toEqual([]);
  info.annotations.push({ type: 'm15-text-contrast', description: JSON.stringify({ state, samples: samples.length, minimum: Math.min(...samples.map(x => x.ratio)) }) });
}

async function capture(page: Page, anchor: Locator, filename: string, spaceAbove: number) {
  await assertFits(page);
  if (process.env.IMPORT_MEDIC_CAPTURE_M15_SCREENSHOTS !== '1') return;
  await page.evaluate(() => document.fonts.ready);
  await anchor.evaluate((el, offset) => window.scrollBy(0, el.getBoundingClientRect().top - offset), spaceAbove);
  const folder = resolve(process.env.IMPORT_MEDIC_M15_SCREENSHOTS ?? 'docs/reports/screenshots/m15');
  await mkdir(folder, { recursive: true });
  await page.screenshot({ path: resolve(folder, filename + '.png'), animations: 'disabled' });
}

test('Xero real statement verifies linked balances, native CSV bytes and offline bookkeeper custody', async ({ page, beginProcessing }, info) => {
  await openProfile(page, 'Xero Bank CSV', beginProcessing);
  const fixture = 'xero-bank/balance-verified.csv';
  await loadFile(page, fixture);
  const chain = page.getByRole('region', { name: chainTitle });
  await expect(chain).toHaveAttribute('data-balance-status', 'VERIFIED');
  await expect(chain.getByRole('status')).toHaveText('Verified (2/2 links)');
  await metric(chain, 'Opening balance', '100.00');
  await metric(chain, 'Net movement', '97.30');
  await metric(chain, 'Closing balance', '197.30');
  await expect(page.getByTestId('manual-review-count')).toHaveText('0');
  await expectChainContrast(chain, info, 'verified workbench');
  await page.getByRole('tab', { name: 'Before / After Table' }).click();
  await expect(page.getByRole('table', { name: 'Original CSV' }).getByText('(45.20)', { exact: true })).toBeAttached();
  await expect(page.getByRole('table', { name: 'Repaired CSV' }).getByText('-45.20', { exact: true })).toBeAttached();
  const desktop = info.project.name === 'desktop';
  await capture(page, page.getByRole('region', { name: 'Repair results' }), desktop ? 'desktop-m15-xero-balance-verified' : 'mobile-m15-xero', 16);

  const native = await save(page, info, csvButton, 'balance-verified-repaired.csv', 'm15-verified');
  expect(parseCsv(native.text)).toEqual([
    ['*Date', '*Amount', 'Payee', 'Description', 'Reference', 'Check Number'],
    ['2026/05/01', '100.00', 'Opening payee', 'First deposit\nconfirmed on the statement', '00017', '00091'],
    ['2026/05/02', '-45.20', "'=SAFE_REVIEW()", 'Supplies', '00018', '00092'],
    ['2026/05/03', '42.50', 'Sample payer', 'Final deposit', '00019', '00093'],
  ]);
  const sourceSha256 = await fixtureDigest(fixture);
  const repairedCsvSha256 = digest(await readFile(native.path));
  await expectFingerprints(page, sourceSha256, repairedCsvSha256);
  const audit = JSON.parse((await save(page, info, auditButton, 'balance-verified.audit.json', 'm15-verified')).text);
  expect(audit.custody).toEqual({ sourceSha256, repairedCsvSha256 });
  expect(audit.balanceChain).toEqual({
    status: 'VERIFIED', direction: 'ascending', currency: 'USD', openingBalance: '100.00', netMovement: '97.30',
    closingBalance: '197.30', verifiedLinks: 2, totalLinks: 2, breaks: [], reasons: [],
  });
  const { report } = await offlineReport(page, info, bookkeeper, 'balance-verified-bookkeeper-sign-off.html');
  const section = report.locator('section').filter({ has: report.getByRole('heading', { name: chainTitle }) });
  await expect(section).toContainText('VERIFIED (2/2 links)');
  await expect(section).toContainText('Verified Chain Links 2/2');
  await metric(section, 'Opening Balance', '100.00');
  await metric(section, 'Net Movement', '97.30');
  await metric(section, 'Closing Balance', '197.30');
  await expect(report.locator('footer dd code')).toHaveText([sourceSha256, repairedCsvSha256]);
  await expectChainContrast(section, info, 'verified offline');
  if (desktop) await capture(report, report.getByRole('heading', { level: 1 }), 'desktop-m15-bookkeeper-signoff', 36);
  await report.close();
});

test('Xero holds a physical line 4 balance break, preserves its reports, and distinguishes the synthetic demo', async ({ page, beginProcessing }, info) => {
  await openProfile(page, 'Xero Bank CSV', beginProcessing);
  const fixture = 'xero-bank/balance-break.csv';
  await loadFile(page, fixture);
  const chain = page.getByRole('region', { name: chainTitle });
  await expect(chain).toHaveAttribute('data-balance-status', 'FAIL_BALANCE_BREAK');
  await expect(chain.getByRole('status')).toHaveText('Balance break at Line 4');
  await metric(chain, 'Expected balance', '152.10');
  await metric(chain, 'Actual balance', '164.60');
  await metric(chain, 'Signed discrepancy', '+12.50');
  await expect(button(page, csvButton)).toBeDisabled();
  await expectChainContrast(chain, info, 'break workbench');
  await page.getByLabel('Filter issues').selectOption('review');
  await expect(page.getByRole('listitem', { name: 'Line 4 · Balance' })).toBeVisible();
  if (info.project.name === 'desktop') await capture(page, page.getByRole('region', { name: 'Repair results' }), 'desktop-m15-balance-break-alert', 16);
  const sourceSha256 = await fixtureDigest(fixture);
  await expectFingerprints(page, sourceSha256);
  const audit = JSON.parse((await save(page, info, auditButton, 'balance-break.audit.json', 'm15-break')).text);
  expect(audit.canDownload).toBe(false);
  expect(audit.custody).toEqual({ sourceSha256 });
  expect(audit.balanceChain).toMatchObject({ status: 'FAIL_BALANCE_BREAK', verifiedLinks: 0, totalLinks: 1,
    breaks: [{ row: 4, expected: '152.10', actual: '164.60', delta: '12.50' }] });
  const { report } = await offlineReport(page, info, bookkeeper, 'balance-break-bookkeeper-sign-off.html');
  const section = report.locator('section').filter({ has: report.getByRole('heading', { name: chainTitle }) });
  await expect(section).toContainText('BALANCE BREAK at Line 4');
  await expect(section).toContainText('Verified Chain Links 0/1');
  await expect(section.locator('tbody tr').locator('th,td')).toHaveText(['4', '152.10', '164.60', '+12.50']);
  await expect(report.locator('footer dd code')).toHaveText([sourceSha256]);
  await expectChainContrast(section, info, 'break offline');
  await report.close();
  await page.context().setOffline(false);

  await button(page, 'Load Synthetic Xero Balance Break Demo').click();
  await expect(chain.getByRole('status')).toHaveText('Balance break at Line 4');
  await metric(chain, 'Expected balance', '1034.80');
  await metric(chain, 'Actual balance', '1047.30');
  await metric(chain, 'Signed discrepancy', '+12.50');
  await expect(button(page, csvButton)).toBeDisabled();
  const demo = JSON.parse((await save(page, info, auditButton, 'synthetic-xero-balance-break.audit.json', 'm15-demo')).text);
  expect(demo.balanceChain).toMatchObject({ verifiedLinks: 1, totalLinks: 2 });
  expect(demo.custody.sourceSha256).not.toBe(sourceSha256);
});

test('Xero ambiguous dates require an explicit input order and reverting it withholds the previous native file', async ({ page, beginProcessing }, info) => {
  await openProfile(page, 'Xero Bank CSV', beginProcessing);
  const source = csv('ambiguous-m15.csv', [
    ['*Date', '*Amount', 'Balance'], ['04/05/2026', '10.00', '110.00'], ['05/05/2026', '2.00', '112.00'],
  ]);
  await field(page, 'Choose CSV file').setInputFiles(source);
  const chain = page.getByRole('region', { name: chainTitle });
  const format = field(page, 'Date format');
  await expect(format).toHaveValue('auto');
  await expect(chain).toHaveAttribute('data-balance-status', 'UNVERIFIABLE');
  await expect(button(page, csvButton)).toBeDisabled();
  await format.selectOption('DMY');
  await expect(chain.getByRole('status')).toHaveText('Verified (1/1 links)');
  const native = await save(page, info, csvButton, 'ambiguous-m15-repaired.csv', 'm15-dmy');
  expect(parseCsv(native.text).slice(1).map(row => row[0])).toEqual(['2026/05/04', '2026/05/05']);
  await expectFingerprints(page, digest(source.buffer), digest(await readFile(native.path)));
  await format.selectOption('auto');
  await expect(chain).toHaveAttribute('data-balance-status', 'UNVERIFIABLE');
  await expect(button(page, csvButton)).toBeDisabled();
  await expectFingerprints(page, digest(source.buffer));
});

test('FreshBooks mixed-currency hold, native single-currency tax readback, and replacing a verified source', async ({ page, beginProcessing }, info) => {
  await openProfile(page, 'FreshBooks CSV', beginProcessing);
  const mixed = 'freshbooks-expenses/mixed-currencies.csv';
  const clean = 'freshbooks-expenses/expenses-verified.csv';
  await loadFile(page, mixed);
  const split = page.getByRole('region', { name: 'Currency split' });
  await expect(split.getByRole('heading')).toHaveText('Mixed currencies block FreshBooks export');
  for (const [currency, line] of [['USD', '2'], ['EUR', '3']]) {
    await split.getByText(currency + ' · 1 line', { exact: true }).click();
    await expect(split.getByTestId('currency-source-lines')).toHaveText(line);
  }
  const mixedSha256 = await fixtureDigest(mixed);
  await expectFingerprints(page, mixedSha256);
  await expect(button(page, csvButton)).toBeDisabled();
  const mixedAudit = JSON.parse((await save(page, info, auditButton, 'mixed-currencies.audit.json', 'm15-mixed')).text);
  expect(mixedAudit.custody).toEqual({ sourceSha256: mixedSha256 });
  expect(mixedAudit.currencySplit).toEqual([{ currency: 'USD', lines: [2] }, { currency: 'EUR', lines: [3] }]);

  await loadFile(page, clean);
  await expect(split).toHaveCount(0);
  await expect(page.getByTestId('manual-review-count')).toHaveText('0');
  const native = await save(page, info, csvButton, 'expenses-verified-repaired.csv', 'm15-expenses');
  expect(parseCsv(native.text)).toEqual([
    ['Date', 'Vendor', 'Category', 'Notes', 'Amount', 'Tax 1 Name', 'Tax 1 Amount', 'Currency'],
    ['2026-05-01', 'Example Office', 'Office Expenses', 'Supplies, labels and paper', '-45.20', 'Sales Tax', '2.20', 'USD'],
    ['2026-05-03', 'Example Cafe', 'Meals', 'Crew meeting', '-15.60', 'Sales Tax', '1.60', 'USD'],
  ]);
  const repairedCsvSha256 = digest(await readFile(native.path));
  const sourceSha256 = await fixtureDigest(clean);
  await expectFingerprints(page, sourceSha256, repairedCsvSha256);
  const audit = JSON.parse((await save(page, info, auditButton, 'expenses-verified.audit.json', 'm15-expenses')).text);
  expect(audit.custody).toEqual({ sourceSha256, repairedCsvSha256 });
  expect(audit.freshBooksTaxes).toEqual([{ row: 2, name: 'Sales Tax', amount: '$2.20' }, { row: 3, name: 'Sales Tax', amount: '1.60' }]);
  const { report } = await offlineReport(page, info, bookkeeper, 'expenses-verified-bookkeeper-sign-off.html');
  const taxes = report.locator('section').filter({ has: report.getByRole('heading', { name: 'FreshBooks tax review' }) });
  await expect(taxes.locator('tbody tr').locator('th,td')).toHaveText(['2', 'Sales Tax', '$2.20', '3', 'Sales Tax', '1.60']);
  await expect(report.locator('footer dd code')).toHaveText([sourceSha256, repairedCsvSha256]);
  await report.close();
  await page.context().setOffline(false);
  await loadFile(page, mixed);
  await expect(split).toBeVisible();
  await expect(button(page, csvButton)).toBeDisabled();
  await expectFingerprints(page, mixedSha256);
});
