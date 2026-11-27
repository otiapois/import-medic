import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertFits, loadFile, test } from './browser';
import { button, csv, field, openStudio, parseCsv, save } from './m7-files';

const baseline = resolve('fixtures/shopify-price-diff/baseline-agency.csv');
const wholesale = csv('m16-wholesale.csv', [
  ['SKU', 'Cost', 'Currency'], ['00045-XL', '10.00', 'EUR'], ['00046-L', '10.00', 'EUR'],
]);
const scenarios = [
  { key: 'current', label: 'Current Rule', retail: '23.87', cents: 574, margin: '54.545455%' },
  { key: 'markup', label: '+5% Markup', retail: '25.06', cents: 812, margin: '56.703911%' },
  { key: 'fx', label: 'FX +3% Buffer', retail: '24.59', cents: 718, margin: '54.552664%' },
  { key: 'round', label: '.95 Rounding', retail: '23.95', cents: 590, margin: '54.697286%' },
];
const brand = { agencyName: '<script>alert(1)</script> & "Co"', preparedFor: 'O\'Brien & West', contactNote: 'Audit <copy> for "Finance"', accentKey: 'navy' };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const shaFile = async (path: string) => sha(await readFile(path));
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const csp = "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

async function capture(page: Page, anchor: Locator, filename: string) {
  if (process.env.IMPORT_MEDIC_CAPTURE_M16_SCREENSHOTS !== '1') return;
  const directory = resolve(process.env.IMPORT_MEDIC_M16_SCREENSHOTS ?? 'docs/reports/screenshots/m16');
  await mkdir(directory, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  const inset = filename.startsWith('mobile') ? 4 : 16;
  await anchor.evaluate((element, offset) => window.scrollBy(0, element.getBoundingClientRect().top - offset), inset);
  await page.screenshot({ path: resolve(directory, filename + '.png'), animations: 'disabled' });
}

async function pricing(page: Page) {
  await field(page, 'Choose Shopify baseline CSV').setInputFiles(baseline);
  await field(page, 'Choose supplier price sheet').setInputFiles(wholesale);
  await field(page, 'New price column').selectOption('1');
  await page.locator('.pricing-formula > summary').click();
  await field(page, 'Pricing mode').selectOption('multiplier');
  await field(page, 'Multiplier').fill('2.2');
  await field(page, 'Convert supplier currency (manual rate)').check();
  await field(page, 'Source currency code').fill('EUR');
  await field(page, 'Store currency code').fill('USD');
  await field(page, 'Exact rate').fill('1.0850');
  await page.getByLabel(/verified.*FX rate/).check();
  await button(page, 'Confirm columns').click();
  await expect(page.getByTestId('price-diff-status')).toHaveText('Ready to download');
}

async function nativePair(page: Page, info: TestInfo, stage: string, retail: string, predictedCents: number) {
  const get = (label: string, suffix: string) => save(page, info, label, 'baseline-agency-' + suffix, stage);
  const update = await get('Download Safe Shopify Update CSV', 'price-update.csv');
  const rollback = await get('Download Shopify Rollback CSV', 'price-rollback.csv');
  const audit = JSON.parse((await get('Download Full Diff Audit (.json)', 'price-diff.audit.json')).text);
  const [headers, ...catalog] = parseCsv(await readFile(baseline, 'utf8'));
  const [fields, ...patch] = parseCsv(update.text);
  const [backFields, ...back] = parseCsv(rollback.text);
  expect(fields).toEqual(['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value',
    'Option3 Name', 'Option3 Value', 'Variant SKU', 'Variant Price']);
  expect(backFields).toEqual(fields);
  const sourceRows = catalog.filter(row => row[headers.indexOf('Handle')] === 'canvas-jacket' && row[headers.indexOf('Variant SKU')]);
  const projected = sourceRows.map(row => fields.map(f => row[headers.indexOf(f)]));
  expect(back).toEqual(projected);
  expect(patch).toEqual(projected.map((row, i) => i === 0 ? row : [...row.slice(0, -1), retail]));
  const toCents = (amount: string) => Number(amount.replace('.', ''));
  const actualCents = patch.reduce((sum, row, i) => sum + toCents(row.at(-1)!) - toCents(back[i].at(-1)!), 0);
  expect(actualCents).toBe(predictedCents);
  expect(audit.verification).toEqual({ checked: true, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 });
  expect(audit.rollbackVerification).toMatchObject({ checked: true, restoredVariants: 3 });
  for (const row of audit.rows) {
    expect(row.oldCompareAtPrice).toBe(row.newCompareAtPrice);
    const original = catalog.find(source => source[headers.indexOf('Variant SKU')] === row.sku)!;
    const changed = ['00045-XL', '00046-L'].includes(row.sku);
    expect(row.oldPrice).toBe(original[headers.indexOf('Variant Price')]);
    expect(row.newPrice).toBe(changed ? retail : row.oldPrice);
  }
  const hashes = [await shaFile(baseline), sha(wholesale.buffer), await shaFile(update.path), await shaFile(rollback.path)];
  expect(audit.custody).toEqual({ baselineSha256: hashes[0], suppliers: [{ filename: wholesale.name, bytes: wholesale.buffer.length, sha256: hashes[1] }],
    updateCsvSha256: hashes[2], rollbackCsvSha256: hashes[3] });
  await writeFile(resolve(dirname(update.path), wholesale.name), wholesale.buffer);
  info.annotations.push({ type: 'm16-native', description: JSON.stringify({ stage, retail, actualCents, hashes }) });
  return hashes;
}

for (const scenario of scenarios) {
  test('What-if applies ' + scenario.label + ' with exact native prices and rollback', async ({ page, beginProcessing }, info) => {
    await openStudio(page, beginProcessing);
    await pricing(page);
    const panel = page.locator('.what-if-panel');
    await expect(panel).not.toHaveAttribute('open', '');
    await panel.locator('summary').click();
    for (const item of scenarios.slice(1)) await button(page, item.label).click();
    const card = (label: string) => panel.getByRole('article', { name: label, exact: true });
    for (const item of scenarios) {
      const delta = card(item.label).locator('[data-retail-delta-cents]');
      await expect(delta).toHaveText('+' + (item.cents / 100).toFixed(2));
      await expect(delta).toHaveAttribute('data-retail-delta-cents', String(item.cents));
      await expect(card(item.label).locator('dt')).toHaveText(['Avg Margin %', 'Negative Margin SKUs', 'Total Retail Impact', 'Changed SKUs', 'Sub-floor SKUs', 'Lowest-margin SKU']);
      await expect(card(item.label).locator('dd')).toHaveText([item.margin, '0', '+' + (item.cents / 100).toFixed(2), '2', '0', '00045-XL']);
    }
    const predicted = Number(await card(scenario.label).locator('[data-retail-delta-cents]').getAttribute('data-retail-delta-cents'));
    if (scenario.key === 'markup') {
      const rects = await panel.locator('button,input,article').evaluateAll(nodes => nodes.map(el => {
        const { left, right, width } = el.getBoundingClientRect();
        return { label: el.getAttribute('aria-label') ?? el.textContent?.slice(0, 24), left, right, width };
      }));
      expect(rects.filter(r => r.left < 0 || r.right > page.viewportSize()!.width || r.width <= 0)).toEqual([]);
      await assertFits(page);
      const desktop = info.project.name === 'desktop';
      await capture(page, desktop ? panel : card('Current Rule'), desktop ? 'desktop-m16-whatif-simulator' : 'mobile-m16-whatif');
      for (const value of ['1.25', '2.50']) {
        await field(page, 'Custom markup (%)').fill(value);
        await button(page, 'Add custom scenario').click();
      }
      await expect(panel.getByRole('article')).toHaveCount(6);
      await expect(button(page, 'Add custom scenario')).toBeDisabled();
      await expect(card('Custom 1').locator('[data-retail-delta-cents]')).toHaveText('+6.34');
      await expect(card('Custom 2').locator('[data-retail-delta-cents]')).toHaveText('+6.94');
      await button(page, 'Remove Custom 2').click();
      await expect(button(page, 'Add custom scenario')).toBeEnabled();
      await field(page, 'Exact rate').fill('1.085');
      await expect(card(scenario.label).getByRole('button')).toBeDisabled();
      await expect(card(scenario.label).locator('[data-retail-delta-cents]')).toHaveCount(0);
      await expect(button(page, 'Download Safe Shopify Update CSV')).toBeDisabled();
      await page.getByLabel(/verified.*FX rate/).check();
      await button(page, 'Confirm columns').click();
      await expect(card(scenario.label).locator('[data-retail-delta-cents]')).toHaveText('+8.12');
    }
    if (scenario.key !== 'current') {
      await card(scenario.label).getByRole('button', { name: 'Apply Scenario' }).click();
      await expect(panel.getByRole('status')).toContainText('Applied ' + scenario.label);
      await expect(card('Current Rule').locator('[data-retail-delta-cents]')).toHaveAttribute('data-retail-delta-cents', String(predicted));
    }
    await nativePair(page, info, 'm16-' + scenario.key, scenario.retail, predicted);
  });
}

async function offline(page: Page, info: TestInfo, report: { path: string; text: string }, digests: string[], kind: string) {
  // Verify the bytes are inert before navigating to a downloaded local document.
  expect(report.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;');
  expect(report.text).toContain('O&#39;Brien &amp; West');
  expect(report.text).toContain('Audit &lt;copy&gt; for &quot;Finance&quot;');
  expect(report.text).toContain('content="' + csp + '"');
  expect(report.text).not.toMatch(/<script\b|<iframe\b|\s(?:src|href|srcset|action|on\w+)\s*=|(?:https?:\/\/|@import|url\s*\()/i);
  const viewer = await page.context().newPage();
  const dialogs: string[] = [];
  viewer.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  await viewer.goto(pathToFileURL(report.path).href);
  expect(new URL(viewer.url()).protocol).toBe('file:');
  const header = viewer.getByRole('complementary', { name: 'Agency branding' });
  await expect(header.locator('div')).toHaveText(['Prepared by ' + brand.agencyName, 'Prepared for ' + brand.preparedFor, brand.contactNote]);
  await expect(header).toHaveCSS('background-color', 'rgb(26, 54, 93)');
  await expect(header).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(viewer.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', csp);
  await expect(viewer.locator('script,[src],[href],[srcset],iframe,object,embed,form,base')).toHaveCount(0);
  for (const digest of digests) await expect(viewer.locator('footer').getByText(digest, { exact: true }).first()).toBeVisible();
  await assertFits(viewer);
  if (kind === 'client' && info.project.name === 'desktop') await capture(viewer, header, 'desktop-m16-whitelabel-signoff');
  expect(dialogs).toEqual([]);
  info.annotations.push({ type: 'm16-offline', description: JSON.stringify({ kind, sha256: await shaFile(report.path), digests, width: await viewer.locator('html').evaluate(el => el.scrollWidth), dialogs: dialogs.length }) });
  await viewer.close();
}

test('Five branded offline sign-offs preserve the active agency, workspace profile and downloaded custody', async ({ page, beginProcessing }, info) => {
  test.setTimeout(90_000);
  const books = await page.context().newPage();
  await books.goto('/', { waitUntil: 'networkidle' });
  await tab(books, 'Xero Bank CSV').click();
  await openStudio(page, beginProcessing);
  const section = page.locator('.workspace-profile');
  await section.locator(':scope > summary').click();
  const drawer = section.locator('.signoff-branding');
  await drawer.locator('summary').press('Enter');
  await field(page, 'Agency name').fill('Earlier agency');
  await field(page, 'Store name').fill('M16 agency');
  await field(page, 'Workspace store currency').fill('USD');
  const stage = 'm16-brand';
  const download = (label: string, filename: string) => save(page, info, label, filename, stage);
  const profileName = 'm16-agency-workspace-profile.json';
  const firstProfile = await save(page, info, 'Save Workspace Profile (.json)', profileName, 'm16-profile-initial');
  await button(page, 'Clear branding').click();
  await field(page, 'Load Workspace Profile (.json)').setInputFiles(firstProfile.path);
  await expect(field(page, 'Agency name')).toHaveValue('Earlier agency');
  await pricing(page);

  // Produce all reports once, then change the shared header while the results are still open.
  const promo = csv('retainer.csv', [
    ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Variant Compare At Price'],
    ['boots', 'Boots', 'Size', 'L', 'BOOT-L', '100.00', '120.00'],
  ]);
  await tab(page, 'Sale Campaign Pack').click();
  await field(page, 'Choose campaign baseline CSV').setInputFiles(promo);
  await field(page, 'Minimum retail floor').fill('10.00');
  await expect(button(page, 'Download Campaign Sign-Off (.html)')).toBeEnabled();
  const previous = csv('m16-before.csv', [['SKU', 'Cost'], ['A-1', '10.00']]);
  const next = csv('m16-after.csv', [['SKU', 'Cost'], ['A-1', '11.00']]);
  await tab(page, 'Supplier Delta').click();
  await field(page, 'Choose previous supplier sheet').setInputFiles(previous);
  await field(page, 'Choose new supplier sheet').setInputFiles(next);
  await expect(button(page, 'Delta Sign-Off (.html)')).toBeEnabled();
  const catalog = resolve('fixtures/catalog-migrator/shopify-canvas.csv');
  await tab(page, 'Migrate Catalog').click();
  await field(page, 'Choose source catalog CSV').setInputFiles(catalog);
  await expect(button(page, 'Migration Sign-Off (.html)')).toBeEnabled();
  await loadFile(books, 'xero-bank/balance-verified.csv');
  await expect(button(books, 'Download Bookkeeper Sign-Off (.html)')).toBeEnabled();

  await tab(page, 'Build Update').click();
  await drawer.getByLabel('Agency name').fill(brand.agencyName);
  await drawer.getByLabel('Prepared for').fill(brand.preparedFor);
  await drawer.getByLabel('Contact email or note').fill(brand.contactNote);
  await drawer.getByRole('radio', { name: 'Navy' }).check();
  await expect(drawer.getByLabel('Agency branding preview')).toContainText(brand.agencyName);
  const palette = await drawer.locator('.signoff-palettes label span').evaluateAll(nodes => {
    const luminance = (rgb: string) => rgb.match(/\d+/g)!.slice(0, 3).reduce((sum, value, i) => {
      const channel = Number(value) / 255;
      return sum + [0.2126, 0.7152, 0.0722][i] * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    }, 0);
    return nodes.map(node => {
      const css = getComputedStyle(node);
      const fg = luminance(css.color), bg = luminance(css.backgroundColor);
      return { name: node.textContent, contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) };
    });
  });
  expect(palette.map(color => color.name)).toEqual(['Forest', 'Navy', 'Slate', 'Burgundy']);
  expect(palette.filter(color => color.contrast < 5.5)).toEqual([]);
  info.annotations.push({ type: 'm16-palette', description: JSON.stringify({ browser: page.context().browser()?.version(), palette }) });
  const profile = await download('Save Workspace Profile (.json)', profileName);
  expect(JSON.parse(profile.text).branding).toEqual(brand);
  for (const source of [promo, previous, next]) await writeFile(resolve(dirname(profile.path), source.name), source.buffer);

  const hashes = await nativePair(page, info, stage, '23.87', 574);
  await offline(page, info, await download('Download Client Sign-Off (.html)', 'baseline-agency-client-sign-off.html'), hashes, 'client');

  await tab(page, 'Sale Campaign Pack').click();
  const launched = await download('Download Promo Launch CSV', 'retainer-promo-launch.csv');
  const reverted = await download('Download Promo End Revert CSV', 'retainer-promo-revert.csv');
  const campaignAudit = JSON.parse((await download('Download JSON Audit', 'retainer-promo-audit.json')).text);
  const campaignHashes = { baselineSha256: sha(promo.buffer), launchSha256: await shaFile(launched.path), revertSha256: await shaFile(reverted.path) };
  expect(campaignAudit.custody).toEqual(campaignHashes);
  await offline(page, info, await download('Download Campaign Sign-Off (.html)', 'retainer-promo-sign-off.html'), Object.values(campaignHashes), 'campaign');

  await tab(page, 'Supplier Delta').click();
  const delta = await download('Supplier Delta CSV', 'supplier-delta-report.csv');
  const deltaHtml = await download('Delta Sign-Off (.html)', 'supplier-delta-sign-off.html');
  const deltaAudit = JSON.parse((await download('JSON Audit', 'supplier-delta-audit.json')).text);
  const deltaHashes = { previousSha256: sha(previous.buffer), newSha256: sha(next.buffer), deltaCsvSha256: await shaFile(delta.path) };
  expect(deltaAudit.custody).toEqual({ ...deltaHashes, signOffHtmlSha256: await shaFile(deltaHtml.path) });
  await offline(page, info, deltaHtml, Object.values(deltaHashes), 'supplier');

  await tab(page, 'Migrate Catalog').click();
  const migrated = await download('Target Import CSV', 'migrated-shopify-to-woocommerce.csv');
  const migrateHtml = await download('Migration Sign-Off (.html)', 'migration-sign-off.html');
  const migrateAudit = JSON.parse((await download('Migration Audit JSON', 'migration-audit.json')).text);
  const migrateHashes = { sourceSha256: await shaFile(catalog), targetSha256: await shaFile(migrated.path) };
  expect(migrateAudit.custody).toEqual({ ...migrateHashes, signOffSha256: await shaFile(migrateHtml.path) });
  await offline(page, info, migrateHtml, Object.values(migrateHashes), 'migration');

  await books.locator('.signoff-branding > summary').click();
  await field(books, 'Load Workspace Profile (.json)').setInputFiles(profile.path);
  await expect(books.getByLabel('Agency branding preview')).toContainText(brand.agencyName);
  await expect(books.getByRole('radio', { name: 'Navy' })).toBeChecked();
  const repaired = await save(books, info, 'Download Repaired CSV', 'balance-verified-repaired.csv', stage);
  const ledgerAudit = JSON.parse((await save(books, info, 'Download Audit Report (.json)', 'balance-verified.audit.json', stage)).text);
  const bookHashes = { sourceSha256: await shaFile(resolve('fixtures/xero-bank/balance-verified.csv')), repairedCsvSha256: await shaFile(repaired.path) };
  expect(ledgerAudit.custody).toEqual(bookHashes);
  const bookHtml = await save(books, info, 'Download Bookkeeper Sign-Off (.html)', 'balance-verified-bookkeeper-sign-off.html', stage);
  await offline(books, info, bookHtml, Object.values(bookHashes), 'bookkeeper');
  await assertFits(books);
  await books.close();
});
