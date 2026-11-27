import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { decodeCsv, parseCsv } from '../../../src/core/csv';
import {
  buildInventorySync, inspectInventoryBaseline, inspectInventorySupplier, type InventorySource, type InventorySyncResult,
} from '../../../src/core/inventory-sync/engine';
import { offlineReportCsp } from '../../../src/core/report-html';

const file = (filename: string, text: string): InventorySource => ({ filename, bytes: new TextEncoder().encode(text) });
const fixture = (filename: string) => ({ filename, bytes: readFileSync(new URL(`../../../fixtures/inventory-sync/${filename}`, import.meta.url)) });
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const mapping = { skuColumn: 0, quantityColumn: 1 };
const options = { targetLocation: 'Warehouse A', reserveUnits: 2, zeroOutThreshold: 2 };
const headers = 'Handle,Title,Option 1 Name,Option 1 Value,Option 2 Name,Option 2 Value,SKU,Location,On hand (current),On hand (new),Available\r\n';
const baseline = (...rows: string[]) => file('baseline.csv', headers + rows.join('\r\n'));
const supplier = (rows: string, filename = 'supplier.csv') => ({ ...file(filename, 'SKU,Stock\n' + rows), mapping });
const tote = (current: string, location = 'Warehouse A', sku = '00042') => `tote,Canvas Tote,Color,Sand,Size,Medium,${sku},${location},${current},99,17`;
const records = (bytes: Uint8Array) => parseCsv(decodeCsv(bytes).text).records;

function held(result: InventorySyncResult) {
  expect(result).toMatchObject({ status: 'blocked', updateCsv: null, rollbackCsv: null });
  expect(result.custody.updateCsvSha256).toBeUndefined();
  expect(result.custody.rollbackCsvSha256).toBeUndefined();
  expect(result.signOffHtml).not.toContain('<dt>Inventory Update CSV</dt>');
}

