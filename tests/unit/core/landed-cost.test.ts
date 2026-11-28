import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../../src/core/csv';
import { allocateLandedCost, inspectLandedCostSource, type LandedCostOptions } from '../../../src/core/landed-cost/allocator';
import { containerDemoCsv, containerDemoOptions } from '../../../src/core/landed-cost/demo';
import { buildPriceDiff, parseBaseline, parseSupplier, suggestColumns } from '../../../src/core/shopify-price-diff';
import { buildWholesalePriceList } from '../../../src/core/wholesale-pricelist/engine';

const fixture = (name: string) => readFileSync(new URL('../../../fixtures/m27/' + name, import.meta.url));
const bytes = (text: string) => new TextEncoder().encode(text);
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const blankCharges = { ...containerDemoOptions, freightCents: '0', insuranceCents: '0', handlingCents: '0', otherChargesCents: '0' };
const allocateCsv = (text: string, options: Partial<LandedCostOptions> = {}) =>
  allocateLandedCost({ source: { name: 'invoice.csv', bytes: bytes(text) }, options: { ...blankCharges, ...options } });
const invoice = 'SKU,Quantity,FOB Unit Cost,Duty Rate %,Description\n';

function invoiceWorkbook({ textSku = true, numericPercent = true, formula = false } = {}) {
  const rels = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const relationship = (id: string, type: string, path: string) =>
    '<Relationship Id="' + id + '" Type="' + rels + type + '" Target="' + path + '"/>';
  const cellText = (address: string, value: string) => '<c r="' + address + '" t="inlineStr"><is><t>' + value + '</t></is></c>';
  const sheet = '<worksheet><sheetData><row r="3">' +
    ['SKU', 'Quantity', 'FOB Unit Cost', 'Duty Rate %'].map((label, index) => cellText('ABCD'[index] + '3', label)).join('') +
    '</row><row r="9">' + (textSku ? cellText('A9', '00042') : '<c r="A9"><v>42</v></c>') +
    '<c r="B9"><v>3</v></c><c r="C9"><v>11.11</v></c>' +
    (numericPercent ? '<c r="D9" s="1">' + (formula ? '<f>0.0725</f>' : '') + '<v>0.0725</v></c>' : cellText('D9', '0.0725')) +
    '</row></sheetData></worksheet>';
  const sheets = ['Instruction', 'Approved Rates', 'Hidden'];
  return zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': '<Types/>',
    '_rels/.rels': '<Relationships>' + relationship('rId1', 'officeDocument', 'xl/workbook.xml') + '</Relationships>',
    'xl/workbook.xml': '<workbook xmlns:r="' + rels + '"><sheets>' +
      sheets.map((name, index) => '<sheet name="' + name + '" r:id="rId' + (index + 1) +
        '"' + (index === 2 ? ' state="hidden"' : '') + '/>').join('') + '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships>' + sheets.map((_, index) => relationship('rId' + (index + 1), 'worksheet',
      'worksheets/sheet' + (index + 1) + '.xml')).join('') + relationship('rId4', 'styles', 'styles.xml') + '</Relationships>',
    'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="10"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData/></worksheet>',
    'xl/worksheets/sheet2.xml': sheet,
    'xl/worksheets/sheet3.xml': sheet,
  }).map(([path, xml]) => [path, strToU8(xml)])));
}

