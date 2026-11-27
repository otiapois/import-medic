import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { assertFits, loadFile, test } from './browser';
import { button, csv, field, openStudio, save } from './m7-files';

test('Build Update copies the confirmed XLSX recipe command by keyboard and selects it when clipboard access is denied', async ({ page, context, baseURL, beginProcessing }, info) => {
  const origin = new URL(baseURL!).origin;
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await openStudio(page, beginProcessing);
  const baseline = csv('private-client-catalog.csv', [
    ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price'],
    ['case', 'Private client case', 'Size', 'S', '00123', '25.000'],
    ['case', '', '', 'L', '0045-BLK', '12.200'],
  ]);
  await field(page, 'Choose Shopify baseline CSV').setInputFiles(baseline);
  await field(page, 'Choose supplier price sheet').setInputFiles(resolve('fixtures/supplier-delta/synthetic-pricebook.xlsx'));
  await field(page, 'Supplier worksheet').selectOption('Q4_Prices');
  const panel = page.getByRole('tabpanel', { name: 'Build Update', exact: true });
  const summary = panel.getByText('Local CLI Command', { exact: true });
  const command = panel.getByRole('textbox', { name: 'CLI command', exact: true });
  await summary.focus();
  await summary.press('Enter');
  await expect(panel.getByText('Add the baseline, then review and confirm the settings for each supplier.')).toBeVisible();
  await expect(command).toHaveCount(0);

  await expect(field(page, 'SKU column')).toHaveValue('0');
  await expect(field(page, 'New price column')).toHaveValue('1');
  const confirm = button(page, 'Confirm columns');
  await expect(confirm).toBeEnabled();
  await field(page, 'Compare-at price column').focus();
  await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  const saveRecipe = button(page, 'Save Supplier Recipe (.json)');
  await expect(saveRecipe).toBeDisabled();
  await field(page, 'Supplier label').fill('Quarterly');
  await expect(saveRecipe).toBeEnabled();
  const recipe = await save(page, info, 'Save Supplier Recipe (.json)', 'quarterly-supplier-recipe.json', 'm18-clipboard');
  expect(JSON.parse(recipe.text)).toMatchObject({
    version: 6, supplierLabel: 'Quarterly', selectedSheet: 'Q4_Prices', sheetName: 'Q4_Prices',
    joinKey: { type: 'sku', skuColumn: 'SKU' }, priceColumn: 'Cost',
  });
  const sheet = Buffer.from('Q4_Prices', 'utf8').toString('base64url');
  const expected = 'npm run repair-cli -- --mode price-diff --platform shopify --baseline baseline.csv' +
    ' --supplier supplier-1.xlsx --sheet-b64 ' + sheet + ' --recipe supplier-1-recipe.json --confirm-mapping --out-dir output';
  await expect(command).toHaveValue(expected);
  await expect(command).toHaveAttribute('readonly', '');
  await expect(command).toHaveAccessibleDescription(/Replace the example input filenames/);
  const height = await command.evaluate((el: HTMLTextAreaElement) => ({ content: el.scrollHeight, visible: el.clientHeight }));
  expect(height.content, 'The full ordinary XLSX command fits the text area').toBeLessThanOrEqual(height.visible + 1);
  await summary.focus();
  await page.keyboard.press('Tab');
  await expect(command).toBeFocused();
  await page.keyboard.press('Tab');
  const copy = button(page, 'Copy CLI Command');
  await expect(copy).toBeFocused();
  await page.keyboard.press('Enter');
  const status = panel.getByRole('status').filter({ hasText: 'CLI command copied.' });
  await expect(status).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(expected);
  await writeFile(resolve(dirname(recipe.path), 'copied-command.txt'), clipboard);
  await writeFile(resolve(dirname(recipe.path), 'baseline.csv'), baseline.buffer);
  await assertFits(page);
  if (process.env.IMPORT_MEDIC_CAPTURE_M18_SCREENSHOTS === '1') {
    const dir = process.env.IMPORT_MEDIC_M18_SCREENSHOTS || resolve('docs/reports/screenshots/m18');
    await mkdir(dir, { recursive: true });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await summary.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 30));
    await page.screenshot({ path: resolve(dir, info.project.name + '-m18-cli-helper.png'), animations: 'disabled' });
  }
  const session = await context.newCDPSession(page);
  const { targetInfo } = await session.send('Target.getTargetInfo');
  for (const allowWithoutSanitization of [true, false]) {
    await session.send('Browser.setPermission', {
      origin, browserContextId: targetInfo.browserContextId, setting: 'denied',
      permission: { name: 'clipboard-write', allowWithoutSanitization },
    });
  }
  await session.detach();
  await copy.press('Enter');
  await expect(panel.getByRole('status').filter({ hasText: 'Command selected. Use your device’s copy command.' })).toBeVisible();
  await expect(command).toBeFocused();
  expect(await command.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, expected.length]);
  info.annotations.push({ type: 'm18-clipboard', description: JSON.stringify({ command: clipboard, recipeVersion: 6, selectedSheet: 'Q4_Prices', selectedLength: expected.length, height }) });
});

test('Repair command tracks the active bank options and keeps source filenames and transactions private', async ({ page, beginProcessing }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  beginProcessing();
  await page.getByRole('tab', { name: 'QuickBooks Bank' }).click();
  await loadFile(page, 'quickbooks/ambiguous-dates.csv');
  await field(page, 'Date format').selectOption('DMY');
  await page.getByLabel('QuickBooks output layout').selectOption('4col');
  await page.getByLabel('Credit / Debit convention').selectOption('bank');
  const summary = page.getByText('Local CLI Command', { exact: true });
  await summary.focus();
  await summary.press('Space');
  const command = page.getByRole('textbox', { name: 'CLI command', exact: true });
  await expect(command).toHaveValue('npm run repair-cli -- --mode repair --platform quickbooks-bank source.csv --date-order DMY --qbo-layout 4col --qbo-credit-debit bank --out-dir output');
  await page.getByLabel('QuickBooks output layout').selectOption('3col');
  await expect(command).toHaveValue('npm run repair-cli -- --mode repair --platform quickbooks-bank source.csv --date-order DMY --qbo-layout 3col --qbo-credit-debit bank --out-dir output');
});
