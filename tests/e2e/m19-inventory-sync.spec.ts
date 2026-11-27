import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertFits, test } from './browser';
import { auditPage } from './m10-accessibility';
import { button, csv, field, parseCsv, save } from './m7-files';
import { metric } from './m8-reports';

const updateLabel = 'Inventory Update CSV';
const rollbackLabel = 'Inventory Rollback CSV';
const auditLabel = 'Inventory Audit JSON';
const signoffLabel = 'Inventory Sign-Off (.html)';
const consent = (page: Page) => field(page, 'Approve stock drops over 80% for this run');
const target = (page: Page) => field(page, 'Target Location');
const fingerprint = (page: Page, name: string) => page.locator('[data-custody-field="' + name + '"]');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const workbook = resolve('fixtures/supplier-delta/synthetic-pricebook.xlsx');
const localFeed = csv('count-sheet.csv', [['Count', 'Item code'], ['11', '00277']]);
const header = 'Handle,Title,Option 1 Name,Option 1 Value,SKU,Location,HS Code,Available,On hand (new),Bin name,On hand (current)';
// The B rows deliberately contain redundant quotes, UTF-8 text and an embedded CRLF.
const records = [
  'pen,"  Pen, blue  ",Size,S,00123,Warehouse A,9608,31,900,North,0012',
  'pen,"  Pen, blue  ",Size,S,"00123","Warehouse B",9608,44,777,"区 B\r\nline 2",00044',
  'case,Case,Size,M,0045-BLK,Warehouse A,4202,14,800,Rack,009',
  'wrap,Paper,Size,M,KEPT,Warehouse A,4811,26,998,Roll,025',
  'paper,Paper,Size,L,00277,Warehouse A,4811,3,997,Roll,+0002',
  'wrap,"Paper",Size,M,KEPT,"Warehouse B",4811,72,996,"A, B",00071',
  'box,Box,Size,M,UNMATCHED,Warehouse A,4819,0,995,Rack,-002',
];
const baseline = { name: 'location-snapshot.csv', mimeType: 'text/csv', buffer: Buffer.from([header, ...records, ''].join('\r\n')) };

async function start(page: Page, begin: () => void, agency: string, client: string) {
  await page.goto('/shopify-price-update-diff', { waitUntil: 'networkidle' });
  const studio = page.getByRole('tablist', { name: /studio/i });
  await expect(studio.getByRole('tab').first()).toHaveAccessibleName('Build Update');
  await expect(studio.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
  const inventory = studio.getByRole('tab', { name: 'Inventory Sync', exact: true });
  await inventory.click();
  await expect(page.getByRole('heading', { name: 'Sync inventory at one Shopify location' })).toBeVisible();
  begin();
  await studio.getByRole('tab').first().click();
  const profile = page.locator('.workspace-profile');
  await profile.locator(':scope > summary').click();
  await profile.locator('.signoff-branding > summary').click();
  await field(page, 'Agency name').fill(agency);
  await field(page, 'Prepared for').fill(client);
  await field(page, 'Contact email or note').fill('November inventory reconciliation');
  await page.getByRole('radio', { name: 'Navy' }).check();
  await inventory.click();
}

async function held(page: Page) {
  for (const label of [updateLabel, rollbackLabel]) await expect(button(page, label)).toBeDisabled();
  for (const name of ['update', 'rollback']) await expect(fingerprint(page, name)).toHaveCount(0);
}

async function approve(page: Page) {
  await expect(consent(page)).not.toBeChecked();
  await consent(page).focus();
  await consent(page).press('Space');
  for (const label of [updateLabel, rollbackLabel]) await expect(button(page, label)).toBeEnabled();
  await expect(consent(page)).toBeChecked();
}

async function capture(page: Page, name: string, anchor?: Locator) {
  await assertFits(page);
  if (process.env.IMPORT_MEDIC_CAPTURE_M19_SCREENSHOTS !== '1') return;
  const directory = resolve('docs/reports/screenshots/m19');
  await mkdir(directory, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  if (anchor) await anchor.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 14));
  else await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(directory, name + '.png'), animations: 'disabled' });
}

