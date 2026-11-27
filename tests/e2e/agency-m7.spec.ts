import { expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { test } from './browser';
import { button, capture, csv, field, openSignoff, openStudio, pair, parseCsv, save, skuRow } from './m7-files';

const brackets = [
  { upTo: '20.00', mode: 'multiplier', multiplier: '2.5' },
  { upTo: '100.00', mode: 'multiplier', multiplier: '2.0' },
  { upTo: null, mode: 'multiplier', multiplier: '1.6' },
];
const rule = { mode: 'tiered-brackets', brackets, rounding: 'ending-99' };
const tiers = [
  { sku: '00123', input: '20.00', price: '50.99', label: 'Tier 1 (<= 20.00): 2.5x' },
  { sku: '00045-XL', input: '20.01', price: '40.99', label: 'Tier 2 (<= 100.00): 2.0x' },
  { sku: '00300', input: '100.01', price: '160.99', label: 'Tier 3 (catch-all): 1.6x' },
];
const shop = csv('shop.csv', [
  ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Variant Inventory Qty'],
  ['canvas', 'Canvas', 'Size', 'S', '00123', '040.000', '0019'],
  ['canvas', '', '', 'XL', '00045-XL', '023.000', '0007'],
  ['case', 'Case', 'Title', 'Default Title', '00300', '150.00', '0008'],
]);
const supplier = csv('tiers.csv', [['SKU', 'Price'], ...tiers.map(row => [row.sku, row.input])]);
const confirm = (page: Page) => button(page, 'Confirm columns');
const formula = (page: Page) => page.getByText('Pricing formula & rounding', { exact: true });
const loadProfile = (page: Page) => field(page, 'Load Workspace Profile (.json)');
const jsonAudit = 'Download Full Diff Audit (.json)';
const csvAudit = 'Download Full Diff Audit (.csv)';

async function configureTiers(page: Page) {
  await formula(page).click();
  await field(page, 'Pricing mode').selectOption('tiered-brackets');
  await field(page, 'Tier 3 multiplier').fill('1.6');
  await field(page, 'Rounding').selectOption('ending-99');
  await confirm(page).click();
  await pair(page, 'Shopify', true);
}

test('Cost brackets carry exact cutoff decisions into actual audits, offline sign-off and a reloadable v5 recipe', async ({ page, beginProcessing }, info) => {
  await openStudio(page, beginProcessing);
  await field(page, 'Choose Shopify baseline CSV').setInputFiles(shop);
  await field(page, 'Choose supplier price sheet').setInputFiles(supplier);
  await configureTiers(page);
  const preview = page.getByRole('status').filter({ hasText: 'Supplier row 2' });
  await expect(preview).toContainText('50.99');
  await expect(preview).toContainText(tiers[0].label);
  const group = page.getByRole('group', { name: 'Cost brackets', exact: true });
  await expect(group.getByRole('status')).toHaveCount(3);
  for (const row of tiers) {
    await expect(skuRow(page, row.sku)).toContainText(row.label);
    await expect(skuRow(page, row.sku).getByText(row.price, { exact: true }).first()).toBeVisible();
  }
  if (info.project.name === 'desktop') await capture(page, info, formula(page), 'desktop-m7-tiered-brackets');
  else await capture(page, info, group, 'mobile-m7-tiered');
  const audit = JSON.parse((await save(page, info, jsonAudit, 'shop-price-diff.audit.json', 'tiers')).text);
  expect(audit.pricingRule).toEqual(rule);
  const [headers, summary, ...rows] = parseCsv((await save(page, info, csvAudit, 'shop-price-diff.audit.csv', 'tiers')).text);
  expect(headers.at(-1)).toBe('Review and Resolution (JSON)');
  expect(JSON.parse(summary.at(-1)!)).toMatchObject({ pricingRule: rule });
  const offline = await openSignoff(page, info, 'shop', 'tiers');
  for (const { sku, input, price, label } of tiers) {
    const row = rows.find(fields => fields[headers.indexOf('SKU')] === sku)!;
    expect(Object.fromEntries(headers.map((key, i) => [key, row[i]]))).toMatchObject({
      'Matched Tier': label, 'Computed Price': price, 'New Price': price, 'Raw Supplier Price': input,
    });
    expect(JSON.parse(row.at(-1)!)).toHaveProperty('issues');
    expect(audit.rows.find((item: { sku: string }) => item.sku === sku)).toMatchObject({
      matchedTier: label, computedPrice: price, newPrice: price, supplierPrice: input,
    });
    const signed = offline.getByRole('row').filter({ has: offline.getByRole('cell', { name: sku, exact: true }) });
    await expect(signed.getByRole('cell', { name: label, exact: true })).toBeVisible();
    await expect(signed.getByRole('cell', { name: price, exact: true })).toBeVisible();
  }
  await offline.close();
  await field(page, 'Supplier label').fill('Tier Vendor');
  const recipe = await save(page, info, 'Save Supplier Recipe (.json)', 'tier-vendor-supplier-recipe.json', 'tiers');
  expect(JSON.parse(recipe.text)).toMatchObject({ version: 5, pricingRule: rule, supplierLabel: 'Tier Vendor' });
  await field(page, 'Tier 2 upper cost (inclusive)').fill('19.99');
  await expect(page.getByRole('alert').filter({ hasText: 'strictly increasing' })).toBeVisible();
  await expect(confirm(page)).toBeDisabled();
  await pair(page, 'Shopify', false);
  await field(page, 'Load Supplier Recipe (.json)').setInputFiles(recipe.path);
  await expect(page.getByRole('status').filter({ hasText: 'Recipe needs review: Tier Vendor' })).toBeVisible();
  await pair(page, 'Shopify', false);
  await confirm(page).click();
  await pair(page, 'Shopify', true);
  await expect(skuRow(page, tiers[1].sku)).toContainText(tiers[1].label);
  if (!await field(page, 'Pricing mode').isVisible()) await formula(page).click();
  await field(page, 'Convert supplier currency (manual rate)').check();
  await field(page, 'Source currency code').fill('EUR');
  await field(page, 'Store currency code').fill('USD');
  await field(page, 'Exact rate').fill('0.5000');
  await page.getByRole('checkbox', { name: /verified.*FX rate/ }).check();
  await confirm(page).click();
  await pair(page, 'Shopify', true);
  const [fxHeaders, , ...fxRows] = parseCsv((await save(page, info, csvAudit, 'shop-price-diff.audit.csv', 'tier-fx')).text);
  expect(fxHeaders.slice(-3)).toEqual(['Matched Tier', 'FX Applied', 'Review and Resolution (JSON)']);
  const offshore = fxRows.find(row => row[fxHeaders.indexOf('SKU')] === '00045-XL')!;
  expect(offshore[fxHeaders.indexOf('New Price')]).toBe('25.99');
  expect(offshore.slice(-3, -1)).toEqual([tiers[0].label, 'EUR -> USD @ 0.5000']);
  expect(JSON.parse(offshore.at(-1)!)).toHaveProperty('issues');
});

const wooHeaders = ['ID', 'Type', 'SKU', 'Name', 'Parent', 'Regular price', 'Sale price', 'Stock',
  'Description', 'Short description', 'Categories', 'Tags', 'Images', 'Meta:origin'];
const wooRows = [
  ['500', 'variable', '00009', 'Canvas set', '', '', '', '', 'Parent copy', 'short', 'sets', 'winter', 'https://example.invalid/500.jpg', 'eu'],
  ['501', 'variation, virtual', '00123', 'Canvas small', '00009', '045.000', '20.00', '0019', '<p>Canvas,\nlined</p>', 'small', '', '', '', 'a'],
  ['502', 'variation', '00045-XL', 'Canvas XL', 'id:500', '025.000', '12.00', '0007', '  Original  ', '', '', '', '', 'b'],
  ['503', 'simple', 'AGENCY-NEW', 'Pouch', '', '010.00', '', '0002', 'Pouch copy', '', 'travel', '', '', 'c'],
  ['504', 'simple', '00077', 'Travel case', '', '023.000', '10.000', '0007', 'Keep original', '', 'travel', '', '', 'd'],
  ['505', 'simple', 'LEAVE', 'Untouched item', '', '020.9900', '', '', 'Keep this line', '', '', '', '', ''],
];
const wooMatrix = [wooHeaders, ...wooRows];
const wooInput = csv('woo.csv', wooMatrix);
const wooSupplier = csv('west.csv', [['SKU', 'Price', 'Stock', 'Sale'], ['00077', '26.00', '9', '17.99']]);
const wooIdentity = ['ID', 'Type', 'SKU', 'Parent', 'Regular price'];
const wooUpdate = 'Download Safe WooCommerce Update CSV';
const wooRollback = 'Download WooCommerce Rollback CSV';

function applyWoo(matrix: string[][], [columns, ...records]: string[][]) {
  const restored = matrix.map(row => [...row]);
  const targets = new Set<string>();
  for (const record of records) {
    expect(record).toHaveLength(columns.length);
    const id = record[columns.indexOf('ID')];
    expect(targets.has(id)).toBe(false);
    targets.add(id);
    const row = restored.slice(1).filter(cells => cells[matrix[0].indexOf('ID')] === id);
    expect(row).toHaveLength(1);
    for (const [i, column] of columns.entries()) {
      const position = matrix[0].indexOf(column);
      expect(position, column).toBeGreaterThanOrEqual(0);
      row[0][position] = record[i];
    }
  }
  return restored;
}

test('WooCommerce CSV and sparse XLSX suppliers produce scoped native files and restore every original catalog cell', async ({ page, beginProcessing }, info) => {
  await openStudio(page, beginProcessing);
  await button(page, 'WooCommerce').click();
  await field(page, 'Choose WooCommerce baseline CSV').setInputFiles(wooInput);
  await field(page, 'Choose supplier price sheet').setInputFiles(wooSupplier);
  await button(page, '+ Add another supplier sheet').click();
  await field(page, 'Choose supplier price sheet 2').setInputFiles(resolve('fixtures/shopify-price-diff/supplier-agency.xlsx'));
  await pair(page, 'WooCommerce', true);
  const first = page.getByRole('group', { name: 'Settings for west.csv', exact: true });
  const sale = first.getByLabel('Sale price column (optional)', { exact: true });
  const stock = first.getByLabel('Stock column (optional)', { exact: true });
  for (const input of [sale, stock]) await expect(input.locator('option:checked')).toHaveText('Leave unchanged');
  const expected = wooMatrix.map(row => [...row]);
  for (const [i, price] of ['40.00', '24.00', '12.00', '26.00'].entries()) expected[i + 2][wooHeaders.indexOf('Regular price')] = price;
  for (const optional of [false, true]) {
    const stage = optional ? 'woo-sale-stock' : 'woo-price-only';
    if (optional) {
      await sale.selectOption('3');
      await stock.selectOption('2');
      await first.getByRole('button', { name: 'Confirm columns', exact: true }).click();
      await pair(page, 'WooCommerce', true);
      expected[5][wooHeaders.indexOf('Sale price')] = '17.99';
      expected[5][wooHeaders.indexOf('Stock')] = '9';
    }
    const update = parseCsv((await save(page, info, wooUpdate, 'woo-price-update.csv', stage)).text);
    const rollback = parseCsv((await save(page, info, wooRollback, 'woo-price-rollback.csv', stage)).text);
    const columns = optional ? [...wooIdentity, 'Sale price', 'Stock'] : wooIdentity;
    const project = (matrix: string[][]) => [columns, ...matrix.slice(2, 6).map(row => columns.map(key => row[wooHeaders.indexOf(key)]))];
    expect(update).toEqual(project(expected));
    expect(rollback).toEqual(project(wooMatrix));
    const applied = applyWoo(wooMatrix, update);
    expect(applied).toEqual(expected);
    expect(csv('restored.csv', applyWoo(applied, rollback)).buffer).toEqual(wooInput.buffer);
    const audit = JSON.parse((await save(page, info, jsonAudit, 'woo-price-diff.audit.json', stage)).text);
    expect(audit.rollbackVerification).toMatchObject({ checked: true, restoredVariants: 4 });
    const [head, , ...records] = parseCsv((await save(page, info, csvAudit, 'woo-price-diff.audit.csv', stage)).text);
    expect(head.at(-1)).toBe('Review and Resolution (JSON)');
    for (const [i, physical] of [2, 5, 8, 2].entries()) {
      const original = wooRows[i + 1];
      const [id, type, sku, , parent] = original;
      const row = audit.rows.find((item: { sku: string }) => item.sku === sku);
      expect(row).toMatchObject({ woocommerce: { id, type, parent }, oldPrice: original[5], newPrice: expected[i + 2][5],
        supplierFilename: i === 3 ? 'west.csv' : 'supplier-agency.xlsx', supplierRow: physical });
      expect(row.baselineCells.map((cell: { value: string }) => cell.value)).toEqual(original);
      const entry = records.find(cells => cells[head.indexOf('SKU')] === sku)!;
      expect(Object.fromEntries(head.map((key, j) => [key, entry[j]]))).toMatchObject({
        ID: id, Type: type, Parent: parent, 'Old Regular Price': original[5], 'New Regular Price': expected[i + 2][5],
      });
    }
  }
  const table = page.getByRole('table', { name: 'WooCommerce price diff' });
  await expect(table.getByRole('columnheader', { name: 'Stock after', exact: true })).toBeVisible();
  await expect(skuRow(page, '00123')).toContainText('Parent 00009');
  await expect(skuRow(page, '00045-XL')).toContainText('Parent id:500');
  if (info.project.name === 'desktop') {
    const layout = await skuRow(page, '00123').evaluate(row => {
      const frame = row.closest('.table-scroll')!.getBoundingClientRect();
      const cells = [...row.children];
      const prices = cells.slice(1, 4).map(cell => {
        const text = cell.querySelector('code')!;
        const range = document.createRange();
        range.selectNodeContents(text);
        const rects = [...range.getClientRects()];
        const bounds = cell.getBoundingClientRect();
        return { value: text.textContent, lines: rects.length, contained: rects.every(r => r.left >= bounds.left - 1 && r.right <= bounds.right + 1) };
      });
      const controls = cells.at(-1)!;
      const reviewComplete = [controls, ...controls.querySelectorAll('label, input, button')].every(el => {
        const rect = el.getBoundingClientRect();
        return rect.left >= frame.left - 1 && rect.right <= frame.right + 1;
      });
      return { prices, reviewComplete };
    });
    info.annotations.push({ type: 'm7-woo-layout', description: JSON.stringify(layout) });
    expect(layout).toEqual({ prices: ['045.000', '40.00', '-11.11%'].map(value => ({ value, lines: 1, contained: true })), reviewComplete: true });
    await capture(page, info, table, 'desktop-m7-woocommerce-diff');
  }
  const offline = await openSignoff(page, info, 'woo', 'woo-sale-stock');
  await expect(offline.getByRole('heading', { name: 'WooCommerce Price Update — Client Sign-Off Summary' })).toBeVisible();
  const sold = offline.getByRole('row').filter({ has: offline.getByRole('cell', { name: '00077', exact: true }) });
  for (const value of ['10.000 → 17.99', '0007 → 9', '26.00']) await expect(sold.getByRole('cell', { name: value, exact: true })).toBeVisible();
  const variant = offline.getByRole('row').filter({ has: offline.getByRole('cell', { name: '00123', exact: true }) });
  await expect(variant).toContainText('variation, virtual / 00009');
  await expect(variant).toContainText('supplier-agency.xlsx');
  await offline.close();
});

test('WooCommerce holds a retained sale that would disappear and blocks a mapped unmanaged stock rollback', async ({ page, beginProcessing }, info) => {
  await openStudio(page, beginProcessing);
  await button(page, 'WooCommerce').click();
  const guarded = wooMatrix.map(row => [...row]);
  guarded[2][wooHeaders.indexOf('Regular price')] = '037.000';
  guarded[2][wooHeaders.indexOf('Stock')] = '';
  await field(page, 'Choose WooCommerce baseline CSV').setInputFiles(csv('guarded.csv', guarded));
  await field(page, 'Choose supplier price sheet').setInputFiles(csv('guarded-supplier.csv', [
    ['SKU', 'Price', 'Stock', 'Sale'], ['00123', '20.00', '5', '15.00'],
  ]));
  const row = skuRow(page, '00123');
  await expect(row).toHaveAttribute('data-status', 'Blocked');
  await pair(page, 'WooCommerce', false);
  const retained = JSON.parse((await save(page, info, jsonAudit, 'guarded-price-diff.audit.json', 'retained-sale')).text);
  expect(retained.issues).toContainEqual(expect.objectContaining({ code: 'woo-sale-not-below-regular' }));
  await field(page, 'Sale price column (optional)').selectOption('3');
  await field(page, 'Stock column (optional)').selectOption('2');
  await confirm(page).click();
  await pair(page, 'WooCommerce', false);
  const unmanaged = JSON.parse((await save(page, info, jsonAudit, 'guarded-price-diff.audit.json', 'unmanaged-stock')).text);
  expect(unmanaged.issues).toContainEqual(expect.objectContaining({ code: 'woo-stock-not-managed', value: '' }));
  await field(page, 'Stock column (optional)').selectOption('none');
  await confirm(page).click();
  await pair(page, 'WooCommerce', true);
  const before = parseCsv((await save(page, info, wooRollback, 'guarded-price-rollback.csv', 'guarded-resolved')).text);
  expect(before).toEqual([[...wooIdentity, 'Sale price'], ['501', 'variation, virtual', '00123', '00009', '037.000', '20.00']]);
  const formulaLike = wooMatrix.map(row => [...row]);
  formulaLike[2][wooHeaders.indexOf('SKU')] = '+ITEM';
  await field(page, 'Choose WooCommerce baseline CSV').setInputFiles(csv('formula-like.csv', formulaLike));
  await field(page, 'Choose supplier price sheet').setInputFiles(csv('formula-like-supplier.csv', [['SKU', 'Price'], ['+ITEM', '46.00']]));
  await pair(page, 'WooCommerce', true);
  await page.getByRole('checkbox', { name: /Guard spreadsheet formulas/ }).check();
  await pair(page, 'WooCommerce', false);
  const guardedAudit = JSON.parse((await save(page, info, jsonAudit, 'formula-like-price-diff.audit.json', 'guarded-id')).text);
  expect(guardedAudit.formulaGuard.blocked).toContainEqual(expect.objectContaining({ row: 3, column: 'SKU', before: '+ITEM', after: "'+ITEM" }));
  expect(guardedAudit.formulaGuard.neutralized).toEqual([]);
  const [head, , ...items] = parseCsv((await save(page, info, csvAudit, 'formula-like-price-diff.audit.csv', 'guarded-id')).text);
  const original = items.find(item => item[head.indexOf('SKU')] === "'+ITEM")!;
  expect(JSON.parse(original[head.indexOf('Original Baseline Cells (JSON)')])).toContainEqual(expect.objectContaining({ value: '+ITEM' }));
});

test('Inventory diff retains signed readable changes and exposes the full desktop Review controls', async ({ page, beginProcessing }, info) => {
  await openStudio(page, beginProcessing);
  await field(page, 'Choose Shopify baseline CSV').setInputFiles(shop);
  await field(page, 'Choose supplier price sheet').setInputFiles(csv('stock.csv', [
    ['SKU', 'Price', 'Stock'], ['00123', '36.00', '12'], ['00045-XL', '26.00', '7'],
  ]));
  await field(page, 'Inventory qty column (optional)').selectOption('2');
  await confirm(page).click();
  await pair(page, 'Shopify', true);
  const table = page.getByRole('table', { name: 'Shopify price diff' });
  await expect(table.getByRole('columnheader', { name: 'Review' })).toBeVisible();
  const columns = await table.getByRole('columnheader').allTextContents();
  expect(columns).toEqual(expect.arrayContaining(['Qty before', 'Qty after', 'Supplier source', 'Review']));
  for (const [sku, display] of [['00123', '-10%'], ['00045-XL', '+13.04%']]) {
    await expect(skuRow(page, sku).locator('th,td').nth(columns.indexOf('Change'))).toHaveText(display);
  }
  if (info.project.name === 'desktop') {
    const sizes = await table.evaluate(element => {
      const frame = element.closest('.table-scroll')!.getBoundingClientRect();
      const all = [...element.querySelectorAll('tr > :last-child, td:last-child label, td:last-child input, td:last-child button')];
      const clips = all.filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.left < frame.left - 1 || r.right > frame.right + 1);
      }).map(el => el.textContent);
      return { clips, frame: frame.width, table: element.getBoundingClientRect().width };
    });
    expect(sizes.clips, JSON.stringify(sizes)).toEqual([]);
    info.annotations.push({ type: 'm7-review-layout', description: JSON.stringify(sizes) });
    const check = skuRow(page, '00123').getByRole('checkbox', { name: 'Skip row' });
    await check.check();
    await expect(skuRow(page, '00123')).toHaveAttribute('data-status', 'Skipped');
    await check.uncheck();
    await pair(page, 'Shopify', true);
  }
});

