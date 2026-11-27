import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { costCreepDemo } from '../../src/web/workbench/cost-creep/demo';
import { assertFits, test } from './browser';
import { auditPage } from './m10-accessibility';
import { button, csv, field, parseCsv, save } from './m7-files';
import { metric } from './m8-reports';

const csvLabel = 'Cost-Creep CSV';
const briefLabel = 'Vendor Negotiation Brief (.html)';
const auditName = 'supplier-cost-creep-audit.json';
const briefName = 'vendor-negotiation-brief.html';
const modeLabel = 'Multi-Period Cost Creep (2–6 sheets)';
const status = (page: Page) => page.getByTestId('cost-creep-status');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const book = resolve('fixtures/supplier-delta/synthetic-pricebook.xlsx');

async function openCreep(page: Page, begin: () => void) {
  await page.goto('/shopify-price-update-diff', { waitUntil: 'networkidle' });
  const studio = page.getByRole('tablist', { name: /studio/i });
  await expect(studio.getByRole('tab')).toHaveCount(6);
  await expect(studio.getByRole('tab', { name: 'Build Update' })).toHaveAttribute('aria-selected', 'true');
  await studio.getByRole('tab', { name: 'Supplier Delta' }).click();
  const modes = page.getByRole('group', { name: 'Supplier Delta mode' });
  await expect(modes.getByRole('button', { name: '2-Sheet Delta' })).toHaveAttribute('aria-pressed', 'true');
  await modes.getByRole('button', { name: modeLabel }).click();
  await expect(page.getByRole('heading', { name: 'Multi-Period Cost Creep', exact: true })).toBeVisible();
  begin();
  await expect(status(page)).toHaveText('Choose a supplier file for every period');
  for (const label of [csvLabel, briefLabel, 'Audit JSON']) await expect(button(page, label)).toBeDisabled();
  await assertFits(page);
  return studio;
}

async function screenshot(page: Page, name: string, anchor: Locator) {
  await assertFits(page);
  if (process.env.IMPORT_MEDIC_CAPTURE_M20_SCREENSHOTS !== '1') return;
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await anchor.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 16));
  const dir = resolve('docs/reports/screenshots/m20');
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, name + '.png'), animations: 'disabled' });
}

