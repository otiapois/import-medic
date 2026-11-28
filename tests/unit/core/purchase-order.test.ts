import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCsv, serializeCsv } from '../../../src/core/csv';
import { buildPurchaseOrder, inspectPurchaseOrderInventory, inspectPurchaseOrderSupplier,
  type PurchaseOrderResult, type PurchaseOrderSource, type PurchaseOrderSupplier } from '../../../src/core/purchase-order/engine';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const input = (filename: string, text: string): PurchaseOrderSource => ({ filename, bytes: new TextEncoder().encode(text) });
const csv = (filename: string, headers: string[], records: string[][]): PurchaseOrderSource =>
  input(filename, serializeCsv(headers, records, 'purchase-order'));
const fixture = (filename: string, directory = 'purchase-order'): PurchaseOrderSource =>
  ({ filename, bytes: readFileSync(new URL(`../../../fixtures/${directory}/${filename}`, import.meta.url)) });
const stock = (current = '1', target = '6') => input('stock.csv', `SKU,On hand,Reorder Point,Target Stock\n00123,${current},1,${target}`);
const quote = (label: string, cost: string, moq = '', pack = '', sku = '00123'): PurchaseOrderSupplier =>
  ({ ...input(`${label}.csv`, `SKU,Unit Cost,MOQ,Case Pack\n${sku},${cost},${moq},${pack}`), label });

function expectHeld(result: PurchaseOrderResult) {
  expect(result).toMatchObject({ status: 'blocked', supplierCsvs: [], summaryCsv: null, packHtml: null, groups: [] });
  expect(result.auditJson.filename).toBe('po-audit.json');
  const audit = JSON.parse(result.auditJson.content);
  expect(audit.custody).not.toHaveProperty('outputs');
  expect(audit.status).toBe('blocked');
  return audit;
}