test('Workspace profile roundtrip keeps only store defaults and refuses a mismatched profile on a live batch', async ({ page, beginProcessing }, info) => {
  await openStudio(page, beginProcessing);
  await expect(button(page, 'Shopify')).toHaveAttribute('aria-pressed', 'true');
  await button(page, 'WooCommerce').click();
  await button(page, 'Load Synthetic WooCommerce Demo').click();
  await formula(page).click();
  await field(page, 'Pricing mode').selectOption('tiered-brackets');
  await confirm(page).click();
  await expect(page.getByRole('table', { name: 'WooCommerce price diff' })).toBeVisible();
  const panel = page.getByText('Workspace profile', { exact: true });
  await panel.click();
  await field(page, 'Store name').fill('West Woo');
  await field(page, 'Workspace store currency').fill('GBP');
  const woo = await save(page, info, 'Save Workspace Profile (.json)', 'west-woo-workspace-profile.json', 'profiles');
  expect(JSON.parse(woo.text)).toMatchObject({ version: 1, storeName: 'West Woo', platform: 'woocommerce', storeCurrency: 'GBP' });
  await button(page, 'Shopify').click();
  await button(page, 'Switch to Shopify').click();
  await field(page, 'Choose Shopify baseline CSV').setInputFiles(shop);
  await field(page, 'Choose supplier price sheet').setInputFiles(supplier);
  await configureTiers(page);
  await page.getByText(/^Price guardrails ·/).click();
  await field(page, 'Maximum increase (%)').fill('130');
  await button(page, 'Apply guardrails').click();
  await pair(page, 'Shopify', true);
  if (!await field(page, 'Store name').isVisible()) await panel.click();
  await field(page, 'Store name').fill('North Shop');
  await field(page, 'Workspace store currency').fill('CAD');
  const profile = await save(page, info, 'Save Workspace Profile (.json)', 'north-shop-workspace-profile.json', 'profiles');
  expect(JSON.parse(profile.text)).toEqual({
    version: 1, storeName: 'North Shop', platform: 'shopify', storeCurrency: 'CAD', pricingRule: rule,
    dropThresholdPercent: 50, increaseThresholdPercent: 130, inventoryDropThresholdPercent: 80,
  });
  await loadProfile(page).setInputFiles(woo.path);
  await expect(page.getByRole('alert').filter({ hasText: 'This profile is for WooCommerce' })).toBeVisible();
  await expect(button(page, 'Shopify')).toHaveAttribute('aria-pressed', 'true');
  await pair(page, 'Shopify', true);
  await expect(skuRow(page, '00045-XL')).toContainText('40.99');
  await expect(field(page, 'Store name')).toHaveValue('North Shop');
  await field(page, 'Store name').fill('Other label');
  await field(page, 'Workspace store currency').fill('USD');
  await field(page, 'Tier 3 multiplier').fill('1.8');
  await loadProfile(page).setInputFiles(profile.path);
  await expect(page.getByRole('status').filter({ hasText: 'North Shop · Shopify · CAD' })).toBeVisible();
  await expect(field(page, 'Store name')).toHaveValue('North Shop');
  await expect(field(page, 'Workspace store currency')).toHaveValue('CAD');
  await pair(page, 'Shopify', false);
  await confirm(page).click();
  await pair(page, 'Shopify', true);
  await expect(skuRow(page, '00300')).toContainText('160.99');
  const replay = await save(page, info, 'Save Workspace Profile (.json)', 'north-shop-workspace-profile.json', 'reloaded-profile');
  expect(replay.text).toBe(profile.text);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});