describe('M27 landed-cost allocation', () => {
  it('matches demo fixture bytes and conserves all four charges and landed extended costs', async () => {
    expect(fixture('container-invoice.csv').toString('utf8').replaceAll('\r\n', '\n')).toBe(containerDemoCsv);
    const value = await allocateCsv(containerDemoCsv, containerDemoOptions);
    expect(value.status).toBe('ready');
    if (value.status !== 'ready') throw new Error(value.files.audit);
    expect(value.totals).toEqual({ fobCents: 8843n, freightCents: 10103n, insuranceCents: 211n, handlingCents: 307n,
      otherChargesCents: 19n, dutyCents: 833n, landedExtendedCents: 20316n, driftCents: 0n });
    expect(Object.values(value.proof).every(({ expected, allocated, drift }) => expected === allocated && drift === 0n)).toBe(true);
    expect(value.rows.at(-1)).toMatchObject({ sku: '00901', landedUnitCost: '5.4418', landedUnitDisplay: '5.44', wholesaleUnitCost: '5.45',
      unitRemainderCents: 2n, landedUnitRatio: { numeratorCents: 5986n, denominator: 11n } });
    const weight = await allocateCsv(containerDemoCsv, { ...containerDemoOptions, method: 'by-weight' });
    expect(weight.totals).toMatchObject({ dutyCents: 993n, landedExtendedCents: 20476n, driftCents: 0n });
  });

  it('uses physical record order for fraction ties and excludes handling and other charges from CIF', async () => {
    const text = invoice + 'Z,1,0.01,50%,"Outer\ninner"\n\nA,1,0.03,50%,Second\n';
    const fob = await allocateCsv(text, { method: 'by-units', dutyBase: 'FOB', freightCents: 1n });
    expect(fob.rows).toMatchObject([{ sku: 'Z', line: 2, freightCents: 1n, dutyBaseCents: 1n, dutyCents: 0n },
      { sku: 'A', line: 5, freightCents: 0n, dutyBaseCents: 3n, dutyCents: 2n }]);
    const cif = await allocateCsv(text, { method: 'by-units', dutyBase: 'CIF', freightCents: '2', insuranceCents: '2',
      handlingCents: '10', otherChargesCents: '8' });
    expect(cif.rows).toMatchObject([{ dutyBaseCents: 3n, dutyCents: 2n, landedExtendedCents: 14n },
      { dutyBaseCents: 5n, dutyCents: 2n, landedExtendedCents: 16n }]);
  });

  it('converts exact extended source FOB once and keeps source-denominated value weights', async () => {
    const text = 'SKU,Quantity,FOB Unit Cost,Currency\n0001,1,0.01,EUR\n0002,1,0.03,EUR';
    const fx = await allocateCsv(text, { sourceCurrency: 'EUR', fxRate: '0.5', freightCents: '3' });
    expect(fx.rows).toMatchObject([{ sourceFobCents: 1n, allocationWeight: 1n, fobCents: 0n, freightCents: 1n },
      { sourceFobCents: 3n, allocationWeight: 3n, fobCents: 2n, freightCents: 2n }]);
    expect(fx.totals).toMatchObject({ fobCents: 2n, landedExtendedCents: 5n });
    const converted = await allocateCsv('SKU,Quantity,FOB Unit Cost\n0001,3,0.01', { sourceCurrency: 'EUR', fxRate: '0.5' });
    expect(converted.rows).toMatchObject([{ sourceFobCents: 3n, fobCents: 2n }]);
    expect((await allocateCsv(text, { sourceCurrency: 'EUR' })).issues).toMatchObject([{ code: 'missing-or-invalid-fx-rate' }]);
    expect((await allocateCsv(text, { sourceCurrency: 'EUR', fxRate: '0' })).issues).toMatchObject([{ code: 'missing-or-invalid-fx-rate' }]);
    expect((await allocateCsv(text, { fxRate: '1' })).issues.map(issue => issue.code)).toContain('unnecessary-fx-rate');
  });

  it('withholds artifacts and retains every physical duplicate and invalid row or charge', async () => {
    const text = invoice + '0001,1,2.50,,"first\ncontinuation"\n\n0001,0,1.005,-0.01,Second\n0001,1.5,-1,200.01,Third\n';
    const value = await allocateCsv(text, { insuranceCents: '-1', freightCents: '1.5', handlingCents: 1.5 });
    expect(value.status).toBe('blocked');
    expect(Object.keys(value.files)).toEqual(['audit']);
    expect(value.issues.filter(({ code }) => code === 'duplicate-sku')).toEqual([
      { code: 'duplicate-sku', sku: '0001', line: 2, lines: [2, 5, 6], column: 'SKU', message: 'This SKU occurs on lines 2, 5, 6.' },
    ]);
    for (const line of [5, 6]) expect(value.issues.filter(issue => issue.line === line).map(({ code }) => code))
      .toEqual(['invalid-quantity', 'invalid-fob-unit-cost', 'invalid-duty-rate']);
    expect(value.issues.filter(({ code }) => code === 'invalid-shared-charge')).toHaveLength(3);
    expect(JSON.parse(value.files.audit).custody).toEqual({ sourceSha256: digest(bytes(text)) });
    const bareQuote = await allocateCsv(invoice + '0001,1,2.50,,Bare"Quote');
    expect(bareQuote.issues).toMatchObject([{ code: 'invalid-csv', line: 2 }]);
    expect(await allocateCsv(invoice + '0001,1,2.50,,"Bare""Quote"')).toMatchObject({ status: 'ready' });
  });

  it('uses exact visible XLSX selection and distinguishes Excel percentage cells from plain text', async () => {
    const source = { name: 'invoice.xlsx', bytes: invoiceWorkbook() };
    expect(inspectLandedCostSource(source).worksheetNames).toEqual(['Instruction', 'Approved Rates']);
    for (const sheetName of [undefined, 'approved rates', 'Hidden']) {
      expect((await allocateLandedCost({ source: { ...source, sheetName }, options: blankCharges })).issues)
        .toMatchObject([{ code: 'invalid-invoice-worksheet' }]);
    }
    const result = await allocateLandedCost({ source: { ...source, sheetName: 'Approved Rates' }, options: blankCharges });
    expect(result.rows).toMatchObject([{ sku: '00042', line: 9, dutyRateBps: 725n, dutyCents: 242n }]);
    for (const [workbookOptions, code] of [
      [{ textSku: false }, 'invalid-sku'], [{ numericPercent: false }, 'invalid-duty-rate'], [{ formula: true }, 'invalid-duty-rate'],
    ] as const) {
      const test = await allocateLandedCost({ source: { ...source, bytes: invoiceWorkbook(workbookOptions), sheetName: 'Approved Rates' },
        options: blankCharges });
      expect(test.issues).toMatchObject([{ code, line: 9 }]);
      expect(Object.keys(test.files)).toEqual(['audit']);
    }
  });

  it('hashes exact output bytes, protects CSV cells and escapes branded offline HTML without mutating SKU', async () => {
    const name = 'Invoice <&>.csv';
    const text = invoice + '0007,3,1.00,,"=HYPERLINK(""https://example.invalid"") <script>boom</script>"';
    const result = await allocateLandedCost({ source: { name, bytes: bytes(text) }, options: { ...blankCharges, branding: {
      agencyName: 'Dock <&> Studio', preparedFor: 'Offline Buyer', contactNote: '//example.invalid/account', accentKey: 'navy',
    } } });
    if (result.status !== 'ready') throw new Error(result.files.audit);
    const { csv, html, audit } = result.files;
    const record = parseCsv(csv).records[1];
    expect(record.cells[0]).toBe('0007');
    expect(record.cells.at(-1)).toBe('\'=HYPERLINK("https://example.invalid") <script>boom</script>');
    expect(csv).toContain('\r\n');
    expect(html).toContain('Dock &lt;&amp;&gt; Studio');
    expect(html).toContain('Invoice &lt;&amp;&gt;.csv');
    expect(html).toContain('&lt;script&gt;boom&lt;/script&gt;');
    expect(html).toContain("script-src 'none'; connect-src 'none'");
    expect(html).not.toMatch(/<script|https?:|\/\/|\b(?:src|href)=/i);
    expect(JSON.parse(audit)).toMatchObject({ custody: { sourceSha256: digest(bytes(text)), csvSha256: digest(bytes(csv)), htmlSha256: digest(bytes(html)) },
      formulaGuard: { neutralized: [{ column: 'Description', row: 2 }] } });
    expect((await allocateCsv(invoice + '=0007,3,1.00,,Formula identifier')).issues).toMatchObject([{ code: 'unsafe-sku', line: 2 }]);
  });

  it('passes the same generated CSV bytes through Price Diff and Wholesale as their respective supplier costs', async () => {
    const allocation = await allocateCsv(containerDemoCsv, containerDemoOptions);
    if (allocation.status !== 'ready') throw new Error(allocation.files.audit);
    const landedCsv = bytes(allocation.files.csv);
    const baselineBytes = fixture('container-store.csv');
    const baseline = parseBaseline(baselineBytes);
    const [supplier] = parseSupplier(landedCsv, 'shipment-landed-cost.csv').sheets;
    const suggestions = suggestColumns(baseline, supplier);
    expect(supplier.headers[suggestions.selection.priceColumn!]).toBe('Landed Unit Cost');
    expect(suggestions.requiresConfirmation).toBe(true);
    expect(buildPriceDiff(baseline, supplier).issues.map(({ code }) => code)).toContain('mapping-confirmation-required');
    const diff = buildPriceDiff(baseline, supplier, { confirmed: true, sameCurrencyConfirmed: true,
      pricingRule: { mode: 'multiplier', multiplier: '2' }, dropThresholdPercent: 100 });
    expect(diff.issues).toEqual([]);
    expect(diff.rows.find(row => row.sku === '00901')).toMatchObject({ supplierRow: 4, landedCost: '5.4418', newPrice: '10.88' });
    const wholesale = await buildWholesalePriceList('shopify', baselineBytes, {
      brandLabel: 'Container Co', currency: 'USD', effectiveDate: '2026-11-28', shopifyCatalogTitle: 'Container Trade', shopifyTierName: 'Trade',
      tiers: [{ tierName: 'Trade', discountMode: 'cost-plus-percent', value: '100', minOrderQty: '1', rounding: 'none' }], costSheet: landedCsv,
    });
    expect(wholesale.issues).toEqual([]);
    expect(wholesale.canExport).toBe(true);
    expect(wholesale.rows.find(row => row.sku === '00901')).toMatchObject({ costLine: 4, landedCost: '5.45', tiers: [{ unitPrice: '10.90' }] });
  });
});
