import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { purchaseOrderDemo } from '../../src/web/workbench/purchase-order/demo';
import { assertFits, test } from './browser';
import { auditPage } from './m10-accessibility';
import { button, csv, field, parseCsv, save } from './m7-files';
import { metric } from './m8-reports';

const review = (page: Page) => page.getByRole('region', { name: 'Purchase order review', exact: true });
const setting = (page: Page, label: string) => page.getByRole('combobox', { name: label, exact: true });
const status = (page: Page) => page.getByTestId('purchase-order-status');
const auditLabel = 'Download PO Audit JSON';
const summaryLabel = 'Download Consolidated Summary CSV';
const htmlLabel = 'Download Branded Offline PO Pack (.html)';
const fingerprint = (filename: string, bytes: Buffer) => ({
  filename, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
});
const archive = async (dir: string, filename: string, bytes: Buffer) => {
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, filename), bytes);
  return fingerprint(filename, bytes);
};

async function openPlanner(page: Page, begin: () => void, brand = false) {
  await page.goto('/shopify-price-update-diff', { waitUntil: 'networkidle' });
  const tabs = page.getByRole('tablist', { name: /studio/i });
  await expect(tabs.getByRole('tab')).toHaveCount(6);
  if (brand) {
    const profile = page.locator('.workspace-profile');
    await profile.locator(':scope > summary').click();
    await profile.locator('.signoff-branding > summary').click();
    await field(page, 'Agency name').fill('Northline Buying Office');
    await field(page, 'Prepared for').fill('Harbor & Field');
    await field(page, 'Contact email or note').fill('Return <buyer-note> & https://example.invalid/procurement');
    await page.getByRole('radio', { name: 'Navy' }).check();
  }
  await tabs.getByRole('tab', { name: 'Inventory Sync', exact: true }).click();
  const modes = page.getByRole('group', { name: 'Inventory workflow' });
  await expect(modes.getByRole('button', { name: 'Inventory Update' })).toHaveAttribute('aria-pressed', 'true');
  await modes.getByRole('button', { name: 'Reorder PO Pack' }).click();
  await expect(page.getByRole('heading', { name: 'Plan reorder purchase orders' })).toBeVisible();
  await expect(status(page)).toContainText('Add an inventory CSV');
  await page.waitForLoadState('networkidle');
  begin();
}

async function photograph(page: Page, filename: string, anchor: Locator) {
  if (process.env.IMPORT_MEDIC_CAPTURE_M22_SCREENSHOTS !== '1') return;
  const dir = resolve('docs/reports/screenshots/m22');
  await mkdir(dir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await anchor.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 16));
  await page.screenshot({ path: resolve(dir, filename + '.png'), animations: 'disabled' });
}

async function downloadAudit(page: Page, info: TestInfo, stage: string) {
  const file = await save(page, info, auditLabel, 'po-audit.json', stage);
  return { dir: dirname(file.path), data: JSON.parse(file.text) };
}

async function expectHeld(page: Page) {
  await expect(status(page)).toHaveAttribute('data-held', 'true');
  await expect(review(page).getByRole('group', { name: 'Supplier purchase orders' })).toHaveCount(0);
  for (const label of [summaryLabel, htmlLabel]) await expect(button(page, label)).toHaveCount(0);
}