async function openBrief(page: Page, info: TestInfo, stage: string) {
  const html = await save(page, info, briefLabel, briefName, stage);
  expect(html.text).not.toMatch(/<script\b|https?:\/\/|\b(?:srcset|href|src)\s*=|@import\b|url\s*\(/i);
  await page.context().setOffline(true);
  const report = await page.context().newPage();
  await report.goto(pathToFileURL(html.path).href);
  expect(new URL(report.url()).protocol).toBe('file:');
  await expect(report.getByRole('heading', { name: 'Vendor Negotiation Brief', exact: true })).toBeVisible();
  await expect(report.locator('script,[src],[srcset],[href],base,form,object,embed,iframe,period-note,file-note')).toHaveCount(0);
  expect(await report.locator('*').evaluateAll(nodes => nodes.flatMap(node => node.getAttributeNames().filter(key => /^on/i.test(key))))).toEqual([]);
  await expect(report.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content',
    "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  await assertFits(report);
  return { report, html };
}

test('Four supplier quarters reproduce the watchlist, margin and byte custody in the branded offline negotiation brief', async ({ page, beginProcessing }, info) => {
  const studio = await openCreep(page, beginProcessing);
  await studio.getByRole('tab', { name: 'Build Update' }).click();
  const profile = page.locator('.workspace-profile');
  await profile.locator(':scope > summary').click();
  await profile.locator('.signoff-branding > summary').click();
  await field(page, 'Agency name').fill('Northline Buying Office');
  await field(page, 'Prepared for').fill('Field Supply Co.');
  await field(page, 'Contact email or note').fill('Quarterly supplier review');
  await page.getByRole('radio', { name: 'Navy' }).check();
  await studio.getByRole('tab', { name: 'Supplier Delta' }).click();
  await button(page, 'Load Synthetic 4-Quarter Cost-Creep Demo').click();
  await expect(status(page)).toHaveAttribute('data-ready', 'true');
  for (const [label, value] of [['Tracked SKUs', '7'], ['SKUs >= Threshold', '4'], ['Worst Cumulative Hike %', '16.00%'], ['Consecutive Multi-Hike SKUs', '3']]) {
    await metric(page, label, value);
  }
  const table = page.getByRole('table', { name: 'Cost creep by SKU' });
  const skus = table.locator('tbody th > code');
  const filters = page.getByRole('group', { name: 'Filter cost creep' });
  await filters.getByRole('button', { name: 'At or above threshold' }).click();
  await expect(skus).toHaveText(['00103', '00101', '00102', '00105']);
  await filters.getByRole('button', { name: 'Lifecycle changes' }).click();
  await expect(skus).toHaveCount(3);
  await field(page, 'Search SKUs').fill('00105');
  await expect(skus).toHaveText(['00105']);
  const gap = table.locator('tbody tr');
  await expect(gap).toContainText('Reappeared');
  await expect(gap).toContainText('Longest hike streak 1');
  await expect(gap.locator('svg g')).toHaveCount(2);
  await expect(gap.locator('svg circle')).toHaveCount(3);
  await field(page, 'Search SKUs').fill('');
  await filters.getByRole('button', { name: 'All', exact: true }).click();
  await expect(skus).toHaveCount(7);
  const access = await auditPage(page, 'workbench');
  await screenshot(page, info.project.name + '-m20-cost-creep', page.getByRole('heading', { name: 'Cost creep review' }));
  const history = await save(page, info, csvLabel, 'supplier-cost-creep.csv', 'm20-demo');
  const audit = JSON.parse((await save(page, info, 'Audit JSON', auditName, 'm20-demo')).text);
  const { report, html } = await openBrief(page, info, 'm20-demo');
  const demo = costCreepDemo();
  async function original(file: File) {
    const bytes = Buffer.from(await file.arrayBuffer());
    await writeFile(resolve(dirname(history.path), file.name), bytes);
    return { filename: file.name, bytes: bytes.length, sha256: sha(bytes) };
  }
  const custody = {
    periods: await Promise.all(demo.periods.map(async ({ file, label }) => ({ ...await original(file), label, selectedSheet: null }))),
    retail: await original(demo.retail),
    historyCsvSha256: sha(await readFile(history.path)), briefHtmlSha256: sha(await readFile(html.path)),
  };
  expect(audit.custody).toEqual(custody);
  expect(audit.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ sku: '00103', cumulativeDelta: '0.8', cumulativeDeltaPercent: '16.00', hikeCount: 3, consecutiveHikes: 3,
      margin: expect.objectContaining({ retail: '10', oldGrossMarginPercent: '50.00', newGrossMarginPercent: '42.00', compressionPoints: '8.00' }) }),
    expect.objectContaining({ sku: '00105', lifecycle: 'reappeared', cumulativeDeltaPercent: '10.00', meetsThreshold: true,
      hikeCount: 1, consecutiveHikes: 1, observations: [expect.any(Object), null, expect.any(Object), expect.any(Object)] }),
    expect.objectContaining({ sku: '00106', lifecycle: 'discontinued', dropCount: 2 }),
    expect.objectContaining({ sku: '00107', lifecycle: 'added-later' }),
  ]));
  const [headers, ...data] = parseCsv(history.text);
  expect(data).toHaveLength(7);
  const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
  const leading = data.find(row => row[columns.SKU] === '00103')!;
  expect(['Q1 source cost', 'Q2 source cost', 'Q3 source cost', 'Q4 source cost', 'Old gross margin %', 'New gross margin %']
    .map(key => leading[columns[key]])).toEqual(['5', '5.25', '5.52', '5.80', '50.00', '42.00']);
  const brand = report.getByRole('complementary', { name: 'Agency branding' });
  await expect(brand.locator('div')).toHaveText(['Prepared by Northline Buying Office', 'Prepared for Field Supply Co.', 'Quarterly supplier review']);
  await expect(brand).toHaveCSS('background-color', 'rgb(26, 54, 93)');
  const offender = report.locator('article').filter({ has: report.getByRole('heading', { name: '00103' }) });
  await expect(offender.locator('li')).toHaveText(['Q1 5', 'Q2 5.25', 'Q3 5.52', 'Q4 5.80']);
  await expect(offender).toContainText('50.00% → 42.00%');
  expect(await offender.locator('svg polyline').evaluate(el => (el as SVGPolylineElement).getTotalLength())).toBeGreaterThan(148);
  await expect(offender.locator('svg circle')).toHaveCount(4);
  await expect(report.locator('footer code')).toHaveText([...custody.periods.map(entry => entry.sha256), custody.retail.sha256, custody.historyCsvSha256]);
  if (info.project.name === 'desktop') await screenshot(report, 'desktop-m20-negotiation-brief', brand);
  await report.close();
  await page.context().setOffline(false);
  const threshold = field(page, 'Cumulative creep threshold (%)');
  await threshold.fill('');
  await expect(status(page)).toContainText('Enter a cumulative creep threshold');
  for (const label of [csvLabel, briefLabel, 'Audit JSON']) await expect(button(page, label)).toBeDisabled();
  await threshold.fill('10.00001');
  await metric(page, 'SKUs >= Threshold', '3');
  const changed = JSON.parse((await save(page, info, 'Audit JSON', auditName, 'm20-threshold')).text);
  expect(changed.thresholdPercent).toBe('10.00001');
  expect(changed.rows).toContainEqual(expect.objectContaining({ sku: '00105', cumulativeDeltaPercent: '10.00', meetsThreshold: false }));
  expect(changed.custody.historyCsvSha256).not.toBe(custody.historyCsvSha256);
  info.annotations.push({ type: 'm20-demo', description: JSON.stringify({ custody, access, summary: audit.summary, viewport: page.viewportSize(), browser: page.context().browser()?.version() }) });
});

