import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';
import { assertFits, test } from './browser';
import { catalog, platforms, replay } from './m12-catalog';
import { button, csv, field, parseCsv, save } from './m7-files';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fingerprint = (region: Locator, name: string) => region.locator('[data-custody-field="' + name + '"]');

async function capture(page: Page, anchor: Locator, filename: string) {
  await assertFits(page);
  if (process.env.IMPORT_MEDIC_CAPTURE_M12_SCREENSHOTS !== '1') return;
  await page.evaluate(() => document.fonts.ready);
  await anchor.evaluate(element => window.scrollBy(0, element.getBoundingClientRect().top - 16));
  const dir = resolve('docs/reports/screenshots/m12');
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, filename + '.png'), animations: 'disabled' });
}

for (const platform of platforms) {
  test(platform + ' campaign floor hold, native sale pair, exact catalog restore and offline sign-off', async ({ page, beginProcessing }, info) => {
    await page.goto('/shopify-price-update-diff', { waitUntil: 'networkidle' });
    await expect(page.getByRole('tab', { name: 'Build Update' })).toHaveAttribute('aria-selected', 'true');
    const tab = page.getByRole('tab', { name: 'Sale Campaign Pack' });
    await tab.focus();
    await tab.press('Enter');
    const panel = page.getByTestId('campaign-panel');
    await expect(panel.getByRole('heading', { name: 'Sale Campaign Pack' })).toBeVisible();
    await panel.getByRole('button', { name: platform, exact: true }).click();
    beginProcessing();
    await button(page, 'Load Synthetic Promo Demo').click();
    const { input, lowLine, stem, secondSku } = catalog(platform);
    const launch = page.getByTestId('campaign-download-launch');
    const revert = page.getByTestId('campaign-download-revert');
    const held = page.getByTestId('campaign-metric-held');
    const row = (sku: string) => panel.locator('[data-campaign-sku="' + sku + '"]');
    const promo = (sku: string) => row(sku).locator('[data-campaign-cell="promo"]');
    await expect(held).toHaveText('1');
    await expect(row('DEMO-LOW')).toHaveAttribute('data-campaign-status', 'held');
    await expect(promo('DEMO-100')).toContainText(platform === 'Shopify' ? '80.99' : '76.99');
    await expect(launch).toBeDisabled();
    await expect(revert).toBeDisabled();
    await expect(row('DEMO-LOW').locator('[data-issue-code="minimum-retail-breach"]')).toContainText('9.99');
    await field(page, 'Minimum retail floor').fill('9.99');
    await expect(launch).toBeEnabled();
    await expect(revert).toBeEnabled();

    await field(page, 'Choose campaign baseline CSV').setInputFiles(input);
    await field(page, 'Minimum retail floor').fill('10.00');
    await field(page, 'SKU scope').selectOption('prefix');
    await field(page, 'SKU prefix').fill('PROMO-');
    const costSheet = csv('campaign-cost.csv', [['SKU', 'Cost'], ['PROMO-001', '83.00'], ['PROMO-LOW', '4.01'], [secondSku, '40.00']]);
    if (platform === 'Shopify') {
      await field(page, 'Check prices against cost').check();
      await expect(field(page, 'Preserve higher Shopify compare-at price')).toBeChecked();
    } else if (platform === 'WooCommerce') {
      await field(page, 'Check prices against cost').check();
      await field(page, 'Choose cost sheet').setInputFiles(costSheet);
    } else {
      await expect(panel.getByText('Ignore blank values', { exact: true })).toBeVisible();
    }
    await expect(field(page, 'Discount type')).toHaveValue('percent-off');
    await expect(field(page, 'Percent off')).toHaveValue('20');
    await expect(field(page, 'Rounding')).toHaveValue('ending-99');
    await expect(held).toHaveText('1');
    await expect(row('PROMO-LOW')).toHaveAttribute('data-campaign-line', String(lowLine));
    await expect(row('PROMO-LOW').locator('[data-issue-code="minimum-retail-breach"]')).toContainText('9.99');
    if (platform !== 'BigCommerce') await expect(row('PROMO-001').locator('[data-issue-code="promo-below-cost"]')).toContainText('83.00');
    await expect(launch).toBeDisabled();
    await expect(revert).toBeDisabled();
    await expect(page.getByTestId('campaign-download-signoff')).toBeDisabled();
    await expect(page.getByTestId('campaign-open-verify')).toBeDisabled();
    await expect(fingerprint(panel, 'baseline')).toHaveText(hash(input.buffer));
    await expect(fingerprint(panel, 'launch')).toHaveCount(0);
    await expect(fingerprint(panel, 'revert')).toHaveCount(0);
    const group = 'm12-' + platform;
    const heldAudit = JSON.parse((await save(page, info, 'Download JSON Audit', stem + '-promo-audit.json', group + '-held')).text);
    expect(heldAudit).toMatchObject({ canExport: false, custody: { launchSha256: null, revertSha256: null }, verification: null });
    if (platform === 'BigCommerce') {
      expect(heldAudit.issues).toContainEqual(expect.objectContaining({ line: lowLine, severity: 'hold', message: expect.stringMatching(/blank|empty/i), column: 'Sale Price' }));
    }

    const skip = panel.getByRole('button', { name: 'Skip line ' + lowLine, exact: true });
    await skip.focus();
    await skip.press('Enter');
    await expect(launch).toBeEnabled();
    await expect(row('PROMO-LOW')).toHaveAttribute('data-campaign-status', 'skipped');
    await expect(page.getByTestId('campaign-metric-changed')).toHaveText('2');
    await expect(page.getByTestId('campaign-metric-skipped')).toHaveText('1');
    await expect(promo(secondSku)).toContainText('60.99');
    if (platform === 'Shopify') {
      const suffix = info.project.name === 'desktop' ? 'desktop-m12-promo-pack' : 'mobile-m12-promo';
      await capture(page, page.getByRole('heading', { name: 'Campaign preview' }), suffix);
    }
    const launched = await save(page, info, 'Download Promo Launch CSV', stem + '-promo-launch.csv', group);
    const reverted = await save(page, info, 'Download Promo End Revert CSV', stem + '-promo-revert.csv', group);
    const audit = JSON.parse((await save(page, info, 'Download JSON Audit', stem + '-promo-audit.json', group)).text);
    const html = await save(page, info, 'Download Campaign Sign-Off (.html)', stem + '-promo-sign-off.html', group);
    const dir = dirname(launched.path);
    await writeFile(resolve(dir, input.name), input.buffer);
    if (platform === 'WooCommerce') await writeFile(resolve(dir, costSheet.name), costSheet.buffer);
    const custody = {
      baselineSha256: hash(input.buffer), launchSha256: hash(await readFile(launched.path)), revertSha256: hash(await readFile(reverted.path)),
      ...(platform === 'WooCommerce' ? { costSheetSha256: hash(costSheet.buffer) } : {}),
    };
    expect(audit).toMatchObject({ canExport: true, platform: platform.toLowerCase(), custody, skippedLines: [lowLine],
      verification: { restored: true, residualDiffs: 0, nonTargetMutations: 0, brokenGroups: 0 } });
    await expect(fingerprint(panel, 'launch')).toHaveText(custody.launchSha256);
    await expect(fingerprint(panel, 'revert')).toHaveText(custody.revertSha256);
    if (custody.costSheetSha256) await expect(fingerprint(panel, 'cost-sheet')).toHaveText(custody.costSheetSha256);
    const changes = replay(platform, launched.text, reverted.text);
    const reduction = platform === 'Shopify' ? '33.52' : '32.62';
    expect(audit.summary.totalPriceReduction).toBe(reduction);
    const offline = await page.context().newPage();
    await offline.goto(pathToFileURL(html.path).href);
    expect(new URL(offline.url()).protocol).toBe('file:');
    await expect(offline.getByRole('heading', { name: 'Promo Campaign Sign-Off' })).toBeVisible();
    await expect(offline.locator('script, a[href], link[href], [src], iframe, form, em')).toHaveCount(0);
    const csp = await offline.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp?.split(/;\s*/)).toEqual(expect.arrayContaining(["default-src 'none'", "script-src 'none'", "connect-src 'none'"]));
    await expect(offline.getByText(secondSku, { exact: true })).toBeVisible();
    await expect(offline.getByText(reduction, { exact: true })).toBeVisible();
    await expect(offline.getByText(audit.summary.averageDiscountPercent + '%', { exact: true })).toBeVisible();
    await expect(offline.getByText(/below the minimum retail floor/)).toBeVisible();
    if (platform !== 'BigCommerce') await expect(offline.getByText(/below cost 83\.00/)).toBeVisible();
    for (const value of Object.values(custody)) await expect(offline.getByText(value, { exact: true })).toBeVisible();
    await assertFits(offline);
    if (info.project.name === 'desktop') {
      const geometry = await offline.locator('table').evaluate(table => {
        const headers = [...table.querySelectorAll('thead th')];
        const fields = ['Status', 'Before', 'Promo', 'Revert', 'Minimum retail', 'Cost', 'Price less cost'];
        const cells = [...table.querySelectorAll('tbody td')].filter(cell =>
          fields.includes(headers[(cell as HTMLTableCellElement).cellIndex].textContent!));
        const broken: string[] = [];
        for (const cell of [...headers, ...cells]) {
          const text = cell.firstChild as Text;
          const bounds = cell.getBoundingClientRect();
          for (const word of text.data.matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(text, word.index);
            range.setEnd(text, word.index + word[0].length);
            const boxes = [...range.getClientRects()];
            if (boxes.length !== 1 || boxes[0].left < bounds.left - 1 || boxes[0].right > bounds.right + 1) broken.push(word[0]);
          }
        }
        const frame = table.parentElement!;
        return { broken, tableWidth: table.getBoundingClientRect().width, availableWidth: frame.clientWidth };
      });
      info.annotations.push({ type: 'm12-offline-geometry', description: JSON.stringify({ platform, ...geometry }) });
      expect(geometry.broken, 'Every sign-off amount, status and header word fits its desktop cell').toEqual([]);
      expect(geometry.tableWidth).toBeLessThanOrEqual(geometry.availableWidth + 1);
    }
    if (platform === 'Shopify' && info.project.name === 'desktop') await capture(offline, offline.locator('header'), 'desktop-m12-promo-signoff');
    await offline.close();

    await page.getByTestId('campaign-open-verify').click();
    await page.getByTestId('verify-load-pair').click();
    const report = page.getByRole('region', { name: 'Verification result' });
    const verdict = page.getByTestId('verify-verdict');
    const residual = page.getByTestId('verify-residual-diffs');
    await expect(verdict).toHaveText('PASS');
    await expect(fingerprint(report, 'candidate')).toHaveText(custody.launchSha256);
    await page.getByTestId('verify-rollback').click();
    await expect(fingerprint(report, 'candidate')).toHaveText(custody.revertSha256);
    await expect(verdict).toHaveText('PASS');
    await expect(residual).toHaveText('0 residual differences');

    await button(page, 'Use local CSV files').click();
    await page.getByRole('combobox', { name: 'Store platform', exact: true }).selectOption(platform.toLowerCase());
    await field(page, 'Choose baseline CSV').setInputFiles(input);
    const candidate = field(page, 'Choose update or rollback CSV');
    const submit = page.getByTestId('verify-submit');
    await candidate.setInputFiles(launched.path);
    await submit.click();
    await expect(verdict).toHaveText('PASS');
    await expect(fingerprint(report, 'baseline')).toHaveText(custody.baselineSha256);
    await expect(fingerprint(report, 'candidate')).toHaveText(custody.launchSha256);
    await expect(page.getByTestId('verify-metric-changed-skus')).toHaveText('2');
    await expect(page.getByTestId('verify-metric-non-target-mutations')).toHaveText('0');
    await expect(page.getByTestId('verify-metric-broken-groups')).toHaveText('0');
    await candidate.setInputFiles(reverted.path);
    await page.getByText('Check a rollback with its matching update', { exact: true }).click();
    await field(page, 'Choose matching update CSV').setInputFiles(launched.path);
    await submit.click();
    await expect(verdict).toHaveText('PASS');
    await expect(fingerprint(report, 'candidate')).toHaveText(custody.revertSha256);
    await expect(fingerprint(report, 'paired-update')).toHaveText(custody.launchSha256);
    await expect(residual).toHaveText('0 residual differences');
    const forbidden = platform === 'Shopify' ? 'Tags' : platform === 'WooCommerce' ? 'Description' : 'Category';
    const corrupt = csv('changed-scope.csv', parseCsv(reverted.text).map((cells, i) => [...cells, i ? '' : forbidden]));
    await candidate.setInputFiles(corrupt);
    await submit.click();
    await expect(verdict).toHaveText('FAIL_UNSAFE');
    await expect(page.getByTestId('verify-issues')).toContainText(forbidden);
    await expect(fingerprint(report, 'candidate')).toHaveText(hash(corrupt.buffer));
    await assertFits(page);
    info.annotations.push({ type: 'm12-campaign', description: JSON.stringify({ platform, custody, changes, reduction,
      heldLine: lowLine, pairedResidual: 0, width: await page.evaluate(() => document.documentElement.scrollWidth) }) });
  });
}
