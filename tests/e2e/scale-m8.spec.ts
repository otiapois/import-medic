import assert from 'node:assert/strict';
import { expect, type Page } from '@playwright/test';
import Papa from 'papaparse';
import { assertFits, test } from './browser';
import { button, field, openStudio, save } from './m7-files';
import type { WorkerReply } from '../../src/core/worker/protocol';

const count = 50_000;
const sku = (index: number) => 'SKU-' + String(index).padStart(6, '0');
const file = (name: string, lines: string[]) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n')) });
declare global {
  interface Window { m8ComparisonStages: number[] }
}

// Include every rAF gap from before the real input through the paint after its final rows.
async function rawFrames(page: Page, action: () => Promise<void>) {
  const probe = await page.evaluateHandle(async () => {
    const deltas: number[] = [];
    let prior = await new Promise<number>(resolve => requestAnimationFrame(resolve));
    let id = 0;
    const sample = (now: number) => {
      deltas.push(now - prior);
      prior = now;
      id = requestAnimationFrame(sample);
    };
    id = requestAnimationFrame(sample);
    return async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      cancelAnimationFrame(id);
      return deltas;
    };
  });
  await action();
  const samples = await probe.evaluate(stop => stop());
  await probe.dispose();
  return { max: Math.max(...samples), samples };
}

test('50,000 actual variants cancel, restart, search and page within frame budget, and export a complete bounded CSV audit', async ({ page, beginProcessing }, info) => {
  test.setTimeout(150_000);
  const base = ['Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price'];
  const prices = ['SKU,New Price'];
  for (let index = 1; index <= count; index++) {
    base.push('item-' + index + ',Item ' + index + ',Title,Default Title,' + sku(index) + ',100.00');
    prices.push(sku(index) + ',110.00');
  }
  await page.addInitScript(() => {
    window.m8ComparisonStages = [];
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
          if (event.data.kind === 'progress' && event.data.progress.phase === 'comparing') window.m8ComparisonStages.push(event.data.progress.percent);
        });
      }
    };
  });
  await openStudio(page, beginProcessing);
  const downloads: string[] = [];
  page.on('download', item => downloads.push(item.suggestedFilename()));
  await field(page, 'Choose Shopify baseline CSV').setInputFiles(file('scale.csv', base));
  await field(page, 'Choose supplier price sheet').setInputFiles(file('quotes.csv', prices));
  await page.waitForFunction(() => window.m8ComparisonStages.some(p => p > 5 && p < 90), null, { timeout: 60_000 });
  const original = page.workers().find(worker => worker.url().includes('/assets/diff.worker-'));
  assert.ok(original);
  const closed = original.waitForEvent('close');
  await button(page, 'Cancel').click();
  await closed;
  await expect(page.getByRole('status').filter({ hasText: 'Processing canceled.' })).toBeVisible();
  const auditButton = 'Download Full Diff Audit (.csv)';
  await expect(page.locator('button:enabled').filter({ hasText: auditButton })).toHaveCount(0);
  expect(downloads).toEqual([]);
  await page.evaluate(() => { window.m8ComparisonStages.length = 0; });
  const started = Date.now();
  await button(page, 'Resume').click();
  const rows = page.getByRole('table', { name: 'Shopify price diff' }).locator('tbody tr');
  const pager = page.getByRole('navigation', { name: 'Pagination' });
  await expect(pager).toContainText('1–10 of 50,000', { timeout: 90_000 });
  await expect(rows).toHaveCount(10);
  const readyMs = Date.now() - started;
  expect(page.workers().some(worker => worker !== original && worker.url() === original.url())).toBe(true);
  expect(downloads).toEqual([]);
  const stages = await page.evaluate(() => window.m8ComparisonStages);
  expect(stages.at(-1)).toBe(100);
  expect(new Set(stages.filter(value => value > 5 && value < 91)).size).toBeGreaterThanOrEqual(8);
  await expect(page.getByRole('listitem', { name: '+5% to +20%: 50,000', exact: true })).toBeVisible();
  await pager.scrollIntoViewIfNeeded();
  const paging = await rawFrames(page, async () => {
    await pager.getByRole('button', { name: 'Next page' }).click();
    await expect(pager).toContainText('11–20 of 50,000');
    await expect(rows.first()).toContainText(sku(11));
    await expect(rows.last()).toContainText(sku(20));
  });
  const box = page.getByRole('searchbox');
  await box.scrollIntoViewIfNeeded();
  const search = await rawFrames(page, async () => {
    await box.fill(sku(count));
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(sku(count));
    await expect(rows.first()).toContainText('110.00');
  });
  await assertFits(page);
  const receipt = { viewport: page.viewportSize(), width: await page.evaluate(() => document.documentElement.scrollWidth),
    variants: count, readyMs, stages, paging, search };
  info.annotations.push({ type: 'm8-scale', description: JSON.stringify(receipt) });
  expect(paging.samples.length).toBeGreaterThan(1);
  expect(search.samples.length).toBeGreaterThan(1);
  expect(paging.max, 'Maximum paging frame delta in ms').toBeLessThanOrEqual(34);
  expect(search.max, 'Maximum search frame delta in ms').toBeLessThanOrEqual(34);

  const audit = await save(page, info, auditButton, 'scale-price-diff.audit.csv', 'm8-full-audit');
  const bytes = Buffer.byteLength(audit.text);
  expect(bytes).toBeLessThan(count * 1400);
  let headers: string[] = [];
  let variant = 0;
  let summaries = 0;
  Papa.parse<string[]>(audit.text, { delimiter: ',', skipEmptyLines: true, step({ data, errors }) {
    assert.equal(errors.length, 0);
    if (!headers.length) {
      headers = data;
      assert.equal(headers.at(-1), 'Review and Resolution (JSON)');
      return;
    }
    assert.equal(data.length, headers.length);
    const tail = JSON.parse(data.at(-1)!);
    if (data[0] === 'Run summary') {
      summaries++;
      return;
    }
    variant++;
    assert.equal(data[0], 'Updated');
    assert.equal(data[headers.indexOf('SKU')], sku(variant));
    assert.equal(data[headers.indexOf('Baseline Row')], String(variant + 1));
    assert.equal(data[headers.indexOf('Supplier Row')], String(variant + 1));
    assert.equal(data[headers.indexOf('Old Price')], '100.00');
    assert.equal(data[headers.indexOf('New Price')], '110.00');
    assert.deepEqual(tail.issues, []);
  }});
  expect([summaries, variant]).toEqual([1, count]);
  info.annotations.push({ type: 'm8-audit', description: JSON.stringify({ bytes, rows: variant, summaries, lastColumn: headers.at(-1) }) });
  const active = page.workers().find(worker => worker.url() === original.url())!;
  const reset = active.waitForEvent('close');
  await button(page, 'WooCommerce').click();
  await button(page, 'Switch to WooCommerce').click();
  await reset;
  await expect(field(page, 'Choose WooCommerce baseline CSV')).toHaveValue('');
  await expect(page.getByRole('region', { name: 'Batch Impact & Margin Summary' })).toHaveCount(0);
  await expect(page.locator('button:enabled').filter({ hasText: auditButton })).toHaveCount(0);
  expect(downloads).toEqual(['scale-price-diff.audit.csv']);
});