test('Uploaded XLSX worksheets and CSV keep period order, escape report labels and hold conflicting physical source lines', async ({ page, beginProcessing }, info) => {
  await openCreep(page, beginProcessing);
  const bookName = 'synthetic-pricebook.xlsx';
  const marker = 'Earlier <period-note> & quote';
  await field(page, 'Period 1 label').fill(marker);
  await field(page, 'Period 1 supplier file').setInputFiles(book);
  const sheet = (slot: number) => field(page, 'Period ' + slot + ' worksheet');
  await expect(sheet(1).locator('option')).toHaveText(['Instructions', 'Q4_Prices', 'Q3_Prices']);
  await sheet(1).selectOption('Q3_Prices');
  await field(page, 'Period 2 supplier file').setInputFiles(book);
  await expect(sheet(2)).toHaveValue('Instructions');
  await sheet(2).selectOption('Q4_Prices');
  await expect(sheet(1)).toHaveValue('Q3_Prices');
  await button(page, 'Add period').click();
  await field(page, 'Period 3 label').fill('Q3');
  const offer = csv('offer <file-note>.csv', [['Item', 'Quote', 'Note'], ['00123', '30.25', 'line one\r\nline two']]);
  await field(page, 'Period 3 supplier file').setInputFiles(offer);
  await field(page, 'Period 3 SKU column').selectOption('0');
  await field(page, 'Period 3 cost column').selectOption('1');
  await field(page, 'Cost currency').fill('USD');
  const baseline = csv('retail.csv', [['Ticket', 'Item'], ['50', '00123']]);
  await page.locator('.creep-baseline > summary').click();
  await field(page, 'Store Baseline CSV').setInputFiles(baseline);
  await field(page, 'Baseline SKU column').selectOption('1');
  await field(page, 'Baseline retail price column').selectOption('0');
  await field(page, 'Baseline retail currency').fill('USD');
  await expect(status(page)).toHaveAttribute('data-ready', 'true');
  const audit = JSON.parse((await save(page, info, 'Audit JSON', auditName, 'm20-upload')).text);
  const bookDigest = sha(await readFile(book));
  expect(audit.custody.periods).toMatchObject([
    { label: marker, filename: bookName, selectedSheet: 'Q3_Prices', sha256: bookDigest },
    { filename: bookName, selectedSheet: 'Q4_Prices', sha256: bookDigest },
    { filename: offer.name, selectedSheet: null, sha256: sha(offer.buffer) },
  ]);
  expect(audit.custody.retail.sha256).toBe(sha(baseline.buffer));
  expect(audit.rows).toContainEqual(expect.objectContaining({ sku: '00123', cumulativeDeltaPercent: '21.00', consecutiveHikes: 2,
    margin: expect.objectContaining({ retail: '50', oldGrossMarginPercent: '50.00', newGrossMarginPercent: '39.50' }) }));
  const { report } = await openBrief(page, info, 'm20-upload');
  await expect(report.locator('main')).toContainText(marker);
  await expect(report.locator('main')).toContainText(offer.name);
  await report.close();
  await page.context().setOffline(false);
  // Observe a genuine disabled transition even when the next Worker finishes very quickly.
  const disabledTransition = button(page, csvLabel).evaluate(el => new Promise<boolean>(resolve => {
    const observer = new MutationObserver(changes => {
      if (changes.some(change => change.oldValue === null)) { observer.disconnect(); resolve(true); }
    });
    observer.observe(el, { attributes: true, attributeFilter: ['disabled'], attributeOldValue: true });
    setTimeout(() => { observer.disconnect(); resolve(false); }, 5000);
  }));
  await button(page, 'Move period 3 earlier').click();
  expect(await disabledTransition).toBe(true);
  await expect(field(page, 'Period 2 label')).toBeFocused();
  await expect(sheet(3)).toHaveValue('Q4_Prices');
  await expect(sheet(1)).toHaveValue('Q3_Prices');
  await expect(status(page)).toHaveAttribute('data-ready', 'true');
  const reordered = JSON.parse((await save(page, info, 'Audit JSON', auditName, 'm20-reordered')).text);
  expect(reordered.custody.periods.map((entry: { label: string }) => entry.label)).toEqual([marker, 'Q3', 'Q2']);
  expect(reordered.custody.historyCsvSha256).not.toBe(audit.custody.historyCsvSha256);
  expect(reordered.rows).toContainEqual(expect.objectContaining({ sku: '00123', cumulativeDeltaPercent: '14.00', consecutiveHikes: 1, dropCount: 1 }));
  const broken = csv('conflicting.csv', [['SKU', 'Cost', 'Note'], ['00123', '30.25', 'first\r\nsecond'],
    ['001e2', '6', 'ambiguous SKU'], ['BAD', 'oops', 'bad price'], ['00123', '40', 'conflict']]);
  await field(page, 'Period 2 supplier file').setInputFiles(broken);
  await expect(status(page)).toHaveAttribute('data-held', 'true');
  const issues = page.getByRole('list', { name: 'Cost creep source issues' });
  await expect(issues).toContainText('Q3 · rows 2, 6');
  await expect(issues).toContainText('Q3 · row 4');
  await expect(issues).toContainText('Q3 · row 5');
  for (const label of [csvLabel, briefLabel]) await expect(button(page, label)).toBeDisabled();
  const held = JSON.parse((await save(page, info, 'Audit JSON', auditName, 'm20-held')).text);
  expect(held.status).toBe('blocked');
  expect(held.rows).toEqual([]);
  expect(Object.keys(held.custody).sort()).toEqual(['periods', 'retail']);
  expect(held.custody.periods[1]).toMatchObject({ label: 'Q3', filename: broken.name, sha256: sha(broken.buffer) });
  expect(held.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'invalid-sku', periodLabel: 'Q3', row: 4 }),
    expect.objectContaining({ code: 'invalid-amount', periodLabel: 'Q3', row: 5 }),
    expect.objectContaining({ code: 'conflicting-duplicate-sku', periodLabel: 'Q3', rows: [2, 6] }),
  ]));
  await assertFits(page);
  info.annotations.push({ type: 'm20-upload', description: JSON.stringify({ inputDigests: held.custody, issues: held.issues, viewport: page.viewportSize() }) });
});
