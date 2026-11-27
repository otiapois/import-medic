import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { parseCsv } from '../../../src/core/csv';
import type { WorkerMessage, WorkerReply, WorkerRequest, WorkerResult } from '../../../src/core/worker/protocol';

const digest = (bytes: ArrayBuffer | Uint8Array) => createHash('sha256').update(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).digest('hex');
const contents = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);
const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/shopify-price-diff/${name}`, import.meta.url));

it('ties worker artifacts to exact selected bytes, workbook order, same-name replacements and current runs', async () => {
  let id = 0;
  const pending = new Map<number, (reply: WorkerReply) => void>();
  vi.stubGlobal('onmessage', null);
  vi.stubGlobal('postMessage', (reply: WorkerReply, transfer?: Transferable[]) => {
    if (reply.kind === 'progress') return;
    pending.get(reply.id)!(structuredClone(reply, { transfer }));
    pending.delete(reply.id);
  });
  try {
    await import('../../../src/core/worker/diff.worker');
    const dispatch = globalThis.onmessage as unknown as (event: MessageEvent<WorkerMessage>) => void;
    async function run<R extends WorkerRequest>(request: R): Promise<WorkerResult<R>> {
      const task = ++id;
      const reply = await new Promise<WorkerReply>((resolve) => {
        pending.set(task, resolve);
        dispatch({ data: { id: task, request } } as MessageEvent<WorkerMessage>);
      });
      if (reply.kind !== 'result') throw new Error(reply.kind === 'error' ? reply.message : 'Missing worker result');
      return reply.value as WorkerResult<R>;
    }
    const base = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture('baseline-agency.csv')]);
    const workbook = fixture('supplier-agency.xlsx');
    const older = Buffer.from('SKU,Price\r\n00123,65.00', 'utf8');
    const newer = Buffer.from('SKU,Price\n00123,67.00', 'utf8');
    await run({ type: 'loadBaseline', file: new File([base], 'store.csv') });
    await run({ type: 'loadSupplier', file: new File([older], 'same.csv'), supplierId: 'csv' });
    await run({ type: 'loadSupplier', file: new File([workbook], 'supplier.xlsx'), supplierId: 'book' });
    await run({ type: 'loadSupplier', file: new File(['SKU,Price\nP-02,3'], 'inert.csv'), supplierId: 'inactive' });
    await run({ type: 'loadSupplier', file: new File([newer], 'same.csv'), supplierId: 'csv' });
    const settings = { confirmed: true };
    const ready = await run({ type: 'diff', supplierId: 'csv', sheetIndex: 0, selection: settings, resolutions: {} });
    expect(ready.canDownload).toBe(true);
    const update = await run({ type: 'download', format: 'price-csv' });
    const rollback = await run({ type: 'download', format: 'price-rollback-csv' });
    const expected = { baselineSha256: digest(base), suppliers: [{ filename: 'same.csv', bytes: newer.length, sha256: digest(newer) }],
      updateCsvSha256: digest(update.bytes), rollbackCsvSha256: digest(rollback.bytes) };
    expect(ready.custody).toEqual(expected);
    expect(JSON.parse(contents((await run({ type: 'download', format: 'price-audit-json' })).bytes)).custody).toEqual(expected);
    const html = contents((await run({ type: 'download', format: 'price-signoff-html' })).bytes);
    for (const { sha256 } of expected.suppliers) expect(html).toContain(sha256);
    for (const fingerprint of [expected.baselineSha256, expected.updateCsvSha256, expected.rollbackCsvSha256]) expect(html).toContain(fingerprint);
    const priceAuditCsv = parseCsv(contents((await run({ type: 'download', format: 'price-audit-csv' })).bytes));
    expect(priceAuditCsv.records[0].cells.at(-1)).toBe('Review and Resolution (JSON)');

    const batch = await run({ type: 'diffBatch', suppliers: [
      { supplierId: 'book', sheetIndex: 1, selection: { confirmed: false }, resolutions: {} },
      { supplierId: 'csv', sheetIndex: 0, selection: settings, resolutions: {} },
    ] });
    expect(batch.canDownload).toBe(false);
    const blocked = { baselineSha256: digest(base), suppliers: [{ filename: 'supplier.xlsx', bytes: workbook.length, sha256: digest(workbook) },
      ...expected.suppliers] };
    expect(batch.custody).toEqual(blocked);
    expect(JSON.parse(contents((await run({ type: 'download', format: 'price-audit-json' })).bytes)).custody).toEqual(blocked);

    const equivalent = Buffer.from('SKU,Price\r\n00123,67', 'utf8');
    await run({ type: 'loadSupplier', file: new File([equivalent], 'equivalent.csv'), supplierId: 'equivalent' });
    const preferredBatch = { type: 'diffBatch', conflictPolicy: 'prefer-last', suppliers: [
      { supplierId: 'csv', sheetIndex: 0, selection: settings, resolutions: {} },
      { supplierId: 'equivalent', sheetIndex: 0, selection: settings, resolutions: {} },
    ] } as const;
    const unconfirmed = await run({ ...preferredBatch, conflictPolicyConfirmed: false });
    const sourcesOnly = { baselineSha256: digest(base), suppliers: [...expected.suppliers,
      { filename: 'equivalent.csv', bytes: equivalent.length, sha256: digest(equivalent) }] };
    expect(unconfirmed).toMatchObject({ canDownload: false, overlapCount: 1, conflictCount: 0, mappingBlocked: false });
    expect(unconfirmed.custody).toEqual(sourcesOnly);
    const pendingAudit = JSON.parse(contents((await run({ type: 'download', format: 'price-audit-json' })).bytes));
    expect(pendingAudit.custody).toEqual(sourcesOnly);
    expect(pendingAudit.issues).toContainEqual(expect.objectContaining({ source: 'supplier', code: 'supplier-conflict-confirmation-required' }));
    const pendingHtml = contents((await run({ type: 'download', format: 'price-signoff-html' })).bytes);
    for (const { sha256 } of sourcesOnly.suppliers) expect(pendingHtml).toContain(sha256);
    expect(pendingHtml).not.toMatch(/<dt>(?:Update|Rollback) CSV<\/dt>/);
    await expect(run({ type: 'download', format: 'price-csv' })).rejects.toThrow('blocked');
    await expect(run({ type: 'download', format: 'price-rollback-csv' })).rejects.toThrow('blocked');
    const confirmed = await run({ ...preferredBatch, conflictPolicyConfirmed: true });
    expect(confirmed).toMatchObject({ canDownload: true, custody: sourcesOnly });
    expect(confirmed.custody.updateCsvSha256).toBe(digest((await run({ type: 'download', format: 'price-csv' })).bytes));
    expect(confirmed.custody.rollbackCsvSha256).toBe(digest((await run({ type: 'download', format: 'price-rollback-csv' })).bytes));

    const source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Date,Description,Amount\n2026-11-24,+Client,11.01')]);
    await run({ type: 'loadRepair', file: new File([source], 'repair.csv') });
    const repaired = await run({ type: 'repair', platform: 'quickbooks-bank', options: { formulaGuard: true }, edits: [] });
    const repairedCsv = await run({ type: 'download', format: 'repair-csv' });
    expect(contents(repairedCsv.bytes)).toContain("'+Client");
    const repairCustody = { sourceSha256: digest(source), repairedCsvSha256: digest(repairedCsv.bytes) };
    expect(repaired.custody).toEqual(repairCustody);
    expect(JSON.parse(contents((await run({ type: 'download', format: 'repair-audit-json' })).bytes)).custody).toEqual(repairCustody);
    const bookkeeper = contents((await run({ type: 'download', format: 'repair-bookkeeper-html' })).bytes);
    expect(bookkeeper).toContain(repairCustody.sourceSha256);
    expect(bookkeeper).toContain(repairCustody.repairedCsvSha256);
    const held = await run({ type: 'repair', platform: 'stripe-paypal', options: {}, edits: [] });
    expect(held.custody).toEqual({ sourceSha256: digest(source) });
    expect(contents((await run({ type: 'download', format: 'repair-bookkeeper-html' })).bytes)).not.toContain(repairCustody.repairedCsvSha256);
    await expect(run({ type: 'download', format: 'repair-csv' })).rejects.toThrow('blocked');
  } finally {
    vi.unstubAllGlobals();
  }
}, 15_000);