describe('M19 inventory sync native bytes', () => {
  it('keeps exact case-sensitive scope and replays only changed values in the inverse Shopify CAS pair', async () => {
    const source = fixture('synthetic-shopify-baseline.csv');
    const feed = { ...fixture('synthetic-supplier.csv'), mapping };
    expect(inspectInventoryBaseline(source)).toEqual({ locations: ['Warehouse A', 'Warehouse B'], issues: [] });
    const comparison = await buildInventorySync(source, [feed], options);
    expect(comparison.issues).toEqual([]);
    expect(comparison).toMatchObject({ status: 'ready', targetLocation: 'Warehouse A',
      totals: { unitsAdded: 6, unitsRemoved: 0, changedCount: 2 },
      verification: { checked: true, restoredRows: 2, otherLocationRowsUntouched: 2 } });
    const [head, ...update] = records(comparison.updateCsv!);
    const [, ...rollback] = records(comparison.rollbackCsv!);
    expect(head.cells).toEqual(['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value',
      'Option3 Name', 'Option3 Value', 'SKU', 'Location', 'On hand (current)', 'On hand (new)']);
    expect(update.map(({ cells }) => cells.slice(-4))).toEqual([['00042', 'Warehouse A', '0007', '9'], ['00087', 'Warehouse A', '0002', '6']]);
    expect(rollback.map(({ cells }) => cells.slice(-4))).toEqual([['00042', 'Warehouse A', '9', '0007'], ['00087', 'Warehouse A', '6', '0002']]);
    expect(comparison.custody).toMatchObject({ baseline: { sha256: digest(source.bytes) }, suppliers: [{ sha256: digest(feed.bytes) }],
      updateCsvSha256: digest(comparison.updateCsv!), rollbackCsvSha256: digest(comparison.rollbackCsv!) });
    expect(JSON.parse(comparison.auditJson).custody).toEqual(comparison.custody);
    for (const file of [source.bytes, feed.bytes, comparison.updateCsv!, comparison.rollbackCsv!]) expect(comparison.signOffHtml).toContain(digest(file));
    for (const targetLocation of [undefined, 'warehouse a', 'Warehouse A ']) {
      const result = await buildInventorySync(source, [feed], { ...options, targetLocation });
      held(result);
      expect(result.issues).toMatchObject([{ code: targetLocation === undefined ? 'target-location-required' : 'target-location-invalid' }]);
    }
  });

  it('uses signed authoritative current, withholds pending new and available, and blocks unverifiable current', async () => {
    const source = baseline(tote('-0002'), tote('Not stocked', 'Warehouse B'));
    const result = await buildInventorySync(source, [supplier('00042,11')], options);
    expect(result.status).toBe('ready');
    expect(records(result.updateCsv!)[0].cells).toContain('Option 2 Name');
    expect(records(result.updateCsv!)[1].cells.slice(-2)).toEqual(['-0002', '9']);
    expect(records(result.rollbackCsv!)[1].cells.slice(-2)).toEqual(['9', '-0002']);
    for (const qty of ['Not stocked', '', '7.0', ' 7', '1e1']) {
      const blocked = await buildInventorySync(baseline(tote(qty)), [supplier('00042,11')], options);
      held(blocked);
      expect(blocked.issues).toMatchObject([{ code: 'unverified-baseline-current', line: 2, value: qty }]);
    }
    const missing = await buildInventorySync(file('available.csv', 'Handle,Option1 Value,SKU,Location,Available,On hand (new)\ntote,Sand,00042,Warehouse A,15,20'),
      [supplier('00042,11')], options);
    held(missing);
    expect(missing.issues).toContainEqual(expect.objectContaining({ code: 'missing-baseline-column', column: 'On hand (current)' }));
  });

  it('discloses supplier-only and other-location offers without issuing their rows', async () => {
    const source = baseline(tote('0007'), tote('0010', 'Warehouse B', '00087'));
    const result = await buildInventorySync(source, [supplier('00042,11\n00087,10\n00303,9')], options);
    expect(result.status).toBe('ready');
    expect(result.rows.map(({ sku }) => sku)).toEqual(['00042']);
    expect(records(result.updateCsv!)).toHaveLength(2);
    expect(JSON.parse(result.auditJson).excludedOffers).toMatchObject([
      { sku: '00087', reason: 'outside-selected-location', offers: [{ line: 3, quantity: 10 }] },
      { sku: '00303', reason: 'absent-from-baseline', offers: [{ line: 4, quantity: 9 }] },
    ]);
  });

  it('requires option fields demonstrated by other rows for the same Shopify handle', async () => {
    const source = baseline(tote('7').replace('Size,Medium', ','), tote('10', 'Warehouse B'));
    const result = await buildInventorySync(source, [supplier('00042,11')], options);
    held(result);
    expect(result.issues).toMatchObject([{ code: 'invalid-native-identity', source: 'baseline', line: 2, sku: '00042' }]);
  });

  it('approves only proposals above the exact per-row 80% boundary and applies reserve, threshold and cap', async () => {
    const source = baseline(tote('00015'));
    const noApproval = await buildInventorySync(source, [supplier('00042,5')], options);
    expect(noApproval).toMatchObject({ status: 'ready', rows: [{ currentQty: 15, proposedQty: 3, bufferWithheld: 2 }] });
    const below = await buildInventorySync(source, [supplier('00042,5')], { ...options, maxCap: 2 });
    held(below);
    expect(below.issues).toMatchObject([{ code: 'large-stock-drop', line: 2, sku: '00042' }]);
    const approved = await buildInventorySync(source, [supplier('00042,5')], { ...options, maxCap: 2, approveLargeDrop: true, reserveUnits: 0 });
    expect(approved).toMatchObject({ status: 'ready', rows: [{ proposedQty: 2, bufferWithheld: 3, largeDrop: true }] });
    const zeroed = await buildInventorySync(source, [supplier('00042,2')], { ...options, reserveUnits: 0, approveLargeDrop: true });
    expect(zeroed).toMatchObject({ status: 'ready', rows: [{ proposedQty: 0, bufferWithheld: 2 }],
      totals: { unitsRemoved: 15, bufferZeroedCount: 1, outOfStockCount: 1 } });
  });

  it('pinpoints malformed physical CSV records and holds duplicate native identities and conflicting suppliers', async () => {
    const source = baseline(tote('0007'));
    const malformed = { ...file('dirty.csv', 'SKU,Qty,Note\r\n00042,11,"one\r\ntwo"\r\n00087,-1,bad\r\n00099,2.5,bad\r\n00333,1e2,bad'), mapping };
    const blocked = await buildInventorySync(source, [malformed], options);
    held(blocked);
    expect(blocked.issues).toMatchObject(['-1', '2.5', '1e2'].map((value, index) =>
      ({ code: 'invalid-supplier-quantity', source: 'supplier', supplierIndex: 0, line: index + 4, value })));
    const nativeDuplicate = await buildInventorySync(baseline(tote('7'), tote('7', 'Warehouse A', '00043')), [supplier('00042,11')], options);
    held(nativeDuplicate);
    expect(nativeDuplicate.issues).toMatchObject([{ code: 'duplicate-native-identity', lines: [2, 3] }]);
    const skuDuplicate = await buildInventorySync(baseline(tote('7'), tote('7').replace('Sand', 'Blue')), [supplier('00042,11')], options);
    held(skuDuplicate);
    expect(skuDuplicate.issues).toMatchObject([{ code: 'duplicate-baseline-sku-location', lines: [2, 3] }]);
    const duplicateOffer = await buildInventorySync(source, [supplier('00042,11\n\n00042,11')], options);
    held(duplicateOffer);
    expect(duplicateOffer.issues).toMatchObject([{ code: 'duplicate-supplier-sku', offers: [{ line: 2 }, { line: 4 }] }]);
    const conflict = await buildInventorySync(source, [supplier('00042,11'), supplier('00042,12', 'second.csv')], { ...options, approveLargeDrop: true });
    held(conflict);
    expect(conflict.issues).toMatchObject([{ code: 'supplier-quantity-conflict', offers: [{ supplierIndex: 0, line: 2, quantity: 11 },
      { supplierIndex: 1, line: 2, quantity: 12 }] }]);
  });

  it('holds scientific SKU evidence and records exact totals when a batch exceeds the safe integer range', async () => {
    const scientific = await buildInventorySync(baseline(tote('7', 'Warehouse A', '001e2')), [supplier('001e2,11')], options);
    held(scientific);
    expect(scientific.issues).toMatchObject([{ code: 'scientific-sku', source: 'supplier', line: 2, value: '001e2' }]);
    const overflow = await buildInventorySync(baseline(tote('-9007199254740991')), [supplier('00042,9007199254740990')],
      { ...options, reserveUnits: 0 });
    held(overflow);
    expect(overflow.totals.unitsAdded).toBe('18014398509481981');
    expect(JSON.parse(overflow.auditJson).totals.unitsAdded).toBe('18014398509481981');
  });

  it('uses only the explicitly named visible XLSX worksheet and reads literal stock on its physical row', async () => {
    const template = readFileSync(new URL('../../../fixtures/supplier-delta/synthetic-pricebook.xlsx', import.meta.url));
    const archive = unzipSync(template);
    const path = 'xl/worksheets/sheet2.xml';
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SKU</t></is></c><c r="B1" t="inlineStr"><is><t>Qty</t></is></c></row>' +
      '<row r="9"><c r="A9" t="inlineStr"><is><t>00042</t></is></c><c r="B9"><v>11</v></c></row></sheetData></worksheet>';
    const workbook = (xml: string) => ({ filename: 'synthetic-stock.xlsx', bytes: zipSync({ ...archive, [path]: strToU8(xml) }), mapping });
    const files = workbook(sheet);
    expect(inspectInventorySupplier(files)).toMatchObject({ headers: [], sheetNames: ['Instructions', 'Q4_Prices', 'Q3_Prices'],
      issues: [{ code: 'supplier-worksheet-required' }] });
    expect(inspectInventorySupplier({ ...files, sheetName: 'Hidden_Notes' }).issues).toMatchObject([{ code: 'supplier-worksheet-invalid' }]);
    const picked = await buildInventorySync(baseline(tote('7')), [{ ...files, sheetName: 'Q4_Prices' }], options);
    expect(picked).toMatchObject({ status: 'ready', rows: [{ offers: [{ line: 9, quantity: 11 }] }],
      custody: { suppliers: [{ sheetName: 'Q4_Prices', sha256: digest(files.bytes) }] } });
    const computed = { ...workbook(sheet.replace('<v>11</v>', '<f>SUM(11)</f><v>11</v>')), sheetName: 'Q4_Prices' };
    const blocked = await buildInventorySync(baseline(tote('7')), [computed], options);
    held(blocked);
    expect(blocked.issues).toMatchObject([{ code: 'invalid-supplier-quantity', line: 9, value: '11' }]);
    const numericSku = { ...workbook(sheet.replace('r="A9" t="inlineStr"><is><t>00042</t></is>', 'r="A9"><v>42</v>')), sheetName: 'Q4_Prices' };
    const numericHold = await buildInventorySync(baseline(tote('7')), [numericSku], options);
    held(numericHold);
    expect(numericHold.issues).toMatchObject([{ code: 'invalid-supplier-sku', line: 9, value: '42' }]);
  });

  it('renders brand and source text as inert escaped markup in both ready and blocked sign-offs', async () => {
    const attack = '<img src=x onerror=alert(1)>';
    const source = baseline(tote('0007', 'Warehouse A', attack));
    const brand = { agencyName: attack, preparedFor: 'Client', contactNote: '', accentKey: 'navy' as const };
    const feed = supplier(attack + ',11', 'stock-' + attack + '.csv');
    const ready = await buildInventorySync(source, [feed], { ...options, brand });
    expect(ready.status).toBe('ready');
    const blocked = await buildInventorySync(source, [supplier(attack + ',-1')], { ...options, brand });
    held(blocked);
    for (const { signOffHtml } of [ready, blocked]) {
      expect(signOffHtml).toContain(`content="${offlineReportCsp}"`);
      expect(signOffHtml).toContain('Prepared by <strong>&lt;img src=x onerror=alert(1)&gt;</strong>');
      expect(signOffHtml).not.toContain(attack);
    }
  });
});
