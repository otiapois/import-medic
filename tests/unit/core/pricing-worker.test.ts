import { expect, it, vi } from 'vitest';
import type { WorkerMessage, WorkerReply, WorkerRequest } from '../../../src/core/worker/protocol';

it('transfers repeatable verified byte pairs and clears stale exports on invalidation or failed comparison', async () => {
  const replies = new Map<number, (reply: WorkerReply) => void>();
  vi.stubGlobal('onmessage', null);
  vi.stubGlobal('postMessage', (reply: WorkerReply, transfer?: Transferable[]) => {
    if (reply.kind !== 'progress') replies.get(reply.id)!(structuredClone(reply, { transfer }));
  });
  try {
    await import('../../../src/core/worker/diff.worker');
    let id = 0;
    const dispatch = globalThis.onmessage as unknown as (event: MessageEvent<WorkerMessage>) => void;
    function send(request: WorkerRequest): Promise<WorkerReply> {
      const messageId = ++id;
      return new Promise((resolve) => {
        replies.set(messageId, (reply) => {
          replies.delete(messageId);
          resolve(reply);
        });
        dispatch({ data: { id: messageId, request } } as MessageEvent<WorkerMessage>);
      });
    }
    const baseline = 'Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price\nboot,Boot,Color,Red,0007,20.000';
    await send({ type: 'loadBaseline', file: new File([baseline], 'store.csv') });
    await send({ type: 'loadSupplier', file: new File(['SKU,Cost\n0007,10'], 'supplier.csv') });
    const request = { type: 'diff', sheetIndex: 0, selection: { confirmed: true, pricingRule: { mode: 'multiplier', multiplier: '2.2' } }, resolutions: {} } as const;
    const update = { type: 'download', format: 'price-csv' } as const;
    const rollback = { type: 'download', format: 'price-rollback-csv' } as const;
    expect(await send(request)).toMatchObject({ kind: 'result', value: { canDownload: true, rollbackVerification: { checked: true } } });
    expect(await send(update)).toMatchObject({ kind: 'result', value: { filename: 'store-price-update.csv' } });
    const first = await send(rollback);
    const second = await send(rollback);
    expect(first).toMatchObject({ kind: 'result', value: { filename: 'store-price-rollback.csv' } });
    if (first.kind !== 'result' || !first.value || !('bytes' in first.value) ||
      second.kind !== 'result' || !second.value || !('bytes' in second.value)) throw new Error('Expected two rollback downloads');
    expect(new TextDecoder().decode(first.value.bytes)).toMatch(/0007,20\.000$/);
    expect(new TextDecoder().decode(second.value.bytes)).toBe(new TextDecoder().decode(first.value.bytes));

    await send({ type: 'invalidatePrice' });
    expect(await send(update)).toMatchObject({ kind: 'error' });
    expect(await send(rollback)).toMatchObject({ kind: 'error' });
    await send(request);
    expect(await send({ ...request, sheetIndex: 1 })).toMatchObject({ kind: 'error' });
    expect(await send(update)).toMatchObject({ kind: 'error' });
    expect(await send(rollback)).toMatchObject({ kind: 'error' });

    const invalid = { ...request, selection: { confirmed: true, pricingRule: { mode: 'target-margin', marginPercent: '100' } as const } };
    await send(request);
    expect(await send(invalid)).toMatchObject({ kind: 'result', value: { canDownload: false } });
    expect(await send(update)).toMatchObject({ kind: 'error' });
    expect(await send(rollback)).toMatchObject({ kind: 'error' });

    const markets = baseline.replace('Variant Price\n', 'Variant Price,Price / UAE,Price / EU\n') + ',70.00,20.00';
    const regional = { name: 'UAE', priceHeader: 'Price / UAE' };
    expect(await send({ type: 'loadBaseline', file: new File([markets], 'markets.csv') }))
      .toMatchObject({ kind: 'result', value: { markets: [regional, { name: 'EU', priceHeader: 'Price / EU' }] } });
    const selection = {
      confirmed: true, fxRateConfirmed: true, pricingRule: { mode: 'direct',
        fx: { sourceCurrency: 'USD', storeCurrency: 'AED', fxRate: '3.6725' } },
    } as const;
    await send({ type: 'loadSupplier', file: new File(['SKU,Price,Currency\n0007,20,USD'], 'offers.csv') });
    expect(await send({ type: 'priceFormulaPreview', sheetIndex: 0, market: 'UAE', selection }))
      .toMatchObject({ kind: 'result', value: { computedPrice: '73.45' } });
    expect(await send({ type: 'diff', sheetIndex: 0, market: 'UAE', selection, resolutions: {} }))
      .toMatchObject({ kind: 'result', value: { canDownload: true, market: regional } });
    expect(await send({ type: 'diffBatch', market: 'UAE', suppliers: [{ supplierId: 'primary', sheetIndex: 0, selection, resolutions: {} }] }))
      .toMatchObject({ kind: 'result', value: { canDownload: true, market: regional } });
    const regionalUpdate = await send(update);
    if (regionalUpdate.kind !== 'result' || !regionalUpdate.value || !('bytes' in regionalUpdate.value)) throw new Error('Expected market update');
    expect(new TextDecoder().decode(regionalUpdate.value.bytes)).toBe('Handle,Title,Option1 Name,Option1 Value,Variant SKU,Price / UAE\nboot,Boot,Color,Red,0007,73.45');

    const bigcommerce = 'Item Type,Product ID,Product Name,Product Code/SKU,Price\nProduct,10,Boot,0007,20.000';
    expect(await send({ type: 'loadBaseline', platform: 'bigcommerce', file: new File([bigcommerce], 'bulk-edit.csv') }))
      .toMatchObject({ kind: 'result', value: { hasSku: true, issues: [] } });
    await send({ type: 'loadSupplier', file: new File(['SKU,Price\n0007,21'], 'legacy-offers.csv') });
    expect(await send({ type: 'diff', sheetIndex: 0, selection: { confirmed: true }, resolutions: {} }))
      .toMatchObject({ kind: 'result', value: { canDownload: true, rollbackVerification: { restoredVariants: 1 } } });
  } finally {
    vi.unstubAllGlobals();
  }
});
