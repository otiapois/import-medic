import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from './browser';
import { auditPage, captureV1 } from './m10-accessibility';
import { button, csv, field, openStudio, pair, parseCsv, save } from './m7-files';

const shop = csv('canvas-shopify.csv', [
  ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value', 'Variant SKU', 'Variant Price', 'Variant Compare At Price', 'Variant Inventory Qty', 'Body (HTML)'],
  ['canvas', 'Canvas Tote', 'Size', 'Small', '', '', '', '', '00123', '040.000', '050.00', '0008', '<p>Keep, exactly</p>'],
  ['canvas', '', '', 'Large', '', '', '', '', '00124', '045.00', '065.00', '0010', ''],
]);
const woo = csv('canvas-woo.csv', [
  ['ID', 'Type', 'SKU', 'Name', 'Parent', 'Regular price', 'Sale price', 'Stock', 'Description'],
  ['4100', 'variable', '00040', 'Canvas Tote', '', '', '', '', 'Parent copy'],
  ['4101', 'variation', '00123', 'Small Tote', '00040', '040.000', '030.00', '0008', 'Keep, exactly'],
  ['4102', 'variation', '00124', 'Large Tote', 'id:4100', '045.00', '035.00', '0010', 'Sibling copy'],
]);

const fingerprint = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const verifyMode = (page: Page) => page.getByRole('tab', { name: 'Verify Update / Rollback CSV' });

