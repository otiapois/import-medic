import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Papa from 'papaparse';
import { assertFits, test } from './browser';
import { auditPage } from './m10-accessibility';

const fixture = (name: string) => resolve('fixtures/m25', name);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const panel = (page: Page) => page.getByTestId('catalog-hygiene-panel');
const status = (page: Page) => page.getByTestId('catalog-hygiene-status');
const brand = 'Harbor <catalog-note> & Co.';
const offlineCsp = "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

async function openHygiene(page: Page, begin: () => void, visitCampaign = false) {
  await page.goto('/shopify-price-update-diff', { waitUntil: 'networkidle' });
  const tabs = page.getByRole('tablist', { name: /studio/i });
  await expect(tabs.getByRole('tab')).toHaveCount(6);
  if (visitCampaign) {
    await tabs.getByRole('tab', { name: 'Sale Campaign Pack', exact: true }).click();
    await expect(page.getByTestId('campaign-panel')).toBeVisible();
    await page.waitForLoadState('networkidle');
  }
  await tabs.getByRole('tab', { name: 'Verify Update / Rollback CSV', exact: true }).click();
  const group = page.getByRole('group', { name: 'CSV verification view', exact: true });
  await expect(group.getByRole('button', { name: 'Verify Update / Rollback', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const hygiene = group.getByRole('button', { name: 'Catalog & Barcode Hygiene', exact: true });
  await hygiene.focus();
  await hygiene.press('Enter');
  await expect(hygiene).toHaveAttribute('aria-pressed', 'true');
  await expect(panel(page)).toHaveCSS('display', 'grid');
  await page.waitForLoadState('networkidle');
  begin();
}

async function takeFile(page: Page, info: TestInfo, stage: string, button: Locator, filename: string) {
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(download.suggestedFilename()).toBe(filename);
  const root = process.env.IMPORT_MEDIC_M7_DOWNLOADS;
  const path = root ? resolve(root, info.project.name, stage, filename) : info.outputPath(stage, filename);
  await mkdir(dirname(path), { recursive: true });
  await download.saveAs(path);
  expect(await download.failure()).toBeNull();
  const bytes = await readFile(path);
  expect(bytes.length).toBeGreaterThan(0);
  return { filename, path, bytes, sha256: hash(bytes), byteLength: bytes.length };
}

async function diagnostics(page: Page, info: TestInfo, stage: string) {
  const buttons = panel(page).getByRole('group', { name: 'Catalog hygiene diagnostics' });
  const save = (label: string, filename: string) => takeFile(page, info, stage, buttons.getByRole('button', { name: label, exact: true }), filename);
  const issues = await save('Download Hygiene Issues CSV', 'catalog-hygiene-issues.csv');
  const audit = await save('Download Audit JSON', 'catalog-hygiene-audit.json');
  const report = await save('Download Branded Offline Hygiene Report (.html)', 'catalog-hygiene-report.html');
  return { issues, audit: JSON.parse(audit.bytes.toString('utf8')), report };
}

type FileReceipt = Awaited<ReturnType<typeof takeFile>>;
const receipt = ({ filename, byteLength, sha256 }: FileReceipt) => ({ filename, byteLength, sha256 });
function matrix(bytes: Buffer, newline: '\n' | '\r\n') {
  const csv = Papa.parse<string[]>(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { delimiter: ',', newline, skipEmptyLines: true });
  expect(csv.errors).toEqual([]);
  return csv.data;
}

async function screenshot(page: Page, anchor: Locator, name: string) {
  if (process.env.IMPORT_MEDIC_CAPTURE_M25_SCREENSHOTS !== '1') return;
  await page.evaluate(() => document.fonts.ready);
  await anchor.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 16));
  const dir = resolve('docs/reports/screenshots/m25');
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, name + '.png'), animations: 'disabled' });
}