async function openReport(page: Page, info: TestInfo, stage: string) {
  const file = await save(page, info, signoffLabel, 'inventory-sign-off.html', stage);
  const context = page.context();
  await context.setOffline(true);
  const report = await context.newPage();
  await report.goto(pathToFileURL(file.path).href);
  expect(new URL(report.url()).protocol).toBe('file:');
  await expect(report.getByRole('heading', { name: 'Inventory Sync Sign-Off' })).toBeVisible();
  await expect(report.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content',
    "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  await expect(report.locator('a[href],script,link[href],[src],[srcset],iframe,form,base,object,embed,agency-note,client-note')).toHaveCount(0);
  expect(await report.locator('*').evaluateAll(nodes => nodes.flatMap(el => el.getAttributeNames().filter(name => /^on/i.test(name))))).toEqual([]);
  await assertFits(report);
  return report;
}

function replay(update: string, rollback: string) {
  const expected = new Map([['00123', '15'], ['KEPT', '0'], ['00277', '8']]);
  const identity = header.split(',').slice(0, 6);
  const nativeHeader = [...identity, 'On hand (current)', 'On hand (new)'];
  const source = records.map(raw => ({ raw, cells: parseCsv(raw)[0] }));
  const otherBefore = Buffer.from(source.filter(row => row.cells[5] === 'Warehouse B').map(row => row.raw + '\r\n').join(''));
  const phase = (text: string, forward: boolean) => {
    const [columns, ...patch] = parseCsv(text);
    expect(columns).toEqual(nativeHeader);
    expect(patch.map(row => row[4])).toEqual([...expected.keys()]);
    for (const row of patch) {
      expect(row).toHaveLength(8);
      expect(row[5]).toBe('Warehouse A');
      const matches = source.filter(({ cells }) => cells[0] === row[0] && cells[3] === row[3] && cells[5] === row[5]);
      expect(matches).toHaveLength(1);
      const record = matches[0];
      expect(row.slice(0, 6)).toEqual(record.cells.slice(0, 6));
      const before = record.raw.slice(record.raw.lastIndexOf(',') + 1);
      expect(row[6], 'On hand (current) must match the exact stored cell before this write').toBe(before);
      expect(row[7]).toBe(forward ? expected.get(row[4]) : record.cells.at(-1));
      record.raw = record.raw.slice(0, record.raw.lastIndexOf(',') + 1) + row[7];
    }
    const other = Buffer.from(source.filter(row => row.cells[5] === 'Warehouse B').map(row => row.raw + '\r\n').join(''));
    expect(other.equals(otherBefore), 'Every byte at the other location survives this native file').toBe(true);
  };
  phase(update, true);
  phase(rollback, false);
  expect(Buffer.from([header, ...source.map(row => row.raw), ''].join('\r\n')).equals(baseline.buffer)).toBe(true);
  return { restoredRows: expected.size, otherBytes: otherBefore.length, otherSha256: sha(otherBefore), baselineBytes: baseline.buffer.length };
}

test('Inventory demo holds the unselected location and reviewed stock drops, then resets stale approvals when scope or reserve changes', async ({ page, beginProcessing }, info) => {
  await start(page, beginProcessing, 'Northline Inventory Studio', 'Field Supply Co.');
  await button(page, 'Load Synthetic Multi-Location Demo').click();
  await expect(target(page).locator('option')).toHaveText(['Choose a location', 'Warehouse A', 'Warehouse B']);
  await expect(target(page)).toHaveValue('');
  await held(page);
  await expect(page.locator('[data-inventory-issue="target-location-required"]')).toBeVisible();
  await target(page).selectOption('Warehouse A');
  await expect(page.locator('[data-inventory-issue="large-stock-drop"]')).toContainText('00042');
  await held(page);
  const table = page.getByRole('table', { name: 'Inventory before and after' });
  const row = (sku: string) => table.getByRole('row').filter({ has: page.getByText(sku, { exact: true }) });
  await expect(row('00041').locator('td code')).toHaveText(['012', '19', '17', '+5', '2']);
  await expect(row('00042')).toContainText('Approval required');
  await expect(row('00043')).toContainText('Unchanged');
  await expect(row('00044')).toContainText('No supplier match');
  const access = await auditPage(page, 'workbench');
  await approve(page);
  await expect(row('00042')).toContainText('Large drop approved');
  const rects = await table.locator('tbody code, tbody .delta-row-status').evaluateAll(nodes => nodes.flatMap(el => {
    const cell = el.closest('th,td')!.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    return [...range.getClientRects()].some(r => r.left < Math.max(cell.left, 0) - 1 ||
      r.right > Math.min(cell.right, window.innerWidth) + 1) ? [el.textContent] : [];
  }));
  expect(rects, 'Every value and status fits within its cell and the viewport').toEqual([]);
  const prefix = info.project.name;
  await capture(page, prefix + '-m19-inventory-sync', prefix === 'desktop' ? page.locator('.inventory-settings') : page.getByRole('heading', { name: 'Review inventory changes' }));
  const offline = await openReport(page, info, 'm19-demo');
  await expect(offline.locator('body')).toContainText('Northline Inventory Studio');
  await expect(offline.locator('body')).toContainText('Field Supply Co.');
  await metric(offline, 'Units added', '5');
  await metric(offline, 'Units removed', '2');
  if (prefix === 'desktop') await capture(offline, 'desktop-m19-inventory-signoff');
  await offline.close();
  await page.context().setOffline(false);
  const old = await fingerprint(page, 'update').innerText();
  await field(page, 'Safety reserve units').fill('3');
  await expect(consent(page)).not.toBeChecked();
  await held(page);
  await approve(page);
  await expect(fingerprint(page, 'update')).not.toHaveText(old);
  await target(page).selectOption('Warehouse B');
  await expect(consent(page)).not.toBeChecked();
  await held(page);
  await target(page).selectOption('');
  await expect(page.locator('[data-inventory-issue="target-location-required"]')).toBeVisible();
  await held(page);
  info.annotations.push({ type: 'm19-accessibility', description: JSON.stringify({ browser: page.context().browser()?.version(), viewport: page.viewportSize(), access }) });
});

test('Two actual supplier files scope the native inventory CAS pair and restore exact source bytes with offline branded custody', async ({ page, beginProcessing }, info) => {
  const agency = '<agency-note label="A&B">North</agency-note>';
  const client = '<client-note>O’Brien & Sons</client-note>';
  await start(page, beginProcessing, agency, client);
  await field(page, 'Choose Shopify Inventory CSV').setInputFiles(baseline);
  await field(page, 'Choose supplier stock sheet').setInputFiles(workbook);
  const sheet = field(page, 'Supplier 1 worksheet');
  await expect(sheet.locator('option')).toHaveText(['Choose a visible worksheet', 'Instructions', 'Q4_Prices', 'Q3_Prices']);
  await expect(sheet).toHaveValue('');
  await held(page);
  await sheet.selectOption('Q4_Prices');
  const map = async (slot: number, sku: string, qty: string) => {
    await field(page, 'Supplier ' + slot + ' SKU column').selectOption(sku);
    await field(page, 'Supplier ' + slot + ' quantity column').selectOption(qty);
  };
  await expect(field(page, 'Supplier 1 SKU column')).toHaveValue('');
  await map(1, '0', '2');
  await button(page, '+ Add another supplier sheet').click();
  await field(page, 'Choose supplier stock sheet 2').setInputFiles(localFeed);
  await map(2, '1', '0');
  await field(page, 'Safety reserve units').fill('3');
  await field(page, 'Zero-out threshold').fill('4');
  await field(page, 'Max cap (optional)').fill('15');
  await target(page).selectOption('Warehouse A');
  await expect(page.locator('[data-inventory-issue="large-stock-drop"]')).toContainText('KEPT');
  await held(page);
  const get = (label: string, file: string, stage = 'm19-two-feeds') => save(page, info, label, file, stage);
  const heldAudit = JSON.parse((await get(auditLabel, 'inventory-audit.json', 'm19-upload-held')).text);
  expect(heldAudit.status).toBe('blocked');
  expect(heldAudit.custody).not.toHaveProperty('updateCsvSha256');
  expect(heldAudit.custody).not.toHaveProperty('rollbackCsvSha256');
  await approve(page);
  const update = await get(updateLabel, 'inventory-update.csv');
  const rollback = await get(rollbackLabel, 'inventory-rollback.csv');
  const result = replay(update.text, rollback.text);
  const auditFile = await get(auditLabel, 'inventory-audit.json');
  const audit = JSON.parse(auditFile.text);
  expect(audit).toMatchObject({ status: 'ready', targetLocation: 'Warehouse A', totals: {
    unitsAdded: 9, unitsRemoved: 25, changedCount: 3, bufferZeroedCount: 1, outOfStockCount: 2,
  }, mappings: [{ skuHeader: 'SKU', quantityHeader: 'Inventory' }, { skuHeader: 'Item code', quantityHeader: 'Count' }],
    verification: { checked: true, restoredRows: 3, otherLocationRowsUntouched: 2 } });
  const bookBytes = await readFile(workbook);
  const workbookName = 'synthetic-pricebook.xlsx';
  const custody = {
    baseline: { filename: baseline.name, byteLength: baseline.buffer.length, sha256: sha(baseline.buffer) },
    suppliers: [{ filename: workbookName, sheetName: 'Q4_Prices', byteLength: bookBytes.length, sha256: sha(bookBytes) },
      { filename: localFeed.name, byteLength: localFeed.buffer.length, sha256: sha(localFeed.buffer) }],
    updateCsvSha256: sha(await readFile(update.path)), rollbackCsvSha256: sha(await readFile(rollback.path)),
  };
  expect(audit.custody).toEqual(custody);
  const hashes = [custody.baseline.sha256, ...custody.suppliers.map(s => s.sha256), custody.updateCsvSha256, custody.rollbackCsvSha256];
  for (const [i, key] of ['baseline', 'supplier-1', 'supplier-2', 'update', 'rollback'].entries()) await expect(fingerprint(page, key)).toHaveText(hashes[i]);
  for (const [name, bytes] of [[baseline.name, baseline.buffer], [workbookName, bookBytes], [localFeed.name, localFeed.buffer]] as const) {
    await writeFile(resolve(dirname(auditFile.path), name), bytes);
  }
  const offline = await openReport(page, info, 'm19-two-feeds');
  await expect(offline.locator('body')).toContainText(agency);
  await expect(offline.locator('body')).toContainText(client);
  await expect(offline.locator('footer code')).toHaveText(hashes);
  await expect(offline.locator('footer')).toContainText('Q4_Prices');
  for (const [label, value] of [['Units added', '9'], ['Units removed', '25'], ['SKUs zeroed by safety buffer', '1'], ['Out-of-stock count', '2']]) {
    await metric(offline, label, value);
  }
  await offline.close();
  await page.context().setOffline(false);
  await sheet.selectOption('Q3_Prices');
  await held(page);
  await expect(field(page, 'Supplier 1 quantity column')).toHaveValue('');
  await map(1, '0', '2');
  await expect(consent(page)).not.toBeChecked();
  await held(page);
  await approve(page);
  const revised = JSON.parse((await get(auditLabel, 'inventory-audit.json', 'm19-switched-sheet')).text);
  expect(revised.custody.suppliers[0]).toEqual({ ...custody.suppliers[0], sheetName: 'Q3_Prices' });
  expect(revised.custody.updateCsvSha256).not.toBe(custody.updateCsvSha256);
  info.annotations.push({ type: 'm19-native-replay', description: JSON.stringify({ ...result, custody, auditSha256: sha(await readFile(auditFile.path)),
    signOffSha256: sha(await readFile(resolve(dirname(auditFile.path), 'inventory-sign-off.html'))) }) });
});