for (const platform of ['Shopify', 'WooCommerce'] as const) {
  test(platform + ' downloaded update and rollback, independent verification and unsafe standalone CSV', async ({ page, beginProcessing }, info) => {
    const isWoo = platform === 'WooCommerce';
    const baseline = isWoo ? woo : shop;
    const forbidden = isWoo ? 'Description' : 'Body (HTML)';
    const sku = isWoo ? 'SKU' : 'Variant SKU';
    const price = isWoo ? 'Regular price' : 'Variant Price';
    const secondary = isWoo ? 'Sale price' : 'Variant Compare At Price';
    const stock = isWoo ? 'Stock' : 'Variant Inventory Qty';
    const supplier = csv('fall-prices.csv', [['SKU', 'Price', 'Offer', 'Qty'], ['00123', '42.00', isWoo ? '32.00' : '52.00', '10']]);
    const changes = [[price, '040.000', '42.00'], [secondary, isWoo ? '030.00' : '050.00', isWoo ? '32.00' : '52.00'], [stock, '0008', '10']];
    await openStudio(page, beginProcessing);
    if (isWoo) await button(page, platform).click();
    await field(page, 'Choose ' + platform + ' baseline CSV').setInputFiles(baseline);
    await field(page, 'Choose supplier price sheet').setInputFiles(supplier);
    await field(page, isWoo ? 'Sale price column (optional)' : 'Compare-at price column').selectOption('2');
    await field(page, isWoo ? 'Stock column (optional)' : 'Inventory qty column (optional)').selectOption('3');
    await button(page, 'Confirm columns').click();
    await pair(page, platform, true);
    await expect(page.getByRole('table', { name: platform + ' price diff' })).toBeVisible();
    if (!isWoo) await captureV1(page, info.project.name + '-v1-price-diff', info.project.name === 'mobile' ? '.price-filters' : '.price-search');
    if (!isWoo && info.project.name === 'desktop') {
      const detail = page.getByText('Included unchanged with product group', { exact: true });
      const wordBoxes = await detail.evaluate(el => {
        const text = el.firstChild as Text;
        const start = text.data.indexOf('unchanged');
        const word = document.createRange();
        word.setStart(text, start);
        word.setEnd(text, start + 'unchanged'.length);
        return Array.from(word.getClientRects(), box => ({ y: box.y, width: box.width }));
      });
      expect(wordBoxes, 'The unchanged sibling status fits its desktop column').toHaveLength(1);
    }
    const measurements = { build: await auditPage(page, 'workbench') };
    const stem = baseline.name.replace('.csv', '-price-');
    const update = await save(page, info, 'Download Safe ' + platform + ' Update CSV', stem + 'update.csv', 'm10-' + platform);
    const rollback = await save(page, info, 'Download ' + platform + ' Rollback CSV', stem + 'rollback.csv', 'm10-' + platform);
    const updateBytes = await readFile(update.path);
    const rollbackBytes = await readFile(rollback.path);
    const updateRows = parseCsv(update.text);
    const rollbackRows = parseCsv(rollback.text);
    const [baseHeaders, ...baseRows] = parseCsv(baseline.buffer.toString('utf8'));
    const [headers, ...records] = updateRows;
    expect(rollbackRows[0]).toEqual(headers);
    expect(headers).not.toContain(forbidden);
    expect(records.map(row => row[headers.indexOf(sku)])).toEqual(isWoo ? ['00123'] : ['00123', '00124']);
    for (const [index, row] of records.entries()) {
      const key = row[headers.indexOf(sku)];
      const original = baseRows.find(cells => cells[baseHeaders.indexOf(sku)] === key)!;
      for (const [col, header] of headers.entries()) {
        const originalValue = original[baseHeaders.indexOf(header)];
        const change = key === '00123' ? changes.find(([name]) => name === header) : undefined;
        expect(rollbackRows[index + 1][col], key + ' rollback ' + header).toBe(originalValue);
        expect(row[col], key + ' update ' + header).toBe(change?.[2] ?? originalValue);
      }
    }

    const hashes = { baseline: fingerprint(baseline.buffer), update: fingerprint(updateBytes), rollback: fingerprint(rollbackBytes) };
    await verifyMode(page).click();
    await page.getByTestId('verify-load-pair').click();
    const verdict = page.getByTestId('verify-verdict');
    const metric = (name: string) => page.getByTestId('verify-metric-' + name);
    const report = page.getByRole('region', { name: 'Verification result', exact: true });
    const hashValue = (field: string) => report.locator('[data-custody-field="' + field + '"]');
    await expect(verdict).toHaveText('PASS');
    await expect(hashValue('baseline')).toHaveText(hashes.baseline);
    await expect(hashValue('candidate')).toHaveText(hashes.update);
    await expect(metric('changed-skus')).toHaveText('1');
    await expect(metric('unchanged-siblings')).toHaveText('1');
    await expect(metric('non-target-mutations')).toHaveText('0');
    await expect(metric('broken-groups')).toHaveText('0');
    const diff = page.getByTestId('verify-rows');
    await expect(diff.getByRole('rowheader')).toHaveCount(1);
    await expect(diff.getByRole('rowheader').getByText('00123', { exact: true })).toBeVisible();
    for (const [column, before, after] of changes) {
      const cell = diff.getByRole('listitem').filter({ has: page.getByText(column, { exact: true }) });
      await expect(cell.locator('dd').nth(0)).toHaveText(before);
      await expect(cell.locator('dd').nth(1)).toHaveText(after);
      await expect(cell.locator('dd').nth(2)).toHaveText(/^\+?2(?:\.0+)?$/);
    }
    if (!isWoo && info.project.name === 'desktop') await captureV1(page, 'desktop-v1-verify-before-import', '.verify-report');
    const inspect = await auditPage(page, 'workbench');
    await page.getByTestId('verify-rollback').click();
    await expect(verdict).toHaveText('PASS');
    await expect(hashValue('candidate')).toHaveText(hashes.rollback);
    await expect(hashValue('paired-update')).toHaveText(hashes.update);
    await expect(report.getByRole('heading', { name: 'Paired rollback replay' })).toBeVisible();
    await expect(page.getByTestId('verify-residual-diffs')).toHaveText('0 residual differences');

    await button(page, 'Use local CSV files').click();
    await page.getByRole('combobox', { name: 'Store platform', exact: true }).selectOption(isWoo ? 'woocommerce' : 'shopify');
    await field(page, 'Choose baseline CSV').setInputFiles(baseline);
    const candidateInput = field(page, 'Choose update or rollback CSV');
    await candidateInput.setInputFiles(rollback.path);
    await page.getByTestId('verify-submit').click();
    await expect(verdict).toHaveText('PASS');
    await expect(hashValue('candidate')).toHaveText(hashes.rollback);
    await expect(report.getByRole('heading', { name: 'Baseline cell comparison' })).toBeVisible();
    await expect(hashValue('paired-update')).toHaveCount(0);
    await expect(page.getByTestId('verify-residual-diffs')).toHaveText('0 target cell differences');
    const tampered = csv('unsafe.csv', updateRows.map((row, index) => [...row, index === 0 ? forbidden : '']));
    await candidateInput.setInputFiles(tampered);
    await page.getByTestId('verify-submit').click();
    await expect(verdict).toHaveText('FAIL_UNSAFE');
    await expect(hashValue('candidate')).toHaveText(fingerprint(tampered.buffer));
    await expect(metric('non-target-mutations')).toHaveText('1');
    const issue = page.getByTestId('verify-issues').locator('[data-issue-code="forbidden-column"]');
    await expect(issue).toContainText('Candidate line 1');
    await expect(issue.getByText(forbidden, { exact: true })).toBeVisible();
    const corrupt = csv('lost-leading-zero.csv', updateRows.map(row => row.map((value, i) => i === headers.indexOf(sku) && value === '00123' ? '123' : value)));
    await candidateInput.setInputFiles(corrupt);
    await page.getByTestId('verify-submit').click();
    await expect(verdict).toHaveText('FAIL_UNSAFE');
    await expect(hashValue('candidate')).toHaveText(fingerprint(corrupt.buffer));
    const identityIssue = page.getByTestId('verify-issues').locator('[data-issue-code*="leading-zero"]');
    await expect(identityIssue).toContainText('Candidate line 2');
    await expect(identityIssue.getByText(sku, { exact: true })).toBeVisible();
    await page.getByTestId('verify-load-pair').click();
    await expect(verdict).toHaveText('PASS');
    await page.getByRole('tab', { name: 'Build Update' }).click();
    await button(page, 'Clear baseline file').click();
    await verifyMode(page).click();
    await expect(page.getByTestId('verify-load-pair')).toBeDisabled();
    await expect(verdict).toHaveCount(0);
    info.annotations.push({ type: 'm10-independent-import', description: JSON.stringify({ platform, hashes, changes, tampered: fingerprint(tampered.buffer), corrupt: fingerprint(corrupt.buffer), pairedResidual: 0 }) });
    info.annotations.push({ type: 'm10-accessibility', description: JSON.stringify({ ...measurements, inspect }) });
  });
}
