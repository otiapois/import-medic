import { readFileSync } from 'node:fs';
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

    const m13 = (name: string): File => new File([new Uint8Array(readFileSync(new URL(
      `../../../fixtures/supplier-delta/${name}`, import.meta.url)))], name);
    const workbook = m13('synthetic-pricebook.xlsx');
    await send({ type: 'loadBaseline', file: m13('synthetic-shopify.csv') });
    expect(await send({ type: 'loadSupplier', file: workbook, firstVisibleSheet: true })).toMatchObject({ kind: 'result', value: {
      sheetNames: ['Instructions', 'Q4_Prices', 'Q3_Prices'], sheets: [{ name: 'Instructions' }],
    } });
    await send({ type: 'loadSupplier', file: workbook, supplierId: 'primary', sheetName: 'Q4_Prices' });
    await send({ type: 'loadSupplier', file: workbook, supplierId: 'second', sheetName: 'Q3_Prices' });
    await send({ type: 'loadSupplier', file: new File(['SKU,Cost\n00123,28.50'], 'third.csv'), supplierId: 'third' });
    const columns = { joinKey: 'sku', skuColumn: 0, priceColumn: 1, confirmed: true } as const;
    const batch = { type: 'diffBatch', conflictPolicy: 'prefer-first', conflictPolicyConfirmed: true,
      suppliers: ['primary', 'second', 'third'].map((supplierId) => ({ supplierId, sheetIndex: 0, selection: columns, resolutions: {} })),
    } as const;
    expect(await send(batch)).toMatchObject({ kind: 'result', value: { custody: { suppliers: [
      { filename: workbook.name, selectedSheet: 'Q4_Prices' }, { filename: workbook.name, selectedSheet: 'Q3_Prices' }, { filename: 'third.csv' },
    ] } } });
    const saved = await send({ type: 'saveRecipe', supplierId: 'primary', sheetIndex: 0, supplierLabel: 'Synthetic', selection: columns });
    if (saved.kind !== 'result' || !saved.value || !('ok' in saved.value) || !saved.value.ok || !('bytes' in saved.value.value)) {
      throw new Error('Expected saved supplier recipe. ' + JSON.stringify(saved));
    }
    const recipeFile = new File([saved.value.value.bytes], 'supplier-recipe.json');
    const loaded = await send({ type: 'loadRecipe', file: recipeFile });
    if (loaded.kind !== 'result' || !loaded.value || !('ok' in loaded.value) || !loaded.value.ok || !('version' in loaded.value.value)) {
      throw new Error('Expected validated supplier recipe');
    }
    const recipe = loaded.value.value;
    expect(recipe).toMatchObject({ version: 6, sheetName: 'Q4_Prices', selectedSheet: 'Q4_Prices' });
    await send({ type: 'loadSupplier', file: workbook, supplierId: 'primary', firstVisibleSheet: true });
    expect(await send({ type: 'applyRecipe', recipe, supplierId: 'primary', sheetIndex: 0 })).toMatchObject({ kind: 'result',
      value: { ok: true, value: { sheetIndex: 0, supplier: { selectedSheet: 'Q4_Prices', sheets: [{ name: 'Q4_Prices' }] } } } });
    expect(await send(update)).toMatchObject({ kind: 'error' });
    expect(await send(batch)).toMatchObject({ kind: 'result', value: { custody: { suppliers: [
      { selectedSheet: 'Q4_Prices' }, { selectedSheet: 'Q3_Prices' }, { filename: 'third.csv' },
    ] } } });
  } finally {
    vi.unstubAllGlobals();
  }
}, 15_000);
