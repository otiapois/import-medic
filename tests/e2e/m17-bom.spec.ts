import { expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { assertFits, test } from './browser';
import { button, csv, field, openSignoff, openStudio, pair, parseCsv, save } from './m7-files';

const catalog = csv('gift-catalog.csv', [
  ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value', 'Variant SKU', 'Variant Price', 'Cost per item', 'Vendor'],
  ...[
    ['mug', '  Mug, glazed  ', '00123', '5.000', '2.50'],
    ['wrap', 'Gift wrap', 'WRAP', '2.500', '1.25'],
    ['box', 'Outer box', 'BOX', '4.000', '2.00'],
    ['wrapped-set', 'Wrapped set', 'KIT-A', '14.000', '7.00'],
    ['gift-set', 'Gift set', 'KIT-B', '35.000', '17.50'],
  ].map(([handle, title, sku, retail, cost]) => [handle, title, 'Title', 'Default Title', '', '', '', '', sku, retail, cost, 'Gift Shop']),
]);
const supplier = csv('mug-costs.csv', [['SKU', 'Cost'], ['00123', '3.00']]);
const bom = csv('gift-parts.csv', [
  ['Bundle SKU', 'Component SKU', 'Quantity', 'Assembly Cost'],
  ['KIT-A', '00123', '2', '0.75'], ['KIT-A', 'WRAP', '1', ''],
  ['KIT-B', 'KIT-A', '2', '1.50'], ['KIT-B', 'BOX', '1', ''],
]);
const cycle = csv('cycle-parts.csv', [
  ['Bundle SKU', 'Component SKU', 'Quantity'], ['KIT-A', 'KIT-B', '1'], [], ['KIT-B', 'KIT-A', '1'],
]);
const components = [
  { kit: 'KIT-A', sku: '00123', line: 2, qty: '2', old: '2.50', unit: '3.00', ext: '6.00', source: 'supplier', sourceLabel: 'Updated supplier cost', file: supplier.name, ref: 2, column: 'Cost' },
  { kit: 'KIT-A', sku: 'WRAP', line: 3, qty: '1', old: '1.25', unit: '1.25', ext: '1.25', source: 'baseline', sourceLabel: 'Baseline cost fallback', file: catalog.name, ref: 3, column: 'Cost per item' },
  { kit: 'KIT-B', sku: 'KIT-A', line: 4, qty: '2', old: '7.00', unit: '8.00', ext: '16.00', source: 'bundle', sourceLabel: 'Nested bundle rollup', file: bom.name, ref: 2, column: 'Bundle SKU' },
  { kit: 'KIT-B', sku: 'BOX', line: 5, qty: '1', old: '2.00', unit: '2.00', ext: '2.00', source: 'baseline', sourceLabel: 'Baseline cost fallback', file: catalog.name, ref: 4, column: 'Cost per item' },
];
const kits = [
  { sku: 'KIT-A', old: '7.00', cost: '8.00', retail: '16.00', assembly: '0.75', line: 2, baseline: 5, depth: 1 },
  { sku: 'KIT-B', old: '17.50', cost: '19.50', retail: '39.00', assembly: '1.50', line: 4, baseline: 6, depth: 2 },
];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fingerprint = (page: Page, key: string) => page.locator('[data-custody-field="' + key + '"]');
const metrics = (root: Locator, label: string) => root.getByText(label, { exact: true }).locator('..').locator('dd');

async function upload(page: Page) {
  await field(page, 'Choose Shopify baseline CSV').setInputFiles(catalog);
  await field(page, 'Choose supplier price sheet').setInputFiles(supplier);
  await page.locator('.bom-input > summary').click();
  await field(page, 'Choose Bundle BOM sheet').setInputFiles(bom);
  await field(page, 'New price column').selectOption('1');
  await page.locator('.pricing-formula > summary').click();
  await field(page, 'Pricing mode').selectOption('multiplier');
  await field(page, 'Multiplier').fill('2');
  await button(page, 'Confirm columns').click();
  await expect(page.getByTestId('price-diff-status')).toHaveText('Ready to download');
}

async function capture(page: Page, anchor: Locator, name: string) {
  await assertFits(page);
  if (process.env.IMPORT_MEDIC_CAPTURE_M17_SCREENSHOTS !== '1') return;
  const directory = resolve(process.env.IMPORT_MEDIC_M17_SCREENSHOTS ?? 'docs/reports/screenshots/m17');
  await mkdir(directory, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await anchor.evaluate(element => window.scrollBy(0, element.getBoundingClientRect().top - 16));
  await page.screenshot({ path: resolve(directory, name + '.png'), animations: 'disabled' });
}

test('Nested BOM file rolls up supplier and baseline costs into a verified native pair and offline sign-off', async ({ page, beginProcessing }, info) => {
  await openStudio(page, beginProcessing);
  await upload(page);
  const rollup = page.getByTestId('bundle-cost-rollup');
  await expect(rollup.getByTestId('bundle-kit')).toHaveCount(2);
  for (const k of kits) {
    const kit = rollup.getByRole('article', { name: k.sku });
    await expect(kit).toContainText('Baseline line ' + k.baseline + ' · BOM lines ' + k.line + ', ' + (k.line + 1));
    await expect(metrics(kit, 'Previous kit cost')).toHaveText(k.old + 'Baseline cost');
    await expect(metrics(kit, 'Rolled-up kit cost')).toHaveText(k.cost);
    await expect(metrics(kit, 'Projected kit retail')).toHaveText(k.retail);
    await expect(metrics(kit, 'Projected gross margin')).toHaveText('50.00%');
    await expect(metrics(kit, 'Assembly cost')).toHaveText(k.assembly + 'BOM line ' + k.line);
    for (const c of components.filter(c => c.kit === k.sku)) {
      const item = kit.getByTestId('bom-component').filter({ has: page.getByText(c.sku, { exact: true }) });
      await expect(item).toContainText('BOM line ' + c.line);
      await expect(metrics(item, 'Quantity')).toHaveText(c.qty);
      await expect(metrics(item, 'Unit cost')).toHaveText(c.unit + (c.old === c.unit ? '' : 'Before ' + c.old));
      await expect(metrics(item, 'Extended cost')).toHaveText(c.ext);
      await expect(item).toContainText(c.sourceLabel);
      await expect(item).toContainText(c.file + ' · line ' + c.ref + ' · ' + c.column);
    }
  }
  const mobile = info.project.name === 'mobile';
  await capture(page, mobile ? rollup.getByRole('article', { name: 'KIT-B' }) : rollup, mobile ? 'mobile-m17-bom' : 'desktop-m17-bom-rollup');
  const get = (label: string, suffix: string) => save(page, info, label, 'gift-catalog-' + suffix, 'm17-nested');
  const update = await get('Download Safe Shopify Update CSV', 'price-update.csv');
  const rollback = await get('Download Shopify Rollback CSV', 'price-rollback.csv');
  const audit = JSON.parse((await get('Download Full Diff Audit (.json)', 'price-diff.audit.json')).text);
  for (const item of [catalog, supplier, bom]) await writeFile(resolve(dirname(update.path), item.name), item.buffer);
  const [fields, ...source] = parseCsv(catalog.buffer.toString('utf8'));
  const [columns, ...updates] = parseCsv(update.text);
  const [backColumns, ...restored] = parseCsv(rollback.text);
  expect(columns).toEqual(fields.slice(0, 10));
  expect(backColumns).toEqual(columns);
  const changed = new Map([['00123', '6.00'], ['KIT-A', '16.00'], ['KIT-B', '39.00']]);
  const targets = source.filter(row => changed.has(row[8])).map(row => row.slice(0, 10));
  expect(restored).toEqual(targets);
  expect(updates).toEqual(targets.map(row => [...row.slice(0, 9), changed.get(row[8])]));
  expect(audit.verification).toEqual({ checked: true, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 });
  expect(audit.rollbackVerification).toMatchObject({ checked: true, restoredVariants: 3 });
  expect(audit.bom.kits).toMatchObject(kits.map(k => ({
    sku: k.sku, depth: k.depth, baselineLine: k.baseline, lines: [k.line, k.line + 1], oldCost: k.old, oldCostSource: 'baseline',
    newCost: k.cost, newRetail: k.retail, grossMarginPercent: '50.00', assemblyCost: k.assembly, assemblyLine: k.line,
    components: components.filter(c => c.kit === k.sku).map(c => ({
      sku: c.sku, line: c.line, quantity: c.qty, previousUnitCost: c.old, unitCost: c.unit, extendedCost: c.ext,
      source: { kind: c.source, filename: c.file, line: c.ref, column: c.column },
    })),
  })));
  const hashes = [sha(catalog.buffer), sha(supplier.buffer), sha(bom.buffer), sha(await readFile(update.path)), sha(await readFile(rollback.path))];
  expect(audit.custody).toEqual({ baselineSha256: hashes[0], suppliers: [{ filename: supplier.name, bytes: supplier.buffer.length, sha256: hashes[1] }],
    bom: { filename: bom.name, bytes: bom.buffer.length, sha256: hashes[2] }, updateCsvSha256: hashes[3], rollbackCsvSha256: hashes[4] });
  for (const [i, key] of ['baseline', 'supplier-1', 'bom', 'update', 'rollback'].entries()) await expect(fingerprint(page, key)).toHaveText(hashes[i]);
  const offline = await openSignoff(page, info, 'gift-catalog', 'm17-nested');
  await expect(offline.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content',
    "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  await expect(offline.locator('footer code')).toHaveText(hashes);
  const section = offline.locator('section').filter({ has: offline.getByRole('heading', { name: 'Bundle Cost Rollup' }) });
  for (const k of kits) {
    await expect(section).toContainText('BOM lines ' + k.line + ', ' + (k.line + 1) + ' · Baseline line ' + k.baseline + ' · Bundle depth ' + k.depth);
    await expect(section).toContainText('Previous cost ' + k.old + ' · New cost ' + k.cost + ' · Projected retail ' + k.retail + ' · Projected margin 50.00%');
    await expect(section).toContainText('Assembly cost ' + k.assembly + ' · BOM line ' + k.line);
    const table = section.getByRole('table', { name: 'Components for ' + k.sku });
    for (const c of components.filter(c => c.kit === k.sku)) {
      const row = table.getByRole('row').filter({ has: offline.getByRole('cell', { name: c.sku + ' · ' + c.line, exact: true }) });
      expect((await row.getByRole('cell').allTextContents()).slice(0, 5)).toEqual([c.sku + ' · ' + c.line, c.qty, c.old, c.unit, c.ext]);
      await expect(row.getByRole('cell').last()).toContainText(c.file + ' · Row ' + c.ref + ' · ' + c.column);
    }
  }
  info.annotations.push({ type: 'm17-nested', description: JSON.stringify({ browser: page.context().browser()?.version(), hashes, nativeRows: updates.length }) });
  await offline.close();
});

test('Circular BOM replacement holds the native pair, clears stale hashes and reports physical cycle lines', async ({ page, beginProcessing }, info) => {
  await openStudio(page, beginProcessing);
  await upload(page);
  const oldHashes = await Promise.all(['bom', 'update', 'rollback'].map(key => fingerprint(page, key).textContent()));
  await field(page, 'Choose Bundle BOM sheet').setInputFiles(cycle);
  const rollup = page.getByTestId('bundle-cost-rollup');
  await expect(rollup.getByRole('alert')).toHaveText('Bundle BOM checks blocked the native update and rollback CSVs.');
  await expect(rollup).toContainText('Bundle BOM lines 2, 4');
  await expect(rollup).toContainText('Bundle cycle KIT-A → KIT-B → KIT-A on lines 2, 4.');
  await pair(page, 'Shopify', false);
  await expect(page.getByTestId('price-diff-status')).toHaveText('Review required');
  for (const key of ['update', 'rollback']) await expect(fingerprint(page, key)).toHaveCount(0);
  await expect(fingerprint(page, 'bom')).toHaveText(sha(cycle.buffer));
  for (const hash of oldHashes) await expect(page.getByText(hash!, { exact: true })).toHaveCount(0);
  if (info.project.name === 'desktop') await capture(page, rollup, 'desktop-m17-bom-cycle-block');
  const result = await save(page, info, 'Download Full Diff Audit (.json)', 'gift-catalog-price-diff.audit.json', 'm17-cycle');
  await writeFile(resolve(dirname(result.path), cycle.name), cycle.buffer);
  const audit = JSON.parse(result.text);
  expect(audit.bom.issues).toContainEqual(expect.objectContaining({ code: 'bom-cycle', source: 'bom', row: 2, rows: [2, 4], bomPath: ['KIT-A', 'KIT-B', 'KIT-A'], blocking: true }));
  expect(audit.custody).toEqual({ baselineSha256: sha(catalog.buffer), suppliers: [{ filename: supplier.name, bytes: supplier.buffer.length, sha256: sha(supplier.buffer) }],
    bom: { filename: cycle.name, bytes: cycle.buffer.length, sha256: sha(cycle.buffer) } });
  await button(page, 'Remove Bundle BOM sheet').click();
  await expect(rollup).toHaveCount(0);
  await expect(fingerprint(page, 'bom')).toHaveCount(0);
  await pair(page, 'Shopify', true);
  info.annotations.push({ type: 'm17-cycle', description: JSON.stringify({ oldHashes, cycleHash: sha(cycle.buffer), lines: [2, 4] }) });
});