test('Catalog hygiene holds invalid EAN and separate SKU and GTIN collisions at exact physical lines', async ({ page, beginProcessing }, info) => {
  await openHygiene(page, beginProcessing);
  const editor = panel(page);
  const file = 'shopify-hold.csv';
  await editor.getByRole('button', { name: 'Load Synthetic GS1 & Duplicate SKU Audit Demo' }).click();
  await expect(status(page)).toHaveAttribute('data-state', 'hold');
  await editor.getByLabel('Choose primary catalog CSV').setInputFiles(fixture(file));
  await expect(editor.getByTestId('catalog-hygiene-scannedRows')).toHaveText('3');
  await expect(editor.getByTestId('catalog-hygiene-invalidBarcodes')).toHaveText('1');
  await expect(editor.getByTestId('catalog-hygiene-duplicateSkus')).toHaveText('2');
  await expect(editor.getByTestId('catalog-hygiene-safeTrimFixes')).toHaveText('0');
  await expect(editor.getByRole('group', { name: /catalog CSV pair/i })).toHaveCount(0);
  const filter = editor.getByLabel('Filter catalog hygiene issues');
  for (const [code, line, related] of [['duplicate-sku-case', '2', '5'], ['duplicate-gtin', '5', '6']]) {
    await filter.selectOption(code);
    const card = editor.locator('[data-issue-code="' + code + '"]');
    await expect(card.locator('strong')).toHaveText('Primary catalog · line ' + line);
    await expect(card.getByRole('listitem')).toContainText('Primary catalog · line ' + related + ' (' + file + ')');
    await expect(editor.locator('[data-issue-code]')).toHaveCount(1);
  }
  await filter.selectOption('invalid-gtin-check-digit');
  const invalid = editor.locator('[data-issue-code="invalid-gtin-check-digit"]');
  await expect(invalid.locator('strong')).toHaveText('Primary catalog · line 2');
  await expect(invalid.locator('dd')).toHaveText(['"4006381333932"', '2', '1']);
  await assertFits(page);
  const access = await auditPage(page, 'workbench');
  await screenshot(page, status(page), info.project.name === 'desktop' ? 'desktop-m25-hygiene-audit' : 'mobile-m25-hygiene');
  const { issues, audit, report } = await diagnostics(page, info, 'm25-hold');
  const rows = matrix(issues.bytes, '\r\n');
  expect(rows.slice(1).map(row => row.slice(0, 11))).toEqual(expect.arrayContaining([
    ['1', file, '2', 'Variant Barcode', 'blocked', 'invalid-gtin-check-digit', '4006381333932', '', '1', '2', ''],
    ['1', file, '2', 'Variant SKU', 'blocked', 'duplicate-sku-case', 'AURORA-01', '', '', '', '1:5'],
    ['1', file, '5', 'Variant Barcode', 'blocked', 'duplicate-gtin', '012345678905', '', '', '', '1:6'],
  ]));
  expect(audit.status).toBe('HOLD');
  expect(audit.sources[0].sha256).toBe(hash(await readFile(fixture(file))));
  expect(audit.custody.outputs.sort((a: FileReceipt, b: FileReceipt) => a.filename.localeCompare(b.filename))).toEqual([issues, report].map(receipt));
  expect(audit.issues).toContainEqual(expect.objectContaining({ code: 'invalid-gtin-check-digit', line: 2, value: '4006381333932', expectedCheckDigit: '1', suppliedCheckDigit: '2' }));
  info.annotations.push({ type: 'm25-hold', description: JSON.stringify({ viewport: page.viewportSize(), access, summary: audit.summary, source: audit.sources[0] }) });
});