describe('purchase order planning and exact file custody', () => {
  it('resolves the selected scope, compares post-rounding subtotals and verifies all emitted bytes', async () => {
    const inventory = fixture('store-inventory.csv');
    const suppliers = [{ ...fixture('harbor-supply.csv'), label: 'Harbor Supply' }, { ...fixture('metro-wholesale.csv'), label: 'Metro Wholesale' }];
    expect(inspectPurchaseOrderInventory(inventory)).toEqual({ locations: ['East', 'West'], quantityBasis: 'Available', issues: [] });
    const result = await buildPurchaseOrder(inventory, suppliers, { targetLocation: 'East', poReference: 'PO-17',
      branding: { agencyName: 'Agency <Ops>', preparedFor: 'Store', contactNote: 'https://example.invalid/abc', accentKey: 'navy' } });
    expect(result.issues).toEqual([]);
    expect(result).toMatchObject({ status: 'ready', targetLocation: 'East', quantityBasis: 'Available', currency: 'USD',
      summary: { belowReorder: 2, unitsOrdered: 20, supplierCount: 2, totalCents: 5000, totalSpend: '50.00' },
      groups: [{ label: 'Harbor Supply', totalCents: 2400, totalSpend: '24.00', lines: [{ sku: '00123', supplierSku: '000418',
        orderQty: 12, unitCostCents: 200, lineTotalCents: 2400, inventoryLine: 2, supplierLine: 2 }] },
      { label: 'Metro Wholesale', totalCents: 2600, totalSpend: '26.00', lines: [{ sku: '00007', supplierSku: '000709',
        orderQty: 8, unitCostCents: 325, lineTotalCents: 2600, inventoryLine: 3, supplierLine: 3 }] }],
    });
    const [harbor, metro] = result.supplierCsvs;
    expect([harbor.filename, metro.filename]).toEqual(['po-harbor-supply.csv', 'po-metro-wholesale.csv']);
    expect(parseCsv(harbor.content)).toMatchObject({ lineEnding: 'crlf', records: [
      { cells: ['SKU', 'Supplier SKU', 'Current Qty', 'Reorder Point', 'Target Stock', 'Order Qty', 'MOQ', 'Case Pack', 'Lead Time Days', 'Unit Cost', 'Line Total', 'Currency', 'Supplier', 'Location', 'PO Reference'] },
      { cells: ['00123', '000418', '3', '3', '14', '12', '9', '4', '5', '2.00', '24.00', 'USD', 'Harbor Supply', 'East', 'PO-17'] },
    ] });
    expect(result.summaryCsv?.content).toBe('SKU,Current Qty,Reorder Point,Order Qty,Chosen Supplier,Unit Cost,Line Total\r\n00123,3,3,12,Harbor Supply,2.00,24.00\r\n00007,2,4,8,Metro Wholesale,3.25,26.00');
    const audit = JSON.parse(result.auditJson.content);
    const outputs = [harbor, metro, result.summaryCsv!, result.packHtml!];
    expect(audit.custody).toMatchObject({ inventory: { sha256: hash(inventory.bytes), byteLength: inventory.bytes.byteLength },
      suppliers: suppliers.map(source => ({ sha256: hash(source.bytes), filename: source.filename, selectedSheet: null })),
      outputs: outputs.map(({ filename, content }) => ({ filename, byteLength: Buffer.byteLength(content), sha256: hash(content) })) });
    expect(audit.offers).toEqual(expect.arrayContaining([expect.objectContaining({ sku: '00123', supplierIndex: 1, rawUnitCost: '1.50', orderQty: 20, lineTotalCents: 3000 })]));
    const html = result.packHtml!.content;
    expect(html).toContain('Agency &lt;Ops&gt;');
    expect(html).toContain("script-src 'none'; connect-src 'none'");
    expect(html).toContain('@media print');
    expect(html).toContain('break-before:page');
    expect(html).toContain(hash(metro.content));
    expect(html).not.toMatch(/<script|\b(?:href|src)=|https?:|\/\//i);
  });

  it('keeps exact inventory locations and deliberately selects Shopify Available before on-hand', async () => {
    const inventory = input('stock.csv', 'SKU,Location,Available (not editable),On hand (current),Reorder Point,Target Stock\n00123,East,-3,99,0,4\n00123,east,5,0,0,4');
    expectHeld(await buildPurchaseOrder(inventory, [quote('Harbor', '1')]));
    const result = await buildPurchaseOrder(inventory, [quote('Harbor', '1')], { targetLocation: 'East' });
    expect(result).toMatchObject({ quantityBasis: 'Available (not editable)', summary: { belowReorder: 1, unitsOrdered: 7 },
      groups: [{ lines: [{ currentQty: -3, orderQty: 7, inventoryLine: 2 }] }] });
    const offScope = await buildPurchaseOrder(inventory, [quote('Harbor', '1')], { targetLocation: 'east' });
    expect(offScope).toMatchObject({ status: 'ready', groups: [], summary: { belowReorder: 0 } });
    expect(offScope.summaryCsv?.content).toBe('SKU,Current Qty,Reorder Point,Order Qty,Chosen Supplier,Unit Cost,Line Total');
  });

  it('preserves matching offers and exact physical lines when one unsafe offer blocks everything', async () => {
    const suppliers = [quote('Valid', '1.00'), { ...csv('other.csv', ['SKU', 'Unit Cost', 'MOQ', 'Case Pack', 'Notes'], [
      ['unmatched', 'garbage', 'q', '0', 'Line 1\r\nLine 2'], ['00123', '', '1.5', '0', 'held'],
    ]), label: 'Other' }];
    const result = await buildPurchaseOrder(stock(), suppliers, { policy: 'prefer-first' });
    const audit = expectHeld(result);
    expect(audit.issues).toMatchObject(['invalid-moq', 'invalid-case-pack', 'invalid-unit-cost'].map(code => ({ code, line: 4, supplierIndex: 1, sku: '00123' })));
    expect(audit.custody.suppliers.map(({ sha256 }: { sha256: string }) => sha256)).toEqual(suppliers.map(({ bytes }) => hash(bytes)));
    expect(audit.offers).toHaveLength(2);
    expect(audit.offers[1]).toMatchObject({ rawUnitCost: '', rawMoq: '1.5', rawCasePack: '0', inventoryLine: 2, line: 4 });
  });

  it('holds exact lowest subtotal ties unless catalog order is selected explicitly', async () => {
    const suppliers = [quote('First', '0.60', '', '2'), quote('Second', '0.45', '7', '4'), quote('Third', '1.00')];
    for (const policy of ['lowest-landed-cost', 'block-ties'] as const) {
      const audit = expectHeld(await buildPurchaseOrder(stock(), suppliers, { policy }));
      expect(audit.issues).toMatchObject([{ code: 'supplier-cost-tie', line: 2,
        offers: [{ supplierIndex: 0, line: 2 }, { supplierIndex: 1, line: 2 }] }]);
    }
    const ordered = await buildPurchaseOrder(stock(), suppliers, { policy: 'prefer-first' });
    expect(ordered.groups[0]).toMatchObject({ label: 'First', totalCents: 360 });
    const nonMinimum = await buildPurchaseOrder(stock(), [...suppliers.slice(0, 2), quote('Cheaper', '0.20')], { policy: 'block-ties' });
    expect(nonMinimum.groups[0]).toMatchObject({ label: 'Cheaper', totalCents: 100 });
  });

  it('keeps the workbook fingerprint, exact visible selection and raw leading-zero SKU text', async () => {
    const all = fixture('synthetic-pricebook.xlsx', 'supplier-delta');
    const pending = inspectPurchaseOrderSupplier(all);
    expect(pending).toMatchObject({ selectedSheet: null, sheetNames: ['Instructions', 'Q4_Prices', 'Q3_Prices'] });
    expect(pending.issues[0]?.code).toBe('supplier-worksheet-required');
    for (const [sheetName, totalCents] of [['Q3_Prices', 12500], ['Q4_Prices', 14250]] as const) {
      const result = await buildPurchaseOrder(stock(), [{ ...all, label: 'Workbook', sheetName }]);
      expect(result.issues).toEqual([]);
      expect(result).toMatchObject({ status: 'ready', summary: { totalCents },
        groups: [{ lines: [{ sku: '00123', supplierLine: 2 }] }] });
      expect(JSON.parse(result.auditJson.content).custody.suppliers[0]).toMatchObject({ selectedSheet: sheetName, sha256: hash(all.bytes) });
    }
    for (const sheetName of ['q3_prices', 'Q3_Prices ', 'Cost_Chart', 'Hidden_Notes', 'Archived_Notes']) {
      const result = await buildPurchaseOrder(stock(), [{ ...all, label: 'Workbook', sheetName }]);
      expectHeld(result);
      expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing-worksheet' })]));
    }
  });

  it('leaves explicit zero intact, defaults blank pack, and guards text while preserving source evidence', async () => {
    const inventory = csv('store.csv', ['SKU', 'On hand', 'Location', 'Reorder Point', 'Target Stock'], [['00123', '-4', '=A1', '', '0001']]);
    const suppliers = [{ ...csv('vendor.csv', ['SKU', 'Unit Cost', 'Supplier SKU', 'Case Pack'], [['00123', '$0.00', '@quoted\n=sku', '']]), label: '+Vendor' }];
    const result = await buildPurchaseOrder(inventory, suppliers, { reorderPoint: '0', targetStock: '99', poReference: '=B1' });
    expect(result).toMatchObject({ status: 'ready', currency: '$', summary: { belowReorder: 1, unitsOrdered: 5, totalSpend: '0.00' },
      groups: [{ lines: [{ supplierSku: '@quoted\n=sku', casePack: 1, moq: 0, unitCostCents: 0, currentQty: -4, targetStock: 1 }] }] });
    expect(parseCsv(result.supplierCsvs[0].content).records[1].cells).toEqual([
      '00123', "'@quoted\n=sku", '-4', '0', '1', '5', '0', '1', '', '0.00', '0.00', '$', "'+Vendor", "'=A1", "'=B1",
    ]);
    expect(result.packHtml?.content).toContain('@quoted\n=sku');
  });

  it('rejects currency conflicts, sub-cent or rounded values and unsafe integer totals without issuing output hashes', async () => {
    expect(expectHeld(await buildPurchaseOrder(stock(), [quote('USD', 'USD 1.00'), quote('EUR', 'EUR 2.00')], { policy: 'prefer-first' })).issues)
      .toMatchObject([{ code: 'incomparable-currency', supplierIndex: 0, line: 2 }, { code: 'incomparable-currency', supplierIndex: 1, line: 2 }]);
    expect(expectHeld(await buildPurchaseOrder(stock(), [quote('Fraction', '0.001')])).issues[0]).toMatchObject({ code: 'invalid-unit-cost' });
    expect(expectHeld(await buildPurchaseOrder(stock(), [quote('Overflow', '90071992547409.91')])).issues[0]).toMatchObject({ code: 'order-line-out-of-range' });
    const compatible = await buildPurchaseOrder(stock(), [quote('Plain', '1.00'), quote('USD', 'USD 2.00')]);
    expect(compatible).toMatchObject({ status: 'ready', currency: 'USD', summary: { totalCents: 500 } });
    const combined = input('store.csv', 'SKU,Available,Reorder Point,Target Stock\n00123,0,0,1\n00124,0,0,1');
    expect(expectHeld(await buildPurchaseOrder(combined, [quote('First', '45035996273704.96'), quote('Second', '45035996273704.96', '', '', '00124')])).issues[0])
      .toMatchObject({ code: 'order-total-out-of-range' });
  });

  it('holds duplicate exact joins and reserves distinct supplier filenames including the summary filename', async () => {
    const collision = input('inventory.csv', 'SKU,Available,Reorder Point,Target Stock\n00123,1,1,6\n00002,1,1,6\n00003,1,1,6');
    const result = await buildPurchaseOrder(collision, [quote('Consolidated Summary', '1'), quote('CAFE', '1', '', '', '00002'), quote('café', '1', '', '', '00003')]);
    expect(result.supplierCsvs.map(({ filename }) => filename)).toEqual(['po-consolidated-summary-2.csv', 'po-cafe.csv', 'po-cafe-2.csv']);
    const duplicated = { ...input('duplicate.csv', 'SKU,Unit Cost\n00123,0\n00123,0'), label: 'Duplicate' };
    expect(expectHeld(await buildPurchaseOrder(stock(), [duplicated])).issues[0]).toMatchObject({ code: 'duplicate-supplier-sku', lines: [2, 3] });
    expect(expectHeld(await buildPurchaseOrder(input('inventory.csv', 'SKU,Available,Reorder Point,Target Stock\n00123,1,1,6\n00123,2,1,6'), [quote('One', '1')])).issues[0])
      .toMatchObject({ code: 'duplicate-inventory-sku', lines: [2, 3] });
  });
});
