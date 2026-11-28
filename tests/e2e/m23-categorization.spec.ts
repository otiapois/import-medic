import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertFits, test } from './browser';
import { auditPage } from './m10-accessibility';
import { button, csv, parseCsv, save } from './m7-files';

const ready = (page: Page) => expect(page.getByTestId('categorization-status')).toHaveAttribute('data-state', 'ready');
const panel = (page: Page) => page.getByRole('region', { name: 'Bookkeeper auto-categorization', exact: true });
const demo = 'Load Synthetic SaaS & GCC/UK VAT Rule Pack Demo';
const ruleLabel = 'Save Rule Pack (.json)';
const transactionsLabel = 'Download Categorized CSV';
const summaryLabel = 'Download Account Summary CSV';
const htmlLabel = 'Download Bookkeeper Categorization Sign-Off (.html)';
const auditLabel = 'Download Audit JSON';
const htmlName = 'bookkeeper-categorization-sign-off.html';
const ruleName = 'bookkeeper-rule-pack.json';
const transactionName = 'categorized-transactions.csv';
const auditName = 'categorization-audit.json';
const fixture = (name: string) => resolve('fixtures/m23', name);
const brandNote = 'Review <ledger-note> & https://example.invalid/books';

function fingerprint(filename: string, bytes: Buffer) {
  return { filename, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function original(dir: string, filename: string, bytes: Buffer) {
  await mkdir(resolve(dir, 'inputs'), { recursive: true });
  await writeFile(resolve(dir, 'inputs', filename), bytes);
  return fingerprint(filename, bytes);
}

async function open(page: Page, begin: () => void) {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'QuickBooks Bank', exact: true }).click();
  await page.getByTestId('categorization-toggle').click();
  await expect(panel(page).getByRole('heading', { name: 'Bookkeeper auto-categorization' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  begin();
}

async function photograph(page: Page, filename: string, anchor: Locator) {
  if (process.env.IMPORT_MEDIC_CAPTURE_M23_SCREENSHOTS !== '1') return;
  const dir = resolve('docs/reports/screenshots/m23');
  await mkdir(dir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await anchor.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 18));
  await page.screenshot({ path: resolve(dir, filename + '.png'), animations: 'disabled' });
}

async function exerciseTable(page: Page, scroller: Locator) {
  await assertFits(page);
  const size = await scroller.evaluate(el => ({ available: el.clientWidth, content: el.scrollWidth }));
  if (size.content > size.available) {
    await scroller.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    await expect(scroller).toBeFocused();
    await scroller.evaluate(el => { el.scrollLeft = 0; });
  }
  await assertFits(page);
  return size;
}

async function heldAudit(page: Page, info: TestInfo, stage: string) {
  await expect(page.getByTestId('categorization-status')).toHaveAttribute('data-state', 'blocked');
  for (const name of [transactionsLabel, summaryLabel, htmlLabel]) await expect(button(page, name)).toBeDisabled();
  const file = await save(page, info, auditLabel, auditName, stage);
  const data = JSON.parse(file.text);
  expect(data.status).toBe('blocked');
  expect(data.custody).not.toHaveProperty('outputs');
  expect(data.accountSummary).toEqual([]);
  return { data, dir: dirname(file.path) };
}

test('Categorization demo reconciles signed VAT by currency, fingerprints actual downloads and opens the branded sign-off offline', async ({ page, beginProcessing }, info) => {
  await open(page, beginProcessing);
  const branding = panel(page).locator('.signoff-branding');
  await branding.locator('summary').click();
  await branding.getByLabel('Agency name').fill('Northline Books');
  await branding.getByLabel('Prepared for').fill('Harbor & Field');
  await branding.getByLabel('Contact email or note').fill(brandNote);
  await branding.getByRole('radio', { name: 'Navy' }).check();
  await branding.locator('summary').click();
  await button(page, demo).click();
  await ready(page);
  await expect(page.getByTestId('categorization-coverage')).toHaveText('80%');
  await expect(page.getByTestId('categorization-uncategorized')).toHaveText('1');
  await expect(page.getByTestId('categorization-ambiguous')).toHaveText('0');
  await expect(panel(page).getByText('4 of 5 transactions categorized')).toBeVisible();
  await expect(panel(page).getByRole('progressbar')).toHaveAttribute('value', '0.8');
  const taxes = page.getByTestId('categorization-tax-totals');
  for (const [currency, amount] of [['AED', '-5.00'], ['GBP', '-18.00'], ['USD', '0.00']]) {
    await expect(taxes.locator('div').filter({ has: page.getByText(currency, { exact: true }) }).locator('dd')).toHaveText(amount);
  }
  const review = panel(page).getByRole('region', { name: 'Categorization review' });
  const table = review.getByRole('table', { name: 'Account Summary Preview' });
  await expect(table.locator('tbody tr')).toHaveCount(4);
  const size = await exerciseTable(page, review.getByRole('region', { name: 'Scrollable account summary' }));
  const list = panel(page).getByRole('list', { name: 'Rule priority order' });
  const priority = await list.getByRole('listitem').allTextContents();
  for (const name of ['Move AWS UK cloud services up', 'Move Shopify subscription down']) {
    const endpoint = panel(page).getByRole('button', { name, exact: true });
    await expect(endpoint).toBeDisabled();
    await endpoint.focus();
    await page.keyboard.press('Enter');
    await expect(endpoint).toBeFocused();
    expect(await list.getByRole('listitem').allTextContents()).toEqual(priority);
  }
  const access = await auditPage(page, 'workbench');
  await photograph(page, info.project.name === 'mobile' ? 'mobile-m23-categorization' : 'desktop-m23-categorization-rules',
    info.project.name === 'mobile' ? review : panel(page).getByRole('heading', { name: 'Bookkeeper rule pack' }));
  const stage = 'm23-demo';
  const transactions = await save(page, info, transactionsLabel, transactionName, stage);
  const summary = await save(page, info, summaryLabel, 'account-summary.csv', stage);
  const html = await save(page, info, htmlLabel, htmlName, stage);
  const audit = JSON.parse((await save(page, info, auditLabel, auditName, stage)).text);
  const dir = dirname(html.path);
  const source = await original(dir, 'transactions.csv', await readFile(fixture('transactions.csv')));
  const rules = await original(dir, 'rules.json', await readFile(fixture('rules.json')));
  const outputs = await Promise.all([transactions, summary, html].map(async f => fingerprint(basename(f.path), await readFile(f.path))));
  expect(audit.custody).toEqual({ source, rulePack: rules, outputs });
  const matrix = parseCsv(transactions.text);
  const src = parseCsv(await readFile(fixture('transactions.csv'), 'utf8'));
  expect(matrix.map(row => row.slice(0, 5))).toEqual(src);
  expect(matrix[0].slice(5)).toEqual(['Account Code', 'Account Name', 'Tax Code', 'Calculated Net', 'Calculated Tax', 'Matched Rule']);
  expect(matrix.slice(1).map(row => row.slice(5))).toEqual([
    ['6100', 'Cloud services', 'UK-VAT20', '-100.00', '-20.00', 'aws-uk'],
    ['6100', 'Cloud services', 'UAE-VAT5', '-100.00', '-5.00', 'aws-uae'],
    ['6100', 'Cloud services', 'UK-VAT20', '10.00', '2.00', 'aws-uk'],
    ['6200', 'Software subscriptions', 'NO-TAX', '-24.00', '0.00', 'shopify'],
    ['', '', '', '-4.50', '0.00', ''],
  ]);
  const cents = (s: string) => BigInt(s.replace('.', ''));
  const totals = new Map<string, bigint[]>();
  const grouped = new Map<string, bigint[]>();
  function add(map: Map<string, bigint[]>, key: string, values: bigint[]) {
    const sum = map.get(key) ?? [0n, 0n, 0n, 0n];
    map.set(key, sum.map((v, i) => v + values[i]));
  }
  for (const row of matrix.slice(1)) {
    const gross = cents(row[3]), net = cents(row[8]), tax = cents(row[9]);
    expect(net + tax).toBe(gross);
    add(totals, row[4], [1n, gross, net, tax]);
    add(grouped, JSON.stringify([row[4], row[5], row[7]]), [1n, gross, net, tax]);
  }
  const [headers, ...groups] = parseCsv(summary.text);
  expect(headers).toEqual(['Currency', 'Account Code', 'Account Name', 'Tax Code', 'Transaction Count', 'Gross', 'Calculated Net', 'Calculated Tax']);
  expect(groups).toHaveLength(grouped.size);
  for (const row of groups) {
    const key = JSON.stringify([row[0], row[1], row[3]]);
    expect([BigInt(row[4]), ...row.slice(5).map(cents)]).toEqual(grouped.get(key));
    grouped.delete(key);
  }
  expect(grouped.size).toBe(0);
  expect(Object.fromEntries(totals)).toEqual({ GBP: [3n, -11250n, -9450n, -1800n], AED: [1n, -10500n, -10000n, -500n], USD: [1n, -2400n, -2400n, 0n] });
  expect(audit.metrics).toEqual({ totalRows: 5, categorizedRows: 4, uncategorizedRows: 1, ambiguousConflicts: 0 });

  expect(html.text).not.toMatch(/<script\b|<ledger-note\b|https?:|\/\//i);
  expect(html.text).toContain('&lt;ledger-note&gt;');
  const report = await page.context().newPage();
  await page.context().setOffline(true);
  await report.goto(pathToFileURL(html.path).href);
  expect(new URL(report.url()).protocol).toBe('file:');
  await expect(report.getByRole('heading', { name: 'Bookkeeper Categorization Sign-Off' })).toBeVisible();
  await expect(report.getByRole('main')).toBeVisible();
  const brand = report.getByRole('complementary', { name: 'Agency branding' });
  await expect(brand.locator('div')).toHaveText(['Prepared by Northline Books', 'Prepared for Harbor & Field', brandNote]);
  await expect(brand).toHaveCSS('background-color', 'rgb(26, 54, 93)');
  await expect(report.locator('script,[src],[srcset],[href],base,form,object,embed,iframe,ledger-note')).toHaveCount(0);
  expect(await report.locator('*').evaluateAll(els => els.flatMap(el => el.getAttributeNames().filter(n => /^on/i.test(n))))).toEqual([]);
  await expect(report.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content',
    "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  await expect(report.locator('footer code')).toHaveText([source.sha256, rules.sha256, ...outputs.slice(0, 2).map(x => x.sha256)]);
  const scrollSizes = [];
  for (const section of await report.locator('main section').all()) scrollSizes.push(await exerciseTable(report, section.getByRole('region')));
  if (info.project.name === 'desktop') await photograph(report, 'desktop-m23-categorization-signoff', brand);
  await report.close();
  await page.context().setOffline(false);
  info.annotations.push({ type: 'm23-demo', description: JSON.stringify({ version: page.context().browser()?.version(), viewport: page.viewportSize(), size, scrollSizes, access, custody: audit.custody, totals: audit.currencyTotals }) });
});

test('Uploaded rule pack round-trips original bytes, holds the conflicting physical line and obeys reordered explicit priority', async ({ page, beginProcessing }, info) => {
  await open(page, beginProcessing);
  const p = panel(page);
  await p.getByLabel('Choose Categorization CSV').setInputFiles(fixture('transactions.csv'));
  const packInput = p.getByLabel('Load Rule Pack (.json)');
  await packInput.setInputFiles(fixture('conflict-rules.json'));
  const first = await heldAudit(page, info, 'm23-conflict');
  const ruleBytes = await readFile(fixture('conflict-rules.json'));
  const sourceBytes = await readFile(fixture('transactions.csv'));
  expect(first.data.custody).toEqual({ rulePack: await original(first.dir, 'conflict-rules.json', ruleBytes), source: await original(first.dir, 'transactions.csv', sourceBytes) });
  const issues = p.getByRole('list', { name: 'Categorization issues' });
  await expect(issues).toContainText('Line 2');
  await expect(issues).toContainText('aws-uk, aws-overlap');
  await expect(page.getByTestId('categorization-ambiguous')).toHaveText('1');
  expect(first.data.issues).toMatchObject([{ line: 2, code: 'ambiguous-rule-match', matchingRuleIds: ['aws-uk', 'aws-overlap'] }]);
  const pack = await save(page, info, ruleLabel, ruleName, 'm23-conflict');
  expect(await readFile(pack.path)).toEqual(ruleBytes);
  await packInput.setInputFiles(pack.path);
  await expect(p.locator('[data-custody-field="categorization-rule-pack"]')).toHaveText(first.data.custody.rulePack.sha256);
  await expect(p.getByText('Rule pack loaded · ' + ruleName)).toBeVisible();
  const again = await heldAudit(page, info, 'm23-reloaded');
  expect(again.data.custody.rulePack).toEqual(fingerprint(ruleName, ruleBytes));
  const resave = await save(page, info, ruleLabel, ruleName, 'm23-reloaded');
  expect(await readFile(resave.path)).toEqual(ruleBytes);
  await p.getByLabel('Conflict policy').selectOption('first-match-wins');
  await ready(page);
  const priority = await save(page, info, transactionsLabel, transactionName, 'm23-first');
  expect(parseCsv(priority.text)[1].slice(7)).toEqual(['UK-VAT20', '-100.00', '-20.00', 'aws-uk']);
  const up = p.getByRole('button', { name: 'Move Alternative AWS treatment up' });
  await up.focus();
  await up.press('Enter');
  await expect(up).toBeFocused();
  await expect(p.getByRole('list', { name: 'Rule priority order' }).getByRole('listitem').first()).toContainText('Alternative AWS treatment');
  await ready(page);
  const reordered = await save(page, info, transactionsLabel, transactionName, 'm23-reordered');
  expect(parseCsv(reordered.text)[1].slice(7)).toEqual(['NO-TAX', '-120.00', '0.00', 'aws-overlap']);
  const edited = await save(page, info, ruleLabel, ruleName, 'm23-reordered');
  const audit = JSON.parse((await save(page, info, auditLabel, auditName, 'm23-reordered')).text);
  expect(audit.custody.rulePack).toEqual(fingerprint(ruleName, await readFile(edited.path)));
  info.annotations.push({ type: 'm23-priority', description: JSON.stringify({ issues: first.data.issues, original: first.data.custody, edited: audit.custody.rulePack }) });
});

test('Current repair source keeps its bytes, literal editor rules preserve case-insensitive matches and a high-value hold identifies line four', async ({ page, beginProcessing }, info) => {
  await open(page, beginProcessing);
  const p = panel(page);
  const source = csv('source-with-note.csv', [
    ['Date', 'Description', 'Amount'],
    ['11/21/2026', '  aWs.[EU] <vendor-note>\r\nCloud  ', '-105.00'],
    ['11/22/2026', 'AWSxE unmatched', '-50.01'],
  ]);
  await page.getByLabel('Date format', { exact: true }).selectOption('MDY');
  await page.getByLabel('Choose CSV file', { exact: true }).setInputFiles(source);
  await button(page, 'Use Current Source CSV').click();
  await expect(page.getByTestId('categorization-source-file')).toContainText(source.name);
  await p.getByLabel('Source currency (if CSV has none)').fill('AED');
  await button(page, 'Add Rule').click();
  for (const [label, value] of [
    ['Rule ID', 'literal-aws'], ['Rule label', 'Literal vendor'],
    ['Description / Payee pattern', 'AWS.[eu]'], ['Account code', '6100'], ['Account name', 'Cloud books'],
    ['Tax code', 'UAE-VAT5'], ['Inclusive tax rate (bps)', '500'],
  ]) await p.getByLabel(label, { exact: true }).fill(value);
  await button(page, 'Save Rule').click();
  await expect(page.getByTestId('categorization-coverage')).toHaveText('50%');
  const stage = 'm23-literal';
  const result = await save(page, info, transactionsLabel, transactionName, stage);
  const rows = parseCsv(result.text);
  expect(rows[1].slice(-3)).toEqual(['-100.00', '-5.00', 'literal-aws']);
  expect(rows[2].slice(-3)).toEqual(['-50.01', '0.00', '']);
  const html = await save(page, info, htmlLabel, htmlName, stage);
  expect(html.text).toContain('&lt;vendor-note&gt;');
  expect(html.text).not.toContain('<vendor-note>');
  const hash = await original(dirname(html.path), source.name, source.buffer);
  const full = JSON.parse((await save(page, info, auditLabel, auditName, stage)).text);
  expect(full.custody.source).toEqual(hash);
  await p.getByLabel('Unmapped review threshold (cents)').fill('5001');
  await ready(page);
  await p.getByLabel('Unmapped review threshold (cents)').fill('5000');
  await expect(p.getByRole('list', { name: 'Categorization issues' })).toContainText('Line 4');
  const held = await heldAudit(page, info, 'm23-threshold');
  expect(held.data.issues).toMatchObject([{ code: 'unmapped-high-value', line: 4 }]);
  expect(held.data.custody.source).toEqual(hash);
  info.annotations.push({ type: 'm23-threshold', description: JSON.stringify({ issue: held.data.issues, custody: held.data.custody }) });
});
