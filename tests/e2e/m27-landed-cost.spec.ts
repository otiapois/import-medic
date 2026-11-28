import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strToU8, unzipSync, zipSync } from 'fflate';
import Papa from 'papaparse';
import { assertFits, test } from './browser';
import { auditPage } from './m10-accessibility';

const fixture = (name: string) => resolve('fixtures/m27', name);
const panel = (page: Page) => page.getByTestId('landed-cost-panel');
const field = (page: Page, name: string) => panel(page).getByLabel(name, { exact: true });
const status = (page: Page) => page.getByTestId('landed-cost-status');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const filenames = { csv: 'shipment-landed-cost.csv', html: 'landed-cost-sheet.html', audit: 'landed-cost-audit.json' } as const;
const buttons = { csv: 'Download True Landed Cost CSV', html: 'Download Branded Landed-Cost Sheet (.html)', audit: 'Download Landed Cost Audit JSON' } as const;
const downloadButton = (page: Page, kind: keyof typeof filenames) => panel(page).getByRole('button', { name: buttons[kind], exact: true });
const input = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });

async function open(page: Page, begin: () => void) {
  await page.goto('/shopify-price-update-diff', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Inventory Sync', exact: true }).click();
  const choice = page.getByRole('group', { name: 'Inventory workflow' }).getByRole('button', { name: 'Landed Cost Calculator', exact: true });
  await choice.focus();
  await choice.press('Enter');
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await expect(status(page)).toHaveAttribute('data-ready', 'false');
  await page.waitForLoadState('networkidle');
  begin();
}
async function download(page: Page, info: TestInfo, stage: string, kind: keyof typeof filenames) {
  const [item] = await Promise.all([page.waitForEvent('download'), downloadButton(page, kind).click()]);
  const filename = filenames[kind];
  expect(item.suggestedFilename()).toBe(filename);
  const root = process.env.IMPORT_MEDIC_M27_DOWNLOADS;
  const path = root ? resolve(root, info.project.name, stage, filename) : info.outputPath(stage, filename);
  await mkdir(dirname(path), { recursive: true });
  await item.saveAs(path);
  expect(await item.failure()).toBeNull();
  return { path, bytes: await readFile(path) };
}
async function screenshot(page: Page, anchor: Locator, name: string) {
  if (process.env.IMPORT_MEDIC_CAPTURE_M27_SCREENSHOTS !== '1') return;
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await anchor.evaluate(e => window.scrollBy({ top: e.getBoundingClientRect().top - 16, behavior: 'instant' }));
  const path = resolve('docs/reports/screenshots/m27', name + '.png');
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, animations: 'disabled' });
}
async function keyboardScroll(page: Page, region: Locator) {
  await region.focus();
  await expect(region).toBeFocused();
  await region.evaluate(el => { el.scrollLeft = 0; });
  expect(await region.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
  await region.press('ArrowRight');
  await expect.poll(() => region.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
  await assertFits(page);
}

// Independent cent allocations for the shipped 3/7/11-unit invoice. Each bucket has its own remainder ranking.
const allocations = {
  'by-value': { dutyBase: 'CIF', duty: '833', grand: '20316', uplift: ['131.68%', '136.59%', '120.32%'], values: [
    ['00042','38.08','0.79','1.16','0.07','3.79','77.22','25.7400','25.74'],
    ['00007','31.91','0.67','0.97','0.06','4.54','66.08','9.4400','9.44'],
    ['00901','31.04','0.65','0.94','0.06','0.00','59.86','5.4418','5.45'],
  ] },
  'by-weight': { dutyBase: 'FOB', duty: '384', grand: '19867', uplift: ['43.71%', '275.22%', '69.19%'], values: [
    ['00042','12.17','0.26','0.37','0.02','1.75','47.90','15.9667','15.97'],
    ['00007','71.01','1.48','2.16','0.13','2.09','104.80','14.9714','14.98'],
    ['00901','17.85','0.37','0.54','0.04','0.00','45.97','4.1791','4.18'],
  ] },
} as const;
const columns = ['SKU','Allocated Freight','Allocated Insurance','Allocated Handling','Allocated Other Charges',
  'Customs Duty','Landed Extended Cost','Landed Unit Cost','Cost'];
const cents = (amount: string) => BigInt(amount.replace('.', ''));
const bucketKeys = ['freightCents', 'insuranceCents', 'handlingCents', 'otherChargesCents', 'landedExtendedCents'];

test('Container invoice allocates every fee by value and weight and opens the branded breakdown offline', async ({ page, beginProcessing }, info) => {
  await open(page, beginProcessing);
  await panel(page).getByRole('button', { name: 'Load Synthetic Container Import Demo', exact: true }).click();
  await expect(status(page)).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('landed-cost-total-grand')).toHaveText('203.16 USD');
  await expect(page.getByTestId('landed-cost-rows').locator('tbody tr')).toHaveCount(3);
  const access = await auditPage(page, 'workbench');
  const shotAnchor = info.project.name === 'desktop' ? panel(page).locator('.landed-currency-fields')
    : panel(page).getByRole('heading', { name: 'Shipment totals' });
  await screenshot(page, shotAnchor, info.project.name + '-m27-landed-cost');
  const source = await readFile(fixture('container-invoice.csv'));
  await field(page, 'Choose shipment invoice').setInputFiles(fixture('container-invoice.csv'));
  const brand = 'Harbor <carrier-note> & Co.';
  const brandNote = 'Details at https://example.invalid/ship and //manifest.invalid/fees';
  const drawer = panel(page).locator('.signoff-branding summary');
  await drawer.click();
  await field(page, 'Agency name').fill(brand);
  await field(page, 'Prepared for').fill('Northstar Imports');
  await field(page, 'Contact email or note').fill(brandNote);
  await drawer.click();

  for (const method of ['by-value', 'by-weight'] as const) {
    const expected = allocations[method];
    await field(page, 'Allocation method').selectOption(method);
    await field(page, 'Duty base').selectOption(expected.dutyBase);
    await expect(status(page)).toHaveAttribute('data-ready', 'true');
    await expect(page.getByTestId('landed-cost-kpis').locator('dd')).toHaveText([
      '88.43 USD', '106.40 USD', method === 'by-value' ? '8.33 USD' : '3.84 USD',
      method === 'by-value' ? '203.16 USD' : '198.67 USD', '0.00 drift',
    ]);
    const csv = await download(page, info, method, 'csv');
    const html = await download(page, info, method, 'html');
    const audit = JSON.parse((await download(page, info, method, 'audit')).bytes.toString('utf8'));
    expect(audit.status).toBe('ready');
    expect(audit.custody).toEqual({ sourceSha256: hash(source), csvSha256: hash(csv.bytes), htmlSha256: hash(html.bytes) });
    expect(audit.options).toMatchObject({ method, dutyBase: expected.dutyBase, currency: 'USD', sourceCurrency: 'USD' });
    expect(audit.issues).toEqual([]);
    const parsed = Papa.parse<Record<string, string>>(new TextDecoder('utf-8', { fatal: true }).decode(csv.bytes), { header: true, delimiter: ',', skipEmptyLines: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.data.map(row => columns.map(col => row[col]))).toEqual(expected.values);
    const monetaryColumns = [1, 2, 3, 4, 6];
    for (const [i, total] of ['10103', '211', '307', '19', expected.grand].entries()) {
      expect(audit.proof[bucketKeys[i]]).toEqual({ expected: total, allocated: total, drift: '0' });
      expect(parsed.data.reduce((sum, row) => sum + cents(row[columns[monetaryColumns[i]]]), 0n)).toBe(BigInt(total));
    }
    expect(parsed.data.reduce((sum, row) => sum + cents(row['Customs Duty']), 0n)).toBe(BigInt(expected.duty));
    for (const [index, row] of expected.values.entries()) {
      expect(cents(parsed.data[index]['Allocated Insurance & Handling'])).toBe(cents(row[2]) + cents(row[3]));
      const displayed = page.getByTestId('landed-cost-rows').locator('tbody tr').nth(index);
      await expect(displayed).toHaveAttribute('data-source-line', String(index + 2));
      await expect(displayed.getByRole('rowheader')).toContainText(row[0]);
      await expect(displayed.getByRole('cell').nth(7)).toHaveText(row[6]);
      await expect(displayed.getByRole('cell').nth(8)).toContainText(row[7]);
      await expect(displayed.getByRole('cell').nth(9)).toHaveText(expected.uplift[index]);
    }
    if (method === 'by-value') continue;
    if (info.project.name === 'mobile') await keyboardScroll(page, page.getByTestId('landed-cost-rows'));
    const raw = html.bytes.toString('utf8');
    expect(raw).not.toContain('//');
    await page.context().setOffline(true);
    const offline = await page.context().newPage(), requests: string[] = [];
    offline.on('request', request => requests.push(request.url()));
    const url = pathToFileURL(html.path).href;
    await offline.goto(url);
    expect(offline.url()).toBe(url);
    await expect(offline.getByRole('heading', { name: 'Landed-Cost Breakdown' })).toBeVisible();
    const branding = offline.getByRole('complementary', { name: 'Agency branding', exact: true });
    for (const content of [brand, 'Northstar Imports', brandNote]) await expect(branding).toContainText(content);
    await expect(offline.locator('script,[src],[srcset],[href],[action],[formaction],[poster],base,form,iframe,object,embed,carrier-note')).toHaveCount(0);
    expect(await offline.locator('*').evaluateAll(nodes => nodes.flatMap(n => n.getAttributeNames().filter(a => /^on/i.test(a))))).toEqual([]);
    await expect(offline.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content',
      "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    const ledger = offline.getByRole('region', { name: 'Shipment lines', exact: true });
    await expect(ledger.getByRole('rowheader')).toHaveText(['00042', '00007', '00901']);
    await expect(ledger.getByRole('cell', { name: '104.80', exact: true })).toBeVisible();
    await expect(offline.getByRole('region', { name: 'Exact penny proof', exact: true }).locator('tbody tr td:last-child')).toHaveText(Array(5).fill('0.00'));
    for (const digest of [hash(source), hash(csv.bytes)]) await expect(offline.locator('footer')).toContainText(digest);
    await assertFits(offline);
    if (info.project.name === 'mobile') await keyboardScroll(offline, ledger);
    else await screenshot(offline, branding, 'desktop-m27-landed-cost-html');
    await offline.emulateMedia({ media: 'print' });
    await offline.setViewportSize({ width: 702, height: 995 });
    const printBounds = await offline.locator('table').evaluateAll(tables => tables.map(table => ({
      left: table.getBoundingClientRect().left, right: table.getBoundingClientRect().right,
    })));
    for (const bounds of printBounds) {
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(702);
    }
    await expect(ledger.locator('thead')).toHaveCSS('display', 'table-header-group');
    await expect(ledger.locator('tbody tr').first()).toHaveCSS('break-inside', 'avoid');
    expect(requests).toEqual([url]);
    info.annotations.push({ type: 'm27-offline', description: JSON.stringify({ access, viewport: page.viewportSize(),
      version: page.context().browser()?.version(), requests, printBounds, custody: audit.custody }) });
    await offline.close();
  }
});

test('Missing weight, zero CBM and duplicate physical SKUs withhold the financial files', async ({ page, beginProcessing }, info) => {
  await open(page, beginProcessing);
  await field(page, 'FOB invoice currency').fill('USD');
  await field(page, 'Target store currency').fill('USD');
  const missing = await readFile(fixture('container-missing-weight.csv'), 'utf8');
  const duplicate = 'SKU,Quantity,FOB Unit Cost,Description\r\n00007,1,0.01,"First\r\nline"\r\n00007,2,0.02,Again\r\n';
  const samples = [
    { name: 'missing-weight', source: input('container-missing-weight.csv', missing), method: 'by-weight', code: 'invalid-unit-weight', line: 3 },
    { name: 'zero-cbm', source: input('zero-volume.csv', missing.replace(',,0.09,', ',1,0,')), method: 'by-cbm', code: 'invalid-unit-cbm', line: 3 },
    { name: 'duplicate', source: input('repeated.csv', duplicate), method: 'by-units', code: 'duplicate-sku', line: 2 },
  ];
  for (const sample of samples) {
    await field(page, 'Allocation method').selectOption(sample.method);
    await field(page, 'Choose shipment invoice').setInputFiles(sample.source);
    await expect(status(page)).toHaveAttribute('data-held', 'true');
    await expect(page.getByTestId('landed-cost-issues').locator('[data-issue-code="' + sample.code + '"]')).toContainText('Shipment line ' + sample.line);
    await expect(downloadButton(page, 'csv')).toBeDisabled();
    await expect(downloadButton(page, 'html')).toBeDisabled();
    const audit = JSON.parse((await download(page, info, sample.name, 'audit')).bytes.toString('utf8'));
    expect(audit.status).toBe('blocked');
    expect(audit.custody).toEqual({ sourceSha256: hash(sample.source.buffer) });
    expect(audit.issues).toContainEqual(expect.objectContaining({ code: sample.code, line: sample.line, sku: '00007',
      ...(sample.name === 'duplicate' ? { lines: [2, 4] } : {}) }));
  }
  const clear = panel(page).getByRole('button', { name: 'Clear shipment invoice', exact: true });
  await clear.focus(); await clear.press('Enter');
  await expect(field(page, 'Choose shipment invoice')).toBeFocused();
  await expect(downloadButton(page, 'audit')).toBeDisabled();
});

test('A visible shipment worksheet and confirmed manual FX unlock the exact converted line', async ({ page, beginProcessing }, info) => {
  await open(page, beginProcessing);
  const book = unzipSync(await readFile(resolve('fixtures/supplier-delta/synthetic-pricebook.xlsx')));
  const headers = ['SKU', 'Quantity', 'FOB Unit Cost', 'Duty Rate %'];
  const stringCell = (ref: string, value: string) => '<c r="' + ref + '" t="inlineStr"><is><t>' + value + '</t></is></c>';
  book['xl/worksheets/sheet2.xml'] = strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">' +
    headers.map((h, i) => stringCell('ABCD'[i] + '1', h)).join('') + '</row><row r="7">' + stringCell('A7', '0017') +
    '<c r="B7"><v>3</v></c><c r="C7"><v>0.03</v></c><c r="D7"><v>12.5</v></c></row></sheetData></worksheet>');
  const bytes = Buffer.from(zipSync(book, { mtime: new Date(2020, 0, 1) }));
  await field(page, 'Choose shipment invoice').setInputFiles({ name: 'shipment.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
  const sheets = field(page, 'Shipment worksheet');
  await expect(sheets.locator('option')).toHaveText(['Choose a visible worksheet', 'Instructions', 'Q4_Prices', 'Q3_Prices']);
  await expect(sheets).toHaveValue('');
  await field(page, 'FOB invoice currency').fill('EUR');
  await field(page, 'Target store currency').fill('USD');
  await field(page, 'Manual FX rate').fill('0.5');
  await expect(downloadButton(page, 'csv')).toBeDisabled();
  await sheets.selectOption('Q4_Prices');
  await expect(downloadButton(page, 'csv')).toBeDisabled();
  await field(page, 'Confirm manual FX rate').focus();
  await field(page, 'Confirm manual FX rate').press('Space');
  await expect(status(page)).toHaveAttribute('data-ready', 'true');
  const fxCsv = await download(page, info, 'worksheet-fx', 'csv');
  const fxHtml = await download(page, info, 'worksheet-fx', 'html');
  const audit = JSON.parse((await download(page, info, 'worksheet-fx', 'audit')).bytes.toString('utf8'));
  expect(audit.source.selectedWorksheet).toBe('Q4_Prices');
  expect(audit.custody).toEqual({ sourceSha256: hash(bytes), csvSha256: hash(fxCsv.bytes), htmlSha256: hash(fxHtml.bytes) });
  expect(audit.rows).toMatchObject([{ sku: '0017', line: 7, quantity: '3', sourceFobCents: '9', fobCents: '4', dutyCents: '0', landedUnitCost: '0.0133' }]);
  const access = await auditPage(page, 'workbench');
  info.annotations.push({ type: 'm27-fx-access', description: JSON.stringify(access) });
  await field(page, 'Manual FX rate').fill('1');
  await expect(field(page, 'Confirm manual FX rate')).not.toBeChecked();
  await expect(downloadButton(page, 'csv')).toBeDisabled();
});
