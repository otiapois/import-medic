import { expect, it, vi } from 'vitest';
import { parseCsv } from '../../../src/core/csv';
import { WorkbenchWorker } from '../../../src/core/worker/client';
import type { WorkerMessage, WorkerProgress, WorkerReply, WorkerRequest, WorkerResult } from '../../../src/core/worker/protocol';

it('runs a genuine 50,000-variant worker comparison, bounded audits, cached search and stale export rejection', async () => {
  vi.stubGlobal('onmessage', null);
  const pending = new Map<number, { reply: (response: WorkerReply) => void; progress?: (value: WorkerProgress) => void }>();
  vi.stubGlobal('postMessage', (reply: WorkerReply, transfer?: Transferable[]) => {
    const entry = pending.get(reply.id)!;
    if (reply.kind === 'progress') entry.progress?.(reply.progress);
    else {
      pending.delete(reply.id);
      entry.reply(structuredClone(reply, { transfer }));
    }
  });

  try {
    await import('../../../src/core/worker/diff.worker');
    const dispatch = globalThis.onmessage as unknown as (event: MessageEvent<WorkerMessage>) => void;
    let id = 0;
    function send(request: WorkerRequest, progress?: (value: WorkerProgress) => void) {
      const task = ++id;
      return new Promise<WorkerReply>((reply) => {
        pending.set(task, { reply, progress });
        dispatch({ data: { id: task, request } } as MessageEvent<WorkerMessage>);
      });
    }
    async function run<R extends WorkerRequest>(request: R, progress?: (value: WorkerProgress) => void): Promise<WorkerResult<R>> {
      const reply = await send(request, progress);
      if (reply.kind === 'error') throw new Error(reply.message);
      if (reply.kind !== 'result') throw new Error('Worker request must finish before resolving');
      return reply.value as WorkerResult<R>;
    }
    const baseline = ['Handle,Title,Variant SKU,Variant Price,Option1 Name,Option1 Value,Unmodified'];
    const supplier = ['SKU,Cost'];
    for (let index = 1; index <= 50_000; index++) {
      const suffix = index.toString().padStart(5, '0');
      baseline.push(`product-${suffix},Product ${suffix},SKU-${suffix},200.00,Title,Default Title,Original ${suffix}`);
      supplier.push(`SKU-${suffix},${index % 2 === 0 ? '110.00' : '100.00'}`);
    }
    const started = performance.now();
    const [baseMeta, supplierMeta] = await Promise.all([
      run({ type: 'loadBaseline', file: new File([baseline.join('\n')], 'large-store.csv') }),
      run({ type: 'loadSupplier', file: new File([supplier.join('\n')], 'large-supplier.csv') }),
    ]);
    expect(baseMeta.rowCount).toBe(50_000);
    expect(supplierMeta.sheets[0].rowCount).toBe(50_000);
    const comparison = { type: 'diffBatch', suppliers: [{ supplierId: 'primary', sheetIndex: 0, selection: {
      confirmed: true, pricingRule: { mode: 'multiplier', multiplier: '2' },
    }, resolutions: {} }] } as const;
    const updates: WorkerProgress[] = [];
    const summary = await run(comparison, (progress) => updates.push(progress));
    const compareMs = Math.round(performance.now() - started);
    expect(summary.counts).toMatchObject({ all: 50_000, updated: 25_000, unchanged: 25_000 });
    expect(summary.analytics.histogram.map(({ count }) => count)).toEqual([0, 0, 0, 25_000, 0, 25_000, 0]);
    expect(summary.analytics.margin).toEqual({ count: 50_000, averagePercent: '50.00', lowestPercent: '50.00', highestPercent: '50.00', watchlistCount: 0 });
    expect(summary.verification).toEqual({ checked: true, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 });
    expect(summary.rollbackVerification).toEqual({ checked: true, restoredVariants: 25_000 });
    expect(JSON.stringify(summary).length).toBeLessThan(3_000);
    expect(updates.filter(({ phase, percent }) => phase === 'comparing' && percent > 15 && percent < 70).length).toBeGreaterThan(20);
    expect(updates.filter(({ phase, percent }) => phase === 'exporting' && percent > 75 && percent < 90).length).toBeGreaterThan(10);
    expect(updates.filter(({ percent }) => percent > 91 && percent < 100).length).toBeGreaterThan(4);
    expect(updates.at(-1)).toEqual({ phase: 'comparing', percent: 100 });
    expect(updates.every(({ percent }, index) => index === 0 || percent >= updates[index - 1].percent)).toBe(true);

    const paged = { type: 'diffRows', filter: 'all', search: 'sku-499', pageSize: 10 } as const;
    const first = await run({ ...paged, page: 0 });
    const last = await run({ ...paged, page: 9 });
    expect(first).toMatchObject({ page: 0, total: 100 });
    expect(first.rows[0]?.sku).toBe('SKU-49900');
    expect(last.rows.at(-1)?.sku).toBe('SKU-49999');
    const capped = await run({ type: 'diffRows', filter: 'all', search: '', page: 499, pageSize: 2000 });
    expect(capped.rows).toHaveLength(100);
    expect(capped.rows.at(-1)?.sku).toBe('SKU-50000');

    const auditing = performance.now();
    const json = await run({ type: 'download', format: 'price-audit-json' });
    const csv = await run({ type: 'download', format: 'price-audit-csv' });
    const auditMs = Math.round(performance.now() - auditing);
    expect(json.bytes.byteLength).toBeLessThan(80_000_000);
    expect(csv.bytes.byteLength).toBeLessThan(40_000_000);
    const report = JSON.parse(new TextDecoder().decode(json.bytes));
    expect(report.rows).toHaveLength(50_000);
    expect(report.rows.at(-1)).toMatchObject({ sku: 'SKU-50000', landedCost: '110.00', baselineCells: expect.arrayContaining([expect.objectContaining({ value: 'Original 50000' })]) });
    const parsed = parseCsv(new TextDecoder().decode(csv.bytes)).records;
    expect(parsed).toHaveLength(50_002);
    expect(parsed[0].cells.at(-1)).toBe('Review and Resolution (JSON)');
    expect(parsed.at(-1)?.cells[1]).toBe('SKU-50000');
    expect(parsed.at(-1)?.cells.at(-1)).toBe('{"issues":[],"resolution":null}');

    const [inspectHead, ...inspectRows] = baseline.slice(0, 206).map((line) => line.split(',').slice(0, 6));
    const inspectedBaseline = new File([[inspectHead, ...inspectRows].map((row) => row.join(',')).join('\n')], 'baseline.csv');
    const editedRows = inspectRows.map((row) => row.map((cell, column) => column === 3 ? '210.50' : cell));
    const candidate = new File([[inspectHead, ...editedRows].map((row) => row.join(',')).join('\n')], 'update.csv');
    const startedInspection = performance.now();
    const inspection = await run({ type: 'inspectImport', platform: 'shopify', baseline: inspectedBaseline, candidate });
    expect(inspection).toMatchObject({ verdict: 'PASS', matchedRows: 205, changedRows: 205, rowCount: 205, issueCount: 0 });
    expect(inspection).not.toHaveProperty('rows');
    expect(inspection).not.toHaveProperty('issues');
    expect(JSON.stringify(inspection).length).toBeLessThan(1_000);
    const changes = await run({ type: 'inspectionRows', page: 1, pageSize: 500 });
    expect(changes).toMatchObject({ page: 1, total: 205 });
    expect(changes.rows).toHaveLength(100);
    expect(changes.rows[0]).toMatchObject({ sku: 'SKU-00101',
      changes: [{ column: 'Variant Price', before: '200.00', after: '210.50', delta: '10.5' }] });

    const stalePage = send({ type: 'inspectionRows', page: 0, pageSize: 100 });
    const badHeaders = [...inspectHead, ...Array.from({ length: 101 }, (_, index) => 'Meta:' + index)];
    const tampered = new File([[badHeaders.join(','), editedRows[0].join(',') + ','.repeat(101)].join('\n')], 'tampered.csv');
    const badResult = run({ type: 'inspectImport', platform: 'shopify', baseline: inspectedBaseline, candidate: tampered });
    expect(await stalePage).toMatchObject({ kind: 'error', message: 'The local result was replaced before the request finished.' });
    expect(await badResult).toMatchObject({ verdict: 'FAIL_UNSAFE', issueCount: 101, nonTargetMutations: 101 });
    expect((await run({ type: 'inspectionIssues', page: 0, pageSize: 1000 })).rows).toHaveLength(100);
    expect(await run({ type: 'inspectionIssues', page: 100, pageSize: 1000 })).toMatchObject({ page: 1, total: 101,
      rows: [expect.objectContaining({ source: 'candidate', column: 'Meta:100', code: 'forbidden-column' })] });
    expect(await run({ ...paged, page: 0 })).toEqual(first);
    console.info(`205-variant inspection and bounded worker transport: ${Math.round(performance.now() - startedInspection)}ms.`);

    let invalidation: Promise<WorkerReply> | undefined;
    const obsolete = await send({ type: 'download', format: 'price-audit-json' }, ({ percent }) => {
      if (percent === 90) invalidation = send({ type: 'invalidatePrice' });
    });
    expect(obsolete).toMatchObject({ kind: 'error', message: 'The local result was replaced before the request finished.' });
    expect(await invalidation).toMatchObject({ kind: 'result' });
    expect(await send({ type: 'download', format: 'price-csv' })).toMatchObject({ kind: 'error' });

    const superseded = await send(comparison, ({ percent }) => {
      if (percent === 91) invalidation = send({ type: 'invalidatePrice' });
    });
    expect(superseded).toMatchObject({ kind: 'error', message: 'The local result was replaced before the request finished.' });
    expect(await invalidation).toMatchObject({ kind: 'result' });
    expect(await send({ ...paged, page: 0 })).toMatchObject({ kind: 'error' });
    console.info(`50,000-variant worker benchmark: upload + compare ${compareMs}ms; both audits ${auditMs}ms; JSON ${json.bytes.byteLength} bytes, CSV ${csv.bytes.byteLength} bytes; ${updates.length} progress events.`);
  } finally {
    vi.unstubAllGlobals();
  }
}, 45_000);

