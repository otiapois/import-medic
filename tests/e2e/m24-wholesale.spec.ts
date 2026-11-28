import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertFits, test } from './browser';
import { auditPage } from './m10-accessibility';
import { button, parseCsv, save } from './m7-files';

const fixture = (name: string) => resolve('fixtures/m24', name);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const panel = (page: Page) => page.getByTestId('wholesale-panel');
const status = (page: Page) => page.getByTestId('wholesale-status');
const files = {
  buyer: ['Download Buyer Matrix CSV', 'northstar-supply-wholesale-buyer-sheet.csv'],
  shopify: ['Download Shopify B2B CSV', 'northstar-supply-shopify-b2b-catalog.csv'],
  lineSheet: ['Download Printable Buyer Line-Sheet (.html)', 'northstar-supply-wholesale-line-sheet.html'],
  internal: ['Download Internal Margin Matrix CSV', 'northstar-supply-wholesale-margin-matrix.csv'],
  audit: ['Download Internal Margin Audit JSON', 'wholesale-margin-audit.json'],
} as const;
const buyerFiles = ['buyer', 'shopify', 'lineSheet'] as const;
const buyerMatrix = [
  ['SKU', 'Product', 'Case Pack', 'Bronze MOQ', 'Bronze Unit Price', 'Silver MOQ', 'Silver Unit Price', 'Gold MOQ', 'Gold Unit Price'],
  ['00007', 'Travel Mug\n12 oz', '6', '12', '39.96', '54', '34.97', '102', '29.97'],
  ['00008', 'Travel Mug\n12 oz', '5', '10', '31.96', '50', '27.97', '100', '23.97'],
  ['00009', 'Canvas Tote', '4', '12', '23.96', '52', '20.97', '100', '17.97'],
];
const nativeMatrix = [
  ['Catalog Title', 'SKU', 'Option1 Name', 'Option1 Value', 'Fixed Price', 'Quantity Increment', 'Minimum Order Quantity'],
  ['Northstar Wholesale Silver', '00007', '', '', '34.97', '6', '54'],
  ['Northstar Wholesale Silver', '00008', '', '', '27.97', '5', '50'],
  ['Northstar Wholesale Silver', '00009', '', '', '20.97', '4', '52'],
];

async function openWholesale(page: Page, begin: () => void) {
  await page.goto('/shopify-price-update-diff', { waitUntil: 'networkidle' });
  const tabs = page.getByRole('tablist', { name: /studio/i });
  await expect(tabs.getByRole('tab')).toHaveCount(6);
  await tabs.getByRole('tab', { name: 'Sale Campaign Pack', exact: true }).click();
  await expect(button(page, 'Retail Promo Pack')).toHaveAttribute('aria-pressed', 'true');
  await button(page, 'Wholesale B2B Line-Sheet').focus();
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('heading', { name: 'Wholesale B2B Line-Sheet' })).toBeVisible();
  await expect(panel(page).locator('.wholesale-heading')).toHaveCSS('display', 'flex');
  await page.waitForLoadState('networkidle');
  begin();
}

async function photograph(page: Page, name: string, anchor: Locator) {
  if (process.env.IMPORT_MEDIC_CAPTURE_M24_SCREENSHOTS !== '1') return;
  const dir = resolve('docs/reports/screenshots/m24');
  await mkdir(dir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await anchor.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 16));
  await page.screenshot({ path: resolve(dir, name + '.png'), animations: 'disabled' });
}

function download(page: Page, info: TestInfo, key: keyof typeof files, stage: string) {
  const [label, name] = files[key];
  return save(page, info, label, name, stage);
}

// Compare ranges with their own cells even when the whole table is scrolled out of view.
async function inspectTable(page: Page, region: Locator) {
  const geometry = await region.evaluate(el => {
    const broken: string[] = [];
    for (const cell of el.querySelectorAll('th, td')) {
      const bounds = cell.getBoundingClientRect();
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        for (const word of node.textContent!.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, word.index!);
          range.setEnd(node, word.index! + word[0].length);
          const rects = Array.from(range.getClientRects());
          if (rects.length !== 1 || rects[0].left < bounds.left - 1 || rects[0].right > bounds.right + 1) broken.push(word[0]);
        }
      }
    }
    return { width: el.clientWidth, content: el.scrollWidth, broken };
  });
  expect(geometry.broken, 'Entire words and prices fit each cell').toEqual([]);
  if (geometry.content > geometry.width + 1) {
    await region.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => region.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    await expect(region).toBeFocused();
    await page.keyboard.press('Home');
    await region.evaluate(el => { el.scrollLeft = 0; });
  }
  await assertFits(page);
  return geometry;
}