test('Catalog cleanup authenticates both native pairs, prevents stale exports and opens the branded report disconnected', async ({ page, beginProcessing }, info) => {
  await openHygiene(page, beginProcessing);
  const editor = panel(page);
  const primary = editor.getByLabel('Choose primary catalog CSV');
  const secondary = editor.getByLabel('Choose secondary catalog CSV');
  const trim = editor.getByLabel('Trim outer SKU whitespace');
  const strip = editor.getByLabel('Remove allowlisted zero-width characters');
  await expect(trim).not.toBeChecked();
  await expect(strip).not.toBeChecked();
  await editor.locator('.signoff-branding summary').click();
  await editor.getByLabel('Agency name').fill(brand);
  await editor.getByLabel('Prepared for').fill('Aurora Merchants');
  await editor.locator('.signoff-branding summary').click();

  // A BOM and CRLF, including inside a quoted cell, must be recoverable byte for byte.
  const readyText = (await readFile(fixture('shopify-ready.csv'), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n|\r|\n/g, '\r\n');
  const original = Buffer.from('\uFEFF' + readyText);
  const name = 'Aurora & Harbor.csv';
  await primary.setInputFiles({ name, mimeType: 'text/csv', buffer: original });
  await expect(status(page)).toHaveAttribute('data-state', 'hold');
  const secondName = 'woocommerce-second.csv';
  await editor.getByLabel('Secondary catalog platform').selectOption('woocommerce');
  await secondary.setInputFiles(fixture(secondName));
  const cross = editor.locator('[data-issue-code="duplicate-sku-cleanup"]');
  await expect(cross.locator('strong')).toHaveText('Primary catalog · line 2');
  await expect(cross.getByRole('listitem')).toHaveText('Secondary catalog · line 2 (' + secondName + ')');
  const shared = editor.locator('[data-issue-code="duplicate-gtin"]');
  await expect(shared.locator('strong')).toHaveText('Primary catalog · line 5');
  await expect(shared.getByRole('listitem')).toHaveText('Secondary catalog · line 2 (' + secondName + ')');
  await trim.focus();
  await trim.press('Space');
  await strip.focus();
  await strip.press('Space');
  await expect(status(page)).toHaveAttribute('data-state', 'hold');
  await expect(editor.getByTestId('catalog-hygiene-safeTrimFixes')).toHaveText('0');
  await expect(editor.getByRole('button', { name: 'Download cleaned catalog CSV' })).toHaveCount(0);
  await expect(editor.locator('[data-issue-code="trim-sku"]')).toHaveAttribute('data-level', 'warning');
  // Give the second store its own SKU and GTIN so both file pairs become eligible.
  const cleanSecond = Buffer.from((await readFile(fixture(secondName), 'utf8'))
    .replace('AURORA-01', 'HARBOR-02').replace('4006381333931', '96385074'));
  await secondary.setInputFiles({ name: secondName, mimeType: 'text/csv', buffer: cleanSecond });
  await expect(status(page)).toHaveAttribute('data-state', 'ready');
  await expect(editor.getByTestId('catalog-hygiene-safeTrimFixes')).toHaveText('1');
  await expect(editor.locator('[data-issue-code="trim-sku"]')).toHaveAttribute('data-level', 'fixed');
  await expect(editor.locator('[data-issue-code="strip-zero-width"]')).toHaveAttribute('data-level', 'fixed');
  const stage = 'm25-ready';
  const { issues, audit, report } = await diagnostics(page, info, stage);
  expect(audit.status).toBe('READY');
  expect(audit.options).toEqual({ trimSkus: true, stripZeroWidth: true });
  expect(audit.sources.map((source: { sha256: string }) => source.sha256)).toEqual([hash(original), hash(cleanSecond)]);
  const emitted = [issues, report];
  for (const [index, [label, bytes]] of ([
    ['Primary', original], ['Secondary', cleanSecond],
  ] as const).entries()) {
    const group = editor.getByRole('group', { name: label + ' catalog CSV pair', exact: true });
    const stem = 'catalog-hygiene-source-' + (index + 1);
    const clean = await takeFile(page, info, stage, group.getByRole('button', { name: 'Download cleaned catalog CSV' }), stem + '-cleaned.csv');
    const rollback = await takeFile(page, info, stage, group.getByRole('button', { name: 'Download rollback CSV' }), stem + '-rollback.csv');
    expect(rollback.bytes.equals(bytes)).toBe(true);
    if (index === 0) {
      const expected = matrix(original, '\r\n');
      expect(expected[1]!.slice(2, 5)).toEqual([' AURORA-01 ', '18.50', '01234\u200b5678905']);
      expected[1]![2] = 'AURORA-01';
      expected[1]![4] = '012345678905';
      expect(matrix(clean.bytes, '\n')).toEqual(expected);
    } else {
      expect(matrix(clean.bytes, '\r\n')).toEqual(matrix(cleanSecond, cleanSecond.includes('\r\n') ? '\r\n' : '\n'));
    }
    emitted.push(clean, rollback);
  }
  expect(audit.custody.outputs).toHaveLength(emitted.length);
  expect(audit.custody.outputs).toEqual(expect.arrayContaining(emitted.map(receipt)));
  await assertFits(page);
  await secondary.setInputFiles(fixture(secondName));
  await expect(editor.getByRole('group', { name: /catalog CSV pair/i })).toHaveCount(0);
  await expect(status(page)).toHaveAttribute('data-state', 'hold');
  await expect(editor.getByRole('button', { name: 'Download rollback CSV' })).toHaveCount(0);
  const clear = editor.getByRole('button', { name: 'Clear secondary catalog CSV' });
  await clear.focus();
  await clear.press('Enter');
  await expect(secondary).toBeFocused();
  await expect(status(page)).toHaveAttribute('data-state', 'ready');
  await expect(editor.getByRole('group', { name: /catalog CSV pair/i })).toHaveCount(1);

  await page.context().setOffline(true);
  const offline = await page.context().newPage();
  const requests: string[] = [];
  offline.on('request', request => requests.push(request.url()));
  const url = pathToFileURL(report.path).href;
  await offline.goto(url);
  expect(offline.url()).toBe(url);
  await expect(offline.getByRole('heading', { name: 'Catalog & Barcode Hygiene Report' })).toBeVisible();
  const branding = offline.getByRole('complementary', { name: 'Agency branding' });
  await expect(branding).toContainText(brand);
  await expect(branding).toContainText('Aurora Merchants');
  await expect(offline.locator('script,[src],[srcset],[href],base,form,iframe,embed,object,catalog-note')).toHaveCount(0);
  await expect(offline.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', offlineCsp);
  const visible = await offline.locator('footer').innerText();
  for (const digest of [hash(original), hash(cleanSecond), ...emitted.filter(file => file !== report).map(file => file.sha256)]) expect(visible).toContain(digest);
  expect(requests).toEqual([url]);
  await assertFits(offline);
  if (info.project.name === 'desktop') await screenshot(offline, branding, 'desktop-m25-hygiene-report');
  await offline.close();
  info.annotations.push({ type: 'm25-ready', description: JSON.stringify({ browser: page.context().browser()?.version(), viewport: page.viewportSize(),
    sources: audit.sources, outputs: emitted.map(receipt), offlineSubresources: requests.length - 1 }) });
});

test('Campaign handoff opens native verification after using catalog hygiene', async ({ page, beginProcessing }) => {
  await openHygiene(page, beginProcessing, true);
  await panel(page).getByRole('button', { name: 'Load Synthetic GS1 & Duplicate SKU Audit Demo' }).click();
  await expect(status(page)).toHaveAttribute('data-state', 'hold');
  await page.getByRole('tab', { name: 'Sale Campaign Pack', exact: true }).click();
  await page.getByRole('button', { name: 'Load Synthetic Promo Demo' }).click();
  await expect(page.getByTestId('campaign-metric-held')).toHaveText('1');
  await page.getByLabel('Minimum retail floor').fill('9.99');
  await page.getByTestId('campaign-open-verify').click();
  await expect(page.getByRole('button', { name: 'Verify Update / Rollback', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('verify-load-pair').click();
  await expect(page.getByTestId('verify-verdict')).toHaveText('PASS');
});