test('Reorder demo splits exact rounded orders, authenticates downloaded bytes and prints the branded pack offline', async ({ page, beginProcessing }, info) => {
  await openPlanner(page, beginProcessing, true);
  await button(page, 'Load Synthetic Multi-Supplier PO Demo').click();
  await expect(status(page)).toHaveAttribute('data-ready', 'true');
  const totals = review(page).locator('dl[aria-label="Purchase order totals"]');
  for (const [label, value] of [['SKUs Below Reorder', '2'], ['Total Units Ordered', '28'], ['Split Suppliers', '2'], ['Total PO Spend', '71.60']]) {
    await metric(totals, label, value);
  }
  const table = review(page).getByRole('table', { name: 'Supplier breakdown' });
  for (const [label, units, amount] of [['Northstar Supply', '18', '50.40'], ['Harbor Wholesale', '10', '21.20']]) {
    const row = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: label, exact: true }) });
    await expect(row.getByRole('cell').nth(1)).toContainText(units);
    await expect(row.getByRole('cell').nth(2)).toContainText(amount);
  }
  const access = await auditPage(page, 'workbench');
  await photograph(page, info.project.name + '-m22-po-planner', review(page).getByRole('heading', { name: 'Review purchase orders' }));
  const stage = 'm22-demo';
  const north = await save(page, info, 'Download PO CSV for Northstar Supply', 'po-northstar-supply.csv', stage);
  const harbor = await save(page, info, 'Download PO CSV for Harbor Wholesale', 'po-harbor-wholesale.csv', stage);
  const summary = await save(page, info, summaryLabel, 'po-consolidated-summary.csv', stage);
  const html = await save(page, info, htmlLabel, 'purchase-order-pack.html', stage);
  const { dir, data } = await downloadAudit(page, info, stage);
  const demo = purchaseOrderDemo();
  const input = async (file: File) => archive(resolve(dir, 'inputs'), file.name, Buffer.from(await file.arrayBuffer()));
  const inventory = await input(demo.inventory);
  const suppliers = await Promise.all(demo.suppliers.map(async file => ({ ...await input(file),
    label: file.name.slice(0, -4), requestedSheet: null, selectedSheet: null })));
  const outputs = await Promise.all([north, harbor, summary, html].map(async x => fingerprint(basename(x.path), await readFile(x.path))));
  expect(data.custody).toEqual({ inventory, suppliers, outputs });
  const headers = ['SKU', 'Supplier SKU', 'Current Qty', 'Reorder Point', 'Target Stock', 'Order Qty', 'MOQ', 'Case Pack',
    'Lead Time Days', 'Unit Cost', 'Line Total', 'Currency', 'Supplier', 'Location', 'PO Reference'];
  expect(parseCsv(north.text)).toEqual([headers, ['00042', '000420-N', '2', '4', '16', '18', '12', '6', '4', '2.80', '50.40', '', 'Northstar Supply', 'Warehouse East', 'DEMO-PO-001']]);
  expect(parseCsv(harbor.text)).toEqual([headers, ['00084', '000840-H', '5', '5', '13', '10', '10', '5', '5', '2.12', '21.20', '', 'Harbor Wholesale', 'Warehouse East', 'DEMO-PO-001']]);
  expect(parseCsv(summary.text)).toEqual([['SKU', 'Current Qty', 'Reorder Point', 'Order Qty', 'Chosen Supplier', 'Unit Cost', 'Line Total'],
    ['00042', '2', '4', '18', 'Northstar Supply', '2.80', '50.40'], ['00084', '5', '5', '10', 'Harbor Wholesale', '2.12', '21.20']]);
  expect(data.summary).toEqual({ belowReorder: 2, unitsOrdered: 28, supplierCount: 2, totalCents: 7160, totalSpend: '71.60' });
  expect(data.groups.map((group: { totalCents: number }) => group.totalCents)).toEqual([5040, 2120]);
  expect(html.text).not.toMatch(/<script\b|https?:\/\/|\b(?:srcset|href|src)\s*=|@import\b|url\s*\(/i);
  expect(html.text).toContain('&lt;buyer-note&gt;');
  await page.context().setOffline(true);
  const report = await page.context().newPage();
  await report.goto(pathToFileURL(html.path).href);
  expect(new URL(report.url()).protocol).toBe('file:');
  await expect(report.getByRole('heading', { name: 'Purchase Order Pack' })).toBeVisible();
  const brand = report.getByRole('complementary', { name: 'Agency branding' });
  await expect(brand.locator('div')).toHaveText(['Prepared by Northline Buying Office', 'Prepared for Harbor & Field', 'Return <buyer-note> & https://example.invalid/procurement']);
  await expect(brand).toHaveCSS('background-color', 'rgb(26, 54, 93)');
  await expect(report.locator('script,[src],[srcset],[href],base,form,object,embed,iframe,buyer-note')).toHaveCount(0);
  expect(await report.locator('*').evaluateAll(els => els.flatMap(el => el.getAttributeNames().filter(name => /^on/i.test(name))))).toEqual([]);
  await expect(report.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content',
    "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  const sections = report.locator('main section');
  await expect(sections.locator('h2')).toHaveText(['Northstar Supply', 'Harbor Wholesale']);
  await expect(sections.locator('p strong')).toHaveText(['50.40', '21.20']);
  await expect(report.locator('footer code')).toHaveText([inventory.sha256, ...suppliers.map(x => x.sha256), ...outputs.slice(0, 3).map(x => x.sha256)]);
  await assertFits(report);
  if (info.project.name === 'mobile') {
    for (const section of await sections.all()) {
      const boxes = await section.locator('thead th, tbody th, tbody td:nth-child(2)').evaluateAll(cells => cells.flatMap(cell => {
        const node = cell.firstChild!;
        return [...node.textContent!.matchAll(/\S+/g)].map(match => {
          const range = document.createRange();
          range.setStart(node, match.index!);
          range.setEnd(node, match.index! + match[0].length);
          return { word: match[0], fragments: range.getClientRects().length };
        });
      }));
      expect(boxes.filter(x => x.fragments !== 1), 'Each header word and SKU fits unbroken').toEqual([]);
      const scroller = section.getByRole('region');
      const size = await scroller.evaluate(el => ({ viewport: el.clientWidth, content: el.scrollWidth }));
      if (size.content > size.viewport) {
        await scroller.focus();
        await report.keyboard.press('ArrowRight');
        await expect.poll(() => scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
        await expect(scroller).toBeFocused();
      }
    }
    await assertFits(report);
  } else await photograph(report, 'desktop-m22-po-pack-html', brand);
  await report.emulateMedia({ media: 'print' });
  expect(await sections.evaluateAll(els => els.map(el => getComputedStyle(el).breakBefore))).toEqual(['auto', 'page']);
  await report.close();
  await page.context().setOffline(false);
  info.annotations.push({ type: 'm22-demo', description: JSON.stringify({ browser: page.context().browser()?.version(),
    viewport: page.viewportSize(), access, inputs: [inventory, ...suppliers], outputs, summary: data.summary }) });
});

test('PO uploads require an exact location and visible worksheet, hold tied or invalid supplier lines, and recover with current bytes', async ({ page, beginProcessing }, info) => {
  await openPlanner(page, beginProcessing);
  const stock = csv('scoped-inventory.csv', [['SKU', 'Location', 'Available'], ['00123', 'East', '1'], ['00123', 'West', '20']]);
  const workbook = resolve('fixtures/supplier-delta/synthetic-pricebook.xlsx');
  await field(page, 'Choose Inventory CSV').setInputFiles(stock);
  await field(page, 'Choose supplier catalog').setInputFiles(workbook);
  await field(page, 'Supplier 1 name').fill('Atlas Book');
  await field(page, 'Reorder Point').fill('1');
  await field(page, 'Target Stock').fill('6');
  const location = setting(page, 'Target Location');
  await expect(location.locator('option')).toHaveText(['Choose a location', 'East', 'West']);
  await expect(status(page)).toContainText('Choose a Target Location');
  await expectHeld(page);
  await location.selectOption('East');
  const sheet = setting(page, 'Supplier 1 worksheet');
  await expect(sheet.locator('option')).toHaveText(['Choose a visible worksheet', 'Instructions', 'Q4_Prices', 'Q3_Prices']);
  await expect(sheet).toHaveValue('');
  await expect(status(page)).toContainText('Choose a visible worksheet');
  await sheet.selectOption('Q3_Prices');
  await expect(status(page)).toHaveAttribute('data-ready', 'true');
  const first = await downloadAudit(page, info, 'm22-q3');
  const stockProof = await archive(resolve(first.dir, 'inputs'), stock.name, stock.buffer);
  const bookProof = await archive(resolve(first.dir, 'inputs'), basename(workbook), await readFile(workbook));
  expect(first.data.custody.inventory).toEqual(stockProof);
  expect(first.data.custody.suppliers).toEqual([{ ...bookProof, requestedSheet: 'Q3_Prices', selectedSheet: 'Q3_Prices', label: 'Atlas Book' }]);
  expect(first.data.groups[0]).toMatchObject({ totalCents: 12500, lines: [{ sku: '00123', supplierLine: 2, inventoryLine: 2, orderQty: 5 }] });
  await sheet.selectOption('Q4_Prices');
  await metric(review(page), 'Total PO Spend', '142.50');
  await button(page, '+ Add another supplier catalog').click();
  const offers = (casePack: string) => csv('second-quotes.csv', [['SKU', 'Unit Cost', 'Case Pack', 'Notes'],
    ['unrelated', '1.00', '1', 'first line\r\nsecond line'], ['00123', '28.50', casePack, 'second quote']]);
  const tie = offers('1');
  const source2 = field(page, 'Choose supplier catalog 2');
  await source2.setInputFiles(tie);
  await expectHeld(page);
  const issues = page.getByRole('list', { name: 'Purchase order diagnostics', exact: true });
  const tied = issues.locator('[data-po-issue="supplier-cost-tie"]');
  await expect(tied.getByRole('list', { name: 'Tied supplier offers' }).getByRole('listitem')).toHaveText(['Supplier 1 (Atlas Book) · line 2', 'Supplier 2 (second-quotes) · line 4']);
  const held = await downloadAudit(page, info, 'm22-tie');
  const tieProof = await archive(resolve(held.dir, 'inputs'), tie.name, tie.buffer);
  expect(held.data.custody).toEqual({ inventory: stockProof, suppliers: [
    { ...bookProof, requestedSheet: 'Q4_Prices', selectedSheet: 'Q4_Prices', label: 'Atlas Book' },
    { ...tieProof, requestedSheet: null, selectedSheet: null, label: 'second-quotes' },
  ] });
  expect(held.data.groups).toEqual([]);
  expect(held.data.issues).toMatchObject([{ code: 'supplier-cost-tie', line: 2, sku: '00123', offers: [{ supplierIndex: 0, line: 2 }, { supplierIndex: 1, line: 4 }] }]);
  await setting(page, 'Supplier Policy').selectOption('prefer-first');
  await expect(status(page)).toHaveAttribute('data-ready', 'true');
  const released = await save(page, info, 'Download PO CSV for Atlas Book', 'po-atlas-book.csv', 'm22-resolved');
  expect(parseCsv(released.text)[1].slice(9, 11)).toEqual(['28.50', '142.50']);
  const invalid = offers('0');
  await source2.setInputFiles(invalid);
  await expectHeld(page);
  await expect(issues.locator('[data-po-issue="invalid-case-pack"]')).toContainText('second-quotes) · line 4');
  const broken = await downloadAudit(page, info, 'm22-invalid');
  expect(broken.data.custody).not.toHaveProperty('outputs');
  expect(broken.data.custody.suppliers[1]).toMatchObject(await archive(resolve(broken.dir, 'inputs'), invalid.name, invalid.buffer));
  expect(broken.data.issues).toMatchObject([{ code: 'invalid-case-pack', line: 4, sku: '00123', value: '0' }]);
  await source2.setInputFiles(tie);
  await location.selectOption('West');
  await expect(status(page)).toHaveAttribute('data-ready', 'true');
  await metric(review(page), 'Total Units Ordered', '0');
  await expect(review(page).getByRole('group', { name: 'Supplier purchase orders' })).toHaveCount(0);
  const west = await save(page, info, summaryLabel, 'po-consolidated-summary.csv', 'm22-west');
  expect(parseCsv(west.text)).toHaveLength(1);
  const westAudit = await downloadAudit(page, info, 'm22-west');
  expect(westAudit.data).toMatchObject({ targetLocation: 'West', groups: [], summary: { totalCents: 0 } });
  expect(westAudit.data.custody.outputs).toContainEqual(fingerprint(basename(west.path), await readFile(west.path)));
  await assertFits(page);
  info.annotations.push({ type: 'm22-uploads', description: JSON.stringify({ viewport: page.viewportSize(), tie: held.data.issues,
    invalidPack: broken.data.issues, selectedWorksheet: held.data.custody.suppliers[0], west: westAudit.data.summary }) });
});