function buyerOnly(text: string, merchantValues: string[], htmlSource = false) {
  expect(text).not.toMatch(/\b(?:costs?|gross\s+margin|profit)\b/i);
  if (!htmlSource) expect(text).not.toMatch(/\bmargin\b/i);
  for (const value of new Set(merchantValues)) expect(text).not.toContain(value);
}

test('Wholesale demo publishes exact buyer and native tiers, authenticates bytes and prints the branded buyer file offline', async ({ page, beginProcessing }, info) => {
  await openWholesale(page, beginProcessing);
  const editor = panel(page);
  await editor.locator('.signoff-branding > summary').click();
  await editor.getByLabel('Agency name', { exact: true }).fill('Northline Buying Office');
  await editor.getByLabel('Prepared for', { exact: true }).fill('Harbor & Field');
  await editor.getByLabel('Contact email or note', { exact: true }).fill('Quote <buyer-note> & reference 7');
  await editor.getByRole('radio', { name: 'Navy' }).check();
  await editor.locator('.signoff-branding > summary').click();
  await button(page, 'Load Synthetic 3-Tier Wholesale Demo').click();
  await expect(status(page)).toHaveAttribute('data-state', 'ready');
  const internalTable = page.getByTestId('wholesale-internal-table');
  const firstRow = internalTable.locator('[data-wholesale-sku="00007"]');
  await expect(firstRow).toContainText('17.31');
  await expect(firstRow).toContainText('Profit 22.65');
  const internalGeo = await inspectTable(page, internalTable);
  const access = await auditPage(page, 'workbench');
  await photograph(page, info.project.name + '-m24-wholesale-builder', page.getByTestId('wholesale-internal-review'));
  const stage = 'm24-demo';
  const merchant = await download(page, info, 'internal', stage);
  const audit = JSON.parse((await download(page, info, 'audit', stage)).text);
  const merchantRows = parseCsv(merchant.text);
  expect(merchantRows[0]).toEqual(['SKU', 'Product', 'Catalog Line', 'Cost Sheet Line', 'Retail Price', 'Landed Cost', 'MAP', 'Case Pack', 'SKU MOQ', 'Tier', 'Eligible MOQ', 'Unit Price', 'Gross Margin %', 'Profit']);
  expect(merchantRows).toHaveLength(10);
  const merchantValues: string[] = [];
  for (const [i, row] of merchantRows.slice(1).entries()) {
    const source = audit.rows[Math.floor(i / 3)];
    const tier = source.tiers[i % 3];
    const skuIndex = Math.floor(i / 3);
    const price = Number(buyerMatrix[skuIndex + 1][4 + 2 * (i % 3)]);
    const cost = [17.31, 12.37, 8.41][skuIndex];
    const profit = (price - cost).toFixed(2);
    const margin = ((price - cost) / price * 100).toFixed(6);
    expect(source.landedCost).toBe(cost.toFixed(2));
    expect([row[5], row[13], tier.profit]).toEqual([cost.toFixed(2), profit, profit]);
    expect(Number(row[12])).toBe(Number(margin));
    expect(tier.marginPercent).toBe(row[12]);
    const visible = internalTable.locator('[data-wholesale-sku="' + row[0] + '"]');
    await expect(visible).toContainText('Margin ' + row[12] + '%');
    await expect(visible).toContainText('Profit ' + profit);
    merchantValues.push(cost.toFixed(2), profit, row[12]);
  }
  await button(page, 'Buyer-safe preview').focus();
  await page.keyboard.press('Space');
  const preview = page.getByTestId('wholesale-buyer-preview');
  await expect(preview.getByText('USD', { exact: true })).toBeVisible();
  await expect(preview.locator('time')).toHaveText('2026-10-01');
  await expect(preview.getByText('Prepared for Harbor & Field')).toBeVisible();
  await expect(editor.getByRole('button', { name: files.audit[0] })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: files.internal[0] })).toHaveCount(0);
  const buyerTable = page.getByTestId('wholesale-buyer-table');
  await expect(buyerTable.locator('tbody tr')).toHaveCount(3);
  buyerOnly(await preview.innerText(), merchantValues);
  const previewGeo = await inspectTable(page, buyerTable);
  const buyer = await download(page, info, 'buyer', stage);
  const native = await download(page, info, 'shopify', stage);
  const html = await download(page, info, 'lineSheet', stage);
  expect(parseCsv(buyer.text)).toEqual(buyerMatrix);
  expect(parseCsv(native.text)).toEqual(nativeMatrix);
  for (const file of [buyer, native]) buyerOnly(file.text, merchantValues);
  buyerOnly(html.text, merchantValues, true);
  const custody = {
    baselineSha256: hash(await readFile(fixture('wholesale-shopify.csv'))),
    costSheetSha256: hash(await readFile(fixture('wholesale-costs.csv'))),
    buyerSha256: hash(await readFile(buyer.path)), shopifySha256: hash(await readFile(native.path)),
    lineSheetSha256: hash(await readFile(html.path)), internalSha256: hash(await readFile(merchant.path)),
  };
  expect(audit.custody).toEqual(custody);
  expect(html.text).not.toMatch(/<script\b|https?:\/\/|\b(?:srcset|href|src)\s*=|@import\b|url\s*\(/i);
  await page.context().setOffline(true);
  const offline = await page.context().newPage();
  const requests: string[] = [];
  offline.on('request', request => requests.push(request.url()));
  const url = pathToFileURL(html.path).href;
  await offline.goto(url);
  expect(new URL(offline.url()).protocol).toBe('file:');
  await expect(offline.getByRole('heading', { name: 'Wholesale Buyer Line Sheet' })).toBeVisible();
  const branded = offline.getByRole('complementary', { name: 'Agency branding' });
  await expect(branded).toContainText('Quote <buyer-note> & reference 7');
  await expect(branded).toHaveCSS('background-color', 'rgb(26, 54, 93)');
  await expect(offline.locator('header time')).toHaveText('2026-10-01');
  await expect(offline.locator('header')).toContainText('USD');
  await expect(offline.locator('script,[src],[srcset],[href],base,form,iframe,object,embed,buyer-note')).toHaveCount(0);
  expect(await offline.locator('*').evaluateAll(els => els.flatMap(el => el.getAttributeNames().filter(name => /^on/i.test(name))))).toEqual([]);
  await expect(offline.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content',
    "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  const offlineRegion = offline.getByRole('region', { name: 'Wholesale prices' });
  const offlineRows = await offlineRegion.locator('tr').evaluateAll(rows => rows.map(row => Array.from(row.querySelectorAll('th, td'), cell => cell.textContent)));
  expect(offlineRows).toEqual(buyerMatrix);
  buyerOnly(await offline.locator('body').innerText(), merchantValues);
  const offlineGeo = await inspectTable(offline, offlineRegion);
  if (info.project.name === 'desktop') await photograph(offline, 'desktop-m24-buyer-linesheet', branded);
  await offline.emulateMedia({ media: 'print' });
  await expect(offlineRegion).toHaveCSS('overflow', 'visible');
  await expect(offlineRegion.locator('thead')).toHaveCSS('display', 'table-header-group');
  await expect(offlineRegion.locator('tbody tr').first()).toHaveCSS('break-inside', 'avoid');
  const printGeometry = await offlineRegion.evaluate(el => {
    const outer = el.getBoundingClientRect(), table = el.querySelector('table')!.getBoundingClientRect();
    return { panel: outer.width, table: table.width, left: table.left - outer.left, right: outer.right - table.right };
  });
  expect(Math.min(printGeometry.left, printGeometry.right)).toBeGreaterThanOrEqual(-1);
  const printed = await offline.pdf({ format: 'A4', printBackground: true });
  expect(printed.subarray(0, 5).toString()).toBe('%PDF-');
  expect(requests).toEqual([url]);
  await offline.close();
  await page.context().setOffline(false);
  info.annotations.push({ type: 'm24-demo', description: JSON.stringify({ browser: page.context().browser()?.version(), viewport: page.viewportSize(),
    custody, access, merchantValues, internalGeo, previewGeo, offlineGeo, printGeometry, printedBytes: printed.length,
    offlineNavigation: requests.length, offlineSubresources: 0 }) });
});