it('rejects pending exports immediately and ignores their replies on reset or invalidation', async () => {
  const post = vi.fn();
  const terminate = vi.fn();
  let fake: { onmessage?: (event: { data: WorkerReply }) => void } | undefined;
  vi.stubGlobal('Worker', class {
    onmessage?: (event: { data: WorkerReply }) => void;
    postMessage = post;
    terminate = terminate;
    constructor() { fake = this; }
  });
  try {
    const worker = new WorkbenchWorker();
    const progress = vi.fn();
    const first = worker.request({ type: 'download', format: 'price-audit-csv' }, progress);
    const invalidation = worker.request({ type: 'invalidatePrice' });
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    fake?.onmessage?.({ data: { id: 1, kind: 'progress', progress: { phase: 'exporting', percent: 95 } } });
    fake?.onmessage?.({ data: { id: 2, kind: 'result', value: undefined } });
    await invalidation;
    expect(progress).not.toHaveBeenCalled();
    const reset = worker.request({ type: 'download', format: 'repair-bookkeeper-html' }, progress);
    worker.terminate();
    await expect(reset).rejects.toMatchObject({ name: 'AbortError' });
    await expect(worker.request({ type: 'repairRows', page: 0, pageSize: 10 })).rejects.toMatchObject({ name: 'AbortError' });
    expect(terminate).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllGlobals();
  }
});
