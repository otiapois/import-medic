import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseCsv, serializeCsv } from '../../../src/core/csv';
import { buildWholesalePriceList, type WholesaleOptions } from '../../../src/core/wholesale-pricelist/engine';

const fixture = (name: string) => readFileSync(new URL('../../../fixtures/m24/' + name, import.meta.url));
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const bytes = (text: string) => new TextEncoder().encode(text);
const baseline = fixture('wholesale-shopify.csv');
const costSheet = fixture('wholesale-costs.csv');
const options = JSON.parse(fixture('wholesale-options.json').toString('utf8')) as WholesaleOptions;
const wholesale = (change: Partial<WholesaleOptions> = {}, source = baseline as Uint8Array) =>
  buildWholesalePriceList('shopify', source, { ...options, costSheet, ...change });
const singleOptions = { ...options, requireMap: false, minimumMarginPercent: undefined, shopifyTierName: 'Bronze',
  tiers: [{ ...options.tiers[0], value: '0' }] };
const cells = (csv: string) => parseCsv(csv).records.map(record => record.cells);
const catalog = (sku = '00007', retail = '20.00', title = 'Product') => bytes(serializeCsv(
  ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price'],
  [['example', title, 'Title', 'Default Title', sku, retail]], 'wholesale-sheet'));

describe('M24 wholesale pricing and confidential export', () => {
  it('re-parses all exact buyer/native cells and matches the original and downloadable bytes to the audit', async () => {
    const ready = await wholesale();
    expect(ready.canExport).toBe(true);
    expect(ready.issues).toEqual([]);
    expect(cells(ready.buyerCsv!)).toEqual([
      ['SKU', 'Product', 'Case Pack', 'Bronze MOQ', 'Bronze Unit Price', 'Silver MOQ', 'Silver Unit Price', 'Gold MOQ', 'Gold Unit Price'],
      ['00007', 'Travel Mug\n12 oz', '6', '12', '39.96', '54', '34.97', '102', '29.97'],
      ['00008', 'Travel Mug\n12 oz', '5', '10', '31.96', '50', '27.97', '100', '23.97'],
      ['00009', 'Canvas Tote', '4', '12', '23.96', '52', '20.97', '100', '17.97'],
    ]);
    expect(cells(ready.shopifyCsv!)).toEqual([
      ['Catalog Title', 'SKU', 'Option1 Name', 'Option1 Value', 'Fixed Price', 'Quantity Increment', 'Minimum Order Quantity'],
      ['Northstar Wholesale Silver', '00007', '', '', '34.97', '6', '54'],
      ['Northstar Wholesale Silver', '00008', '', '', '27.97', '5', '50'],
      ['Northstar Wholesale Silver', '00009', '', '', '20.97', '4', '52'],
    ]);
    expect(ready.buyerCsv).toMatch(/\r\n/);
    expect(ready.internalCsv).toContain('Landed Cost');
    expect(ready.internalCsv).toContain('17.31');
    expect(ready.rows[0].tiers[0]).toMatchObject({ profit: '22.65', marginPercent: '56.681682' });
    expect(ready.rows.map(({ line }) => line)).toEqual([2, 4, 5]);
    expect(ready.custody).toEqual({ baselineSha256: hash(baseline), costSheetSha256: hash(costSheet), buyerSha256: hash(ready.buyerCsv!),
      shopifySha256: hash(ready.shopifyCsv!), lineSheetSha256: hash(ready.lineSheetHtml!), internalSha256: hash(ready.internalCsv!) });
    expect(JSON.parse(ready.auditJson).custody).toEqual(ready.custody);
  });

  it('makes all three buyer outputs byte-identical when only internal cost, MAP and unknown catalog content change', async () => {
    const first = await wholesale();
    const changed = await wholesale({ costSheet: bytes(costSheet.toString().replace('17.31,29.95', '16.87,29.19')) },
      bytes(baseline.toString().replace('Example catalog note', 'CATALOG-PROVENANCE-MARKER').replace('59.95', '999.99')));
    expect(changed.canExport).toBe(true);
    expect(changed.custody.costSheetSha256).not.toBe(first.custody.costSheetSha256);
    expect(changed.internalCsv).not.toBe(first.internalCsv);
    expect(changed.auditJson).not.toBe(first.auditJson);
    for (const key of ['buyerCsv', 'shopifyCsv', 'lineSheetHtml'] as const) {
      expect(changed[key]).toBe(first[key]);
      expect(changed[key]).not.toMatch(/CATALOG-PROVENANCE-MARKER|16\.87|29\.19|999\.99|Landed Cost|Margin|SHA-256|costSheet/);
    }
    expect(changed.buyerRows[0]).toEqual({ sku: '00007', product: 'Travel Mug\n12 oz', casePack: '6', tiers: [
      { tierName: 'Bronze', minOrderQty: '12', unitPrice: '39.96' }, { tierName: 'Silver', minOrderQty: '54', unitPrice: '34.97' },
      { tierName: 'Gold', minOrderQty: '102', unitPrice: '29.97' },
    ] });
  });

  it('holds all exports on a MAP breach and retains the SKU, tier, and separately attributed physical lines', async () => {
    const unsafe = fixture('wholesale-map-hold.csv');
    const held = await wholesale({ costSheet: unsafe });
    expect(held).toMatchObject({ canExport: false, buyerCsv: null, shopifyCsv: null, lineSheetHtml: null, internalCsv: null, buyerRows: [],
      custody: { baselineSha256: hash(baseline), costSheetSha256: hash(unsafe), buyerSha256: null, shopifySha256: null,
        lineSheetSha256: null, internalSha256: null } });
    expect(held.issues).toEqual(['Silver', 'Gold'].map(tierName => expect.objectContaining({
      sku: '00007', tierName, baselineLine: 2, costLine: 2, line: 2, source: 'cost-sheet', code: 'below-map',
    })));
    const shifted = await wholesale({ costSheet: bytes('SKU,Cost,MAP,Note\r\n00007,17.31,29.95,"A\r\nB"\r\n00008,12.37,25.00,\r\n00009,8.41,17.95,') });
    expect(shifted.issues).toContainEqual(expect.objectContaining({ sku: '00008', tierName: 'Gold', baselineLine: 4, line: 4, costLine: 4 }));
  });

  it('checks final cents against exact minimum margin and landed cost with no floor clamping', async () => {
    const source = catalog('00007', '10.00');
    const cost = bytes('SKU,Cost\n00007,8.00');
    const base = { ...singleOptions, costSheet: cost };
    const matched = await wholesale({ ...base, minimumMarginPercent: '20' }, source);
    expect(matched.canExport).toBe(true);
    const held = await wholesale({ ...base, minimumMarginPercent: '20.00000000001' }, source);
    expect(held.rows[0].tiers[0]).toMatchObject({ unitPrice: '10.00', marginPercent: '20.000000' });
    expect(held.issues).toContainEqual(expect.objectContaining({ code: 'below-minimum-margin', sku: '00007', tierName: 'Bronze', line: 2 }));
    const roundedBelowCost = await wholesale({ ...base, costSheet: bytes('SKU,Cost\n00007,9.01'),
      tiers: [{ ...base.tiers[0], rounding: 'nearest-whole' }] }, catalog('00007', '9.49'));
    expect(roundedBelowCost.rows[0].tiers[0].unitPrice).toBe('9.00');
    expect(roundedBelowCost.issues).toContainEqual(expect.objectContaining({ code: 'below-landed-cost' }));
    expect(roundedBelowCost.shopifyCsv).toBeNull();
  });

  it('checks monotonicity after rounding and enforces ordered numbers, unique names, and quantity bounds', async () => {
    const none = { ...singleOptions.tiers[0], value: '1' };
    const ending = { ...none, tierName: 'Silver', value: '2', rounding: 'ending-99' as const, minOrderQty: '11' };
    const source = catalog('00007', '10.00');
    const mixed = await wholesale({ ...singleOptions, costSheet: undefined, tiers: [none, ending] }, source);
    expect(mixed.rows[0].tiers.map(({ unitPrice }) => unitPrice)).toEqual(['9.90', '9.99']);
    expect(mixed.issues).toContainEqual(expect.objectContaining({ code: 'non-monotonic-tier-price', sku: '00007', tierName: 'Silver', line: 2 }));
    const duplicate = await wholesale({ ...singleOptions, costSheet: undefined,
      tiers: [none, { ...ending, tierName: 'bronze', minOrderQty: '010' }] }, source);
    expect(duplicate.issues.map(({ code }) => code)).toContain('invalid-tier-minimums');
    expect(duplicate.issues.map(({ code }) => code)).toContain('duplicate-tier-name');
    const overflow = await wholesale({ ...singleOptions, costSheet: bytes('SKU,Case Pack\n00007,2'),
      tiers: [{ ...none, minOrderQty: '2147483647' }] }, source);
    expect(overflow.issues).toContainEqual(expect.objectContaining({ code: 'tier-quantity-overflow', line: 2 }));
    expect(overflow.buyerCsv).toBeNull();
    expect((await wholesale({ ...singleOptions, tiers: [] })).canExport).toBe(false);
    expect((await wholesale({ ...singleOptions, tiers: Array(6).fill(none) })).canExport).toBe(false);
  });

  it('uses exact cost-plus cent rounding and permits quantity rule defaults for rows with no optional evidence', async () => {
    const markup = await wholesale({ ...singleOptions, costSheet: bytes('SKU,Cost\n00007,1.01'),
      tiers: [{ ...singleOptions.tiers[0], discountMode: 'cost-plus-percent', value: '50' }] }, catalog());
    expect(markup.buyerRows[0]).toMatchObject({ casePack: '1', tiers: [{ minOrderQty: '10', unitPrice: '1.52' }] });
    const ready = await wholesale({ ...singleOptions, costSheet: undefined }, catalog());
    expect(ready.canExport).toBe(true);
    expect(ready.rows[0].landedCost).toBeNull();
    expect(ready.custody.costSheetSha256).toBeNull();
    const belowCent = await wholesale({ ...singleOptions, costSheet: undefined }, catalog('00007', '0.004'));
    expect(belowCent.issues).toContainEqual(expect.objectContaining({ code: 'nonpositive-tier-price', line: 2 }));
  });

  it('holds invalid, missing, ambiguous and conflicting financial evidence', async () => {
    const source = catalog();
    for (const [evidence, code] of [
      ['SKU,Cost\n00007,2.001', 'invalid-cost'], ['SKU,Cost\n00007,=0', 'invalid-cost'],
      ['SKU,MAP\n00007,0', 'invalid-map'], ['SKU,Case Pack\n00007,1.5', 'invalid-casePack'],
      ['SKU,Cost,Currency\n00007,5.00,EUR', 'conflicting-currency'], ['SKU,MAP,Minimum Advertised Price\n00007,4,4', 'ambiguous-evidence-column'],
      ['SKU,Cost\n00007,4\n00007,5', 'duplicate-cost-sheet-sku'],
    ]) {
      const held = await wholesale({ ...singleOptions, costSheet: bytes(evidence) }, source);
      expect(held.issues).toContainEqual(expect.objectContaining({ code }));
      expect(held.buyerCsv).toBeNull();
    }
    const missing = await wholesale({ ...singleOptions, requireMap: true, minimumMarginPercent: '0', costSheet: undefined }, source);
    expect(missing.issues.map(({ code }) => code)).toEqual(['missing-landed-cost', 'missing-map']);
    const conflict = await wholesale({ ...singleOptions, costSheet: bytes('SKU,Cost\n00007,2.00') },
      bytes('Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price,Cost per item\nexample,Product,Title,Default Title,00007,20.00,3.00'));
    expect(conflict.issues).toContainEqual(expect.objectContaining({ code: 'conflicting-cost', sku: '00007', line: 2, baselineLine: 2 }));
    expect(conflict.shopifyCsv).toBeNull();
  });

  it('reads XLSX with exact text SKUs, records the named worksheet and holds formula cells by worksheet row', async () => {
    const book = fixture('wholesale-costs.xlsx');
    const csv = await wholesale();
    const xlsx = await wholesale({ costSheet: book, worksheetName: 'Wholesale Costs' });
    expect(xlsx.canExport).toBe(true);
    expect(xlsx.selectedWorksheet).toBe('Wholesale Costs');
    expect(xlsx.custody.costSheetSha256).toBe(hash(book));
    expect(xlsx.buyerCsv).toBe(csv.buyerCsv);
    expect((await wholesale({ costSheet: book })).selectedWorksheet).toBe('Wholesale Costs');
    expect((await wholesale({ costSheet: book, worksheetName: 'Invalid' })).issues).toContainEqual(expect.objectContaining({ code: 'missing-worksheet' }));
    const archive = unzipSync(book);
    const key = 'xl/worksheets/sheet1.xml';
    archive[key] = strToU8(strFromU8(archive[key]).replace('<c r="B3"><v>12.37</v></c>', '<c r="B3"><f>1+1</f><v>2</v></c>'));
    const held = await wholesale({ costSheet: zipSync(archive) });
    expect(held.issues).toContainEqual(expect.objectContaining({ code: 'invalid-cost', sku: '00008', line: 3, source: 'cost-sheet' }));
    expect(held.lineSheetHtml).toBeNull();
  });

  it('holds an ambiguous workbook SKU column and distinguishes a CSV heading from a ZIP signature', async () => {
    const archive = unzipSync(fixture('wholesale-costs.xlsx'));
    const key = 'xl/worksheets/sheet1.xml';
    archive[key] = strToU8(strFromU8(archive[key]).replace('</row>', '<c r="F1" t="inlineStr"><is><t>sku</t></is></c></row>'));
    const held = await wholesale({ costSheet: zipSync(archive) });
    expect(held.issues).toContainEqual(expect.objectContaining({ code: 'ambiguous-cost-sheet-sku', line: 1, column: 'SKU' }));
    expect(held.shopifyCsv).toBeNull();
    const csv = await wholesale({ ...singleOptions, costSheet: bytes('PK note,SKU,Cost\ncomment,00007,2.00') }, catalog());
    expect(csv.canExport).toBe(true);
    expect(csv.rows[0].landedCost).toBe('2.00');
  });

  it('uses WooCommerce and BigCommerce variant SKU, title, and original retail without misusing the parent price', async () => {
    const woo = bytes('ID,Type,SKU,Parent,Name,Regular price,Sale price\n1,variable,PARENT,,Parent,,\n2,variation,00007,id:1,Variant,40.00,24.00');
    const big = bytes('Item Type,Product ID,Product Name,Product Code/SKU,Price,Sale Price\nProduct,10,Parent,PARENT,50.00,\nSKU,11,[RB]Color=Green,00007,40.00,22.00');
    for (const [platform, source] of [['woocommerce', woo], ['bigcommerce', big]] as const) {
      const ready = await buildWholesalePriceList(platform, source, { ...singleOptions, tiers: [{ ...singleOptions.tiers[0], value: '50' }] });
      expect(ready.issues).toEqual([]);
      expect(ready.buyerRows).toEqual([{ sku: '00007', product: platform === 'woocommerce' ? 'Variant' : 'Parent', casePack: '1',
        tiers: [{ tierName: 'Bronze', minOrderQty: '10', unitPrice: '20.00' }] }]);
      expect(cells(ready.shopifyCsv!)[1][1]).toBe('00007');
    }
  });

  it('escapes buyer display text offline, guards buyer cells, and holds unsafe native identifiers', async () => {
    const sku = '<img src=//evil.invalid onerror=go()>';
    const ready = await buildWholesalePriceList('shopify', catalog(sku, '20.00', '=HYPERLINK("https://invalid.test")'),
      { ...singleOptions, brandLabel: '<svg/onload=go()>', shopifyCatalogTitle: 'A catalog' },
      { agencyName: '<script>fetch("https://invalid.test")</script>', preparedFor: '', contactNote: '//invalid.test', accentKey: 'forest' });
    expect(ready.canExport).toBe(true);
    expect(cells(ready.buyerCsv!)[1][1]).toBe("'=HYPERLINK(\"https://invalid.test\")");
    expect(cells(ready.shopifyCsv!)[1][1]).toBe(sku);
    expect(ready.lineSheetHtml).toContain('&lt;img src=&#47;/evil.invalid onerror=go()&gt;');
    expect(ready.lineSheetHtml).toContain('&lt;svg/onload=go()&gt;');
    expect(ready.lineSheetHtml).toContain('script-src \'none\'');
    expect(ready.lineSheetHtml).toContain('@media print');
    expect(ready.lineSheetHtml).not.toMatch(/<script|<svg|<img|\/\/|https?:/i);
    const held = await wholesale({ ...singleOptions, costSheet: undefined, shopifyCatalogTitle: '=B2B' }, catalog('@native'));
    expect(held.issues.map(({ code }) => code)).toEqual(['unsafe-native-catalog-title', 'unsafe-native-sku']);
    expect(held.shopifyCsv).toBeNull();
    expect(held.buyerCsv).toBeNull();
  });
});