test('Wholesale uploads retain the exact cost worksheet and hold all buyer files for a one-cent MAP breach', async ({ page, beginProcessing }, info) => {
  await openWholesale(page, beginProcessing);
  await button(page, 'Load Synthetic 3-Tier Wholesale Demo').click();
  await expect(status(page)).toHaveAttribute('data-state', 'ready');
  const catalog = fixture('wholesale-shopify.csv');
  const workbook = fixture('wholesale-costs.xlsx');
  const source = panel(page).getByLabel('Choose landed cost and MAP file', { exact: true });
  await panel(page).getByLabel('Choose store catalog CSV', { exact: true }).setInputFiles(catalog);
  await source.setInputFiles(workbook);
  await expect(panel(page).getByLabel('Cost and MAP worksheet')).toHaveValue('Wholesale Costs');
  await expect(status(page)).toHaveAttribute('data-state', 'ready');
  const xlsx = JSON.parse((await download(page, info, 'audit', 'm24-xlsx')).text);
  expect(xlsx.selectedWorksheet).toBe('Wholesale Costs');
  expect(xlsx.custody.costSheetSha256).toBe(hash(await readFile(workbook)));
  expect(xlsx.rows[0]).toMatchObject({ sku: '00007', landedCost: '17.31', line: 2, costLine: 2 });
  const costCsv = await readFile(fixture('wholesale-costs.csv'), 'utf8');
  const upload = (map: string) => ({ name: 'quarterly-floor.csv', mimeType: 'text/csv',
    buffer: Buffer.from(costCsv.replace('00007,17.31,29.95', '00007,17.31,' + map)) });
  await source.setInputFiles(upload('29.97'));
  await expect(status(page)).toHaveAttribute('data-state', 'ready');
  const exact = JSON.parse((await download(page, info, 'audit', 'm24-exact-map')).text);
  expect(exact.custody.costSheetSha256).toBe(hash(upload('29.97').buffer));
  expect(exact.issues).toEqual([]);
  const higher = upload('29.98');
  await source.setInputFiles(higher);
  for (const key of buyerFiles) await expect(button(page, files[key][0])).toBeDisabled();
  await expect(status(page)).toHaveAttribute('data-state', 'hold');
  const issue = page.getByTestId('wholesale-issues').locator('[data-issue-code="below-map"]');
  await expect(issue.locator('strong')).toHaveText('Cost sheet line 2 · SKU 00007 · Tier Gold');
  await expect(issue).toContainText('Catalog line 2');
  const held = JSON.parse((await download(page, info, 'audit', 'm24-map-hold')).text);
  expect(held.canExport).toBe(false);
  expect(held.issues).toMatchObject([{ code: 'below-map', source: 'cost-sheet', sku: '00007', tierName: 'Gold', line: 2, costLine: 2, baselineLine: 2 }]);
  expect(held.custody).toEqual({ baselineSha256: hash(await readFile(catalog)), costSheetSha256: hash(higher.buffer),
    buyerSha256: null, shopifySha256: null, lineSheetSha256: null, internalSha256: null });
  await button(page, 'Buyer-safe preview').click();
  await expect(page.getByTestId('wholesale-buyer-preview')).toHaveCount(0);
  await expect(page.getByTestId('wholesale-issues')).toHaveCount(0);
  await expect(panel(page)).not.toContainText('17.31');
  for (const key of buyerFiles) await expect(button(page, files[key][0])).toBeDisabled();
  await assertFits(page);
  info.annotations.push({ type: 'm24-hold', description: JSON.stringify({ viewport: page.viewportSize(), worksheetHash: xlsx.custody.costSheetSha256,
    equalMap: exact.rows[0].map, heldMap: held.rows[0].map, issues: held.issues, custody: held.custody }) });
});
