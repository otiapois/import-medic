import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { auditCatalogHygiene, validateGtin, type CatalogHygieneSource } from '../../../src/core/catalog-hygiene/engine';
import { decodeCsv, parseCsv, serializeCsvRecords } from '../../../src/core/csv';
import { offlineReportCsp } from '../../../src/core/report-html';

const utf8 = new TextEncoder();
const utf8Text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fixture = (filename: string) => ({ filename, platform: 'shopify' as const,
  bytes: readFileSync(new URL('../../../fixtures/m25/' + filename, import.meta.url)) });
const table = (bytes: Uint8Array) => parseCsv(decodeCsv(bytes).text).records.map(({ cells }) => cells);
const shopify = (rows: string[][], barcode = 'Variant Barcode', filename = 'catalog.csv'): CatalogHygieneSource => ({
  platform: 'shopify', filename, bytes: utf8.encode(serializeCsvRecords([
    ['Handle', 'Title', 'Variant SKU', 'Variant Price', barcode, 'Body (HTML)'], ...rows,
  ], 'shopify-products') + '\n'),
});

describe('Catalog & Barcode Hygiene', () => {
  it('validates exact GS1 strings without accepting coercion or partial matches', () => {
    for (const number of ['96385074', '012345678905', '4006381333931', '00012345678905']) {
      expect(validateGtin(number)).toEqual({ valid: true, expectedCheckDigit: number.at(-1), suppliedCheckDigit: number.at(-1) });
    }
    expect(validateGtin('4006381333932')).toEqual({ valid: false, expectedCheckDigit: '1', suppliedCheckDigit: '2' });
    for (const value of [12_345_678, 12345678n, '９６３８５０７４', '012345678905\n', ' 96385074', '9638 5074', '096385074']) {
      expect(validateGtin(value)).toEqual({ valid: false, expectedCheckDigit: null, suppliedCheckDigit: null });
    }
  });

  it('reparses the scoped Shopify cleanup and hashes every actual report and CSV', async () => {
    const source = fixture('shopify-ready.csv');
    const { status, summary, sources, issues, artifacts } = await auditCatalogHygiene([source], {
      trimSkus: true, stripZeroWidth: true,
      branding: { agencyName: '<img src=https://example.test/>', preparedFor: 'Aurora', contactNote: '//example.test/contact', accentKey: 'navy' },
    });
    expect(status).toBe('READY');
    expect(summary).toEqual({ scannedRows: 3, invalidBarcodes: 0, duplicateSkus: 0, safeTrimFixes: 1, safeZeroWidthFixes: 1, blockingIssues: 0 });
    expect(issues).toEqual([
      expect.objectContaining({ code: 'trim-sku', level: 'fixed', line: 2, sourceIndex: 1, value: ' AURORA-01 ', after: 'AURORA-01' }),
      expect.objectContaining({ code: 'strip-zero-width', level: 'fixed', line: 2, sourceIndex: 1, value: '01234\u200b5678905', after: '012345678905' }),
    ]);
    const [{ cleanedCsv, rollbackCsv }] = artifacts.catalogs;
    expect(cleanedCsv.filename).toBe('catalog-hygiene-source-1-cleaned.csv');
    expect(rollbackCsv.bytes).toEqual(Uint8Array.from(source.bytes));
    const expected = table(source.bytes);
    expected[1][2] = 'AURORA-01';
    expected[1][4] = '012345678905';
    expect(table(cleanedCsv.bytes)).toEqual(expected);
    const html = utf8Text(artifacts.reportHtml.bytes);
    expect(html).toContain(offlineReportCsp);
    expect(html).toContain('Prepared by <strong>&lt;img src=https&#58;&#47;/example.test/&gt;</strong>');
    expect(html).toContain('&#47;/example.test/contact');
    expect(html).toContain('01234\\u200b5678905');
    expect(html).not.toMatch(/<(?:img|script|link)|\bhttps?:/i);
    expect(html).toContain(digest(source.bytes));
    const audit = JSON.parse(utf8Text(artifacts.auditJson.bytes));
    expect(audit.sources).toEqual(sources);
    expect(sources[0]).toMatchObject({ sourceIndex: 1, byteLength: source.bytes.length, sha256: digest(source.bytes) });
    expect(audit.custody.outputs).toEqual([artifacts.issuesCsv, artifacts.reportHtml, cleanedCsv, rollbackCsv].map(({ filename, bytes }) =>
      ({ filename, byteLength: bytes.length, sha256: digest(bytes) })));
  });

  it('holds erroneous IDs and cross-length duplicate barcodes, with quoted multiline and blank-line citations', async () => {
    const result = await auditCatalogHygiene([fixture('shopify-hold.csv'), fixture('shopify-ready.csv')], { trimSkus: true, stripZeroWidth: true });
    expect(result.status).toBe('HOLD');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid-gtin-check-digit', sourceIndex: 1, line: 2, expectedCheckDigit: '1', suppliedCheckDigit: '2' }),
      expect.objectContaining({ code: 'duplicate-sku-case', sourceIndex: 1, line: 2, related: [{ sourceIndex: 1, line: 5 }] }),
      expect.objectContaining({ code: 'duplicate-gtin', sourceIndex: 1, line: 5,
        related: [{ sourceIndex: 1, line: 6 }, { sourceIndex: 2, line: 2 }] }),
      expect.objectContaining({ code: 'trim-sku', level: 'warning', sourceIndex: 2, line: 2, after: 'AURORA-01' }),
    ]));
    expect(result.summary).toMatchObject({ invalidBarcodes: 1, safeTrimFixes: 0, safeZeroWidthFixes: 0 });
    expect(result.artifacts.catalogs).toEqual([]);
    expect(JSON.parse(utf8Text(result.artifacts.auditJson.bytes)).custody.outputs.map(({ filename }: { filename: string }) => filename))
      .toEqual(['catalog-hygiene-issues.csv', 'catalog-hygiene-report.html']);
  });

  it('detects exact, case and projected collisions between sources even when opt-ins are disabled', async () => {
    const first = shopify([['first', 'First', 'MIXED', '1.00', '', 'one\nsecond'], [''], ['plain', 'Plain', '123', '10', '', '']]);
    const second = shopify([['second', 'Second', ' mixed ', '1', '', ''], ['other', 'Other', '123', '1', '', ''],
      ['third', 'Third', 'MIXED', '1', '', ''], ['fourth', 'Fourth', 'mixed', '1', '', '']]);
    const { status, issues, summary } = await auditCatalogHygiene([first, second]);
    expect(status).toBe('HOLD');
    expect(summary.duplicateSkus).toBe(6);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate-sku-exact', sourceIndex: 1, line: 5, related: [{ sourceIndex: 2, line: 3 }] }),
      expect.objectContaining({ code: 'duplicate-sku-case', sourceIndex: 1, line: 2, related: [{ sourceIndex: 2, line: 4 }, { sourceIndex: 2, line: 5 }] }),
      expect.objectContaining({ code: 'duplicate-sku-cleanup', sourceIndex: 1, line: 2,
        related: [{ sourceIndex: 2, line: 2 }, { sourceIndex: 2, line: 4 }, { sourceIndex: 2, line: 5 }] }),
    ]));
  });

  it('keeps whitespace and zero-width consent independent and preserves legitimate description joiners', async () => {
    const text = 'می\u200cروم 👩\u200d💻';
    const source = shopify([['sku', 'SKU', '\u00a0\ufeff00014 ', '1', '', text]]);
    const trimOnly = await auditCatalogHygiene([source], { trimSkus: true });
    expect(trimOnly).toMatchObject({ status: 'HOLD', issues: [expect.objectContaining({ code: 'embedded-control', column: 'Variant SKU' })] });
    const strip = await auditCatalogHygiene([source], { stripZeroWidth: true });
    expect(strip.status).toBe('READY');
    expect(table(strip.artifacts.catalogs[0].cleanedCsv.bytes)[1]).toEqual(['sku', 'SKU', '\u00a000014 ', '1', '', text]);
    const both = await auditCatalogHygiene([source], { trimSkus: true, stripZeroWidth: true });
    expect(both.issues.map(({ after }) => after)).toEqual(['00014', '00014']);
    expect(table(both.artifacts.catalogs[0].cleanedCsv.bytes)[1][2]).toBe('00014');
    const softHyphen = await auditCatalogHygiene([shopify([['sku', 'SKU', '000\u00ad14', '1', '', text]])], { stripZeroWidth: true });
    expect(softHyphen).toMatchObject({ status: 'HOLD', issues: [expect.objectContaining({ code: 'embedded-control', value: '000\u00ad14' })] });
  });

  it('holds scientific values, formula activation, embedded controls and invalid, zero or negative prices', async () => {
    const source = shopify([
      ['bad', 'Scientific', '8.90123E+12', '1E2', '8.90123E+12', 'one\r\nsecond'],
      ['zero', 'Zero', '  \u200b=SUM(1+1)', '00.0000', '', ''],
      ['negative', 'Negative', 'raw\0id', '-0.01', '012345\n678905', 'cell\x01'],
    ], 'Variant Barcode', '@evil.csv');
    const { status, issues, artifacts } = await auditCatalogHygiene([source], { trimSkus: true, stripZeroWidth: true });
    expect(status).toBe('HOLD');
    const has = (code: string, line: number, column: string) => expect(issues).toContainEqual(expect.objectContaining({ code, line, column }));
    has('scientific-sku', 2, 'Variant SKU');
    has('scientific-barcode', 2, 'Variant Barcode');
    has('invalid-retail-price', 2, 'Variant Price');
    has('spreadsheet-formula', 4, 'Variant SKU');
    has('zero-retail-price', 4, 'Variant Price');
    has('embedded-control', 5, 'Variant SKU');
    has('embedded-control', 5, 'Variant Barcode');
    has('embedded-control', 5, 'Body (HTML)');
    has('negative-retail-price', 5, 'Variant Price');
    const rows = table(artifacts.issuesCsv.bytes);
    expect(rows.slice(1).every(row => row[1] === "'@evil.csv")).toBe(true);
    expect(rows.find(row => row[5] === 'spreadsheet-formula')?.[6]).toBe("'  \\u200b=SUM(1+1)");
    expect(utf8Text(artifacts.issuesCsv.bytes).split('\r\n')[0]).toContain('Physical line');
  });

  it('preserves typed Shopify lists, including escapes and unsupported types, while checking their GS1 values', async () => {
    const raw = String.raw`gtin:01234` + '\u200b' + String.raw`5678905; ean:96385074; UPC:01234565; isbn:123456789X; custom:A\;B\:C\\D; 4006381333931`;
    const source = shopify([['one', 'One', 'SKU-01', '1', raw, '']], 'Barcodes');
    const ready = await auditCatalogHygiene([source], { stripZeroWidth: true });
    expect(ready.status).toBe('READY');
    expect(ready.issues.filter(({ code }) => code === 'barcode-outside-gs1-scope')).toHaveLength(3);
    expect(table(ready.artifacts.catalogs[0].cleanedCsv.bytes)[1][4]).toBe(raw.replace('\u200b', ''));
    const bad = shopify([
      ['one', 'One', 'SKU-01', '1', 'gtin:012345678904; 4006381333932; ean:012345678905', ''],
      ['two', 'Two', 'SKU-02', '2', 'gtin:012345678905; bad\\q', ''],
    ], 'Barcodes');
    const held = await auditCatalogHygiene([bad]);
    expect(held.summary.invalidBarcodes).toBe(2);
    expect(held.issues.map(({ code, line }) => [code, line])).toEqual([
      ['invalid-gtin-check-digit', 2], ['invalid-gtin-check-digit', 2], ['invalid-gtin-format', 2], ['invalid-barcode-list', 3],
    ]);
    const dual = { ...bad, bytes: utf8.encode('Handle,Title,SKU,Price,Barcodes,Barcode\none,One,SKU,1,gtin:012345678905,012345678905\n') };
    expect((await auditCatalogHygiene([dual])).issues).toContainEqual(expect.objectContaining({ code: 'ambiguous-barcode-column', line: 1 }));
  });

  it('preserves WooCommerce relationships and holds a cleanup that would break or activate a native SKU reference', async () => {
    const woo = (parent: string, includeChild = true): CatalogHygieneSource => ({ platform: 'woocommerce', filename: 'woo.csv', bytes: utf8.encode(
      'ID,Type,SKU,Name,Regular price,Parent,"GTIN, UPC, EAN, or ISBN"\r\n' +
      '1,variable," RACK ",Rack,,,\r\n' + (includeChild ? '2,variation,SLIM,Slim Rack,15,' + parent + ',012345678905\r\n' : ''),
    ) });
    const bySku = await auditCatalogHygiene([woo('RACK')], { trimSkus: true });
    expect(bySku.issues).toContainEqual(expect.objectContaining({ code: 'referenced-sku-cleanup', line: 2, related: [{ sourceIndex: 1, line: 3 }] }));
    expect(bySku.artifacts.catalogs).toEqual([]);
    const byIdSource = woo('id:1');
    const byId = await auditCatalogHygiene([byIdSource], { trimSkus: true });
    expect(byId.status).toBe('READY');
    expect(table(byId.artifacts.catalogs[0].cleanedCsv.bytes).at(-1)?.[5]).toBe('id:1');
    const child = { ...byIdSource, bytes: utf8.encode(utf8Text(byIdSource.bytes).replace('1,variable," RACK ",Rack,,,\r\n', '').replace('id:1', 'RACK')) };
    const cross = await auditCatalogHygiene([woo('', false), child], { trimSkus: true });
    expect(cross.issues).toContainEqual(expect.objectContaining({
      code: 'referenced-sku-cleanup', sourceIndex: 1, line: 2, related: [{ sourceIndex: 2, line: 2 }],
    }));
  });

  it('retains BigCommerce Product, SKU and Rule rows and protects rule links', async () => {
    const legacy = (sku: string): CatalogHygieneSource => ({ platform: 'bigcommerce', filename: 'legacy.csv', bytes: utf8.encode(
      'Item Type,Product ID,Product Name,Product Code/SKU,Price,Product UPC/EAN\r\n' +
      'Product,16,Trail Flask,FLASK,25,\r\nSKU,17,[S]Color=Blue,' + sku + ',,012345678905\r\nRule,18,,FLASK-BLUE,,\r\n',
    ) });
    const source = legacy('FLASK-BLUE');
    const ready = await auditCatalogHygiene([source]);
    expect(ready).toMatchObject({ status: 'READY', issues: [], summary: { scannedRows: 3 } });
    expect(table(ready.artifacts.catalogs[0].cleanedCsv.bytes)).toEqual(table(source.bytes));
    const held = await auditCatalogHygiene([legacy('" FLASK-BLUE "')], { trimSkus: true });
    expect(held.issues).toContainEqual(expect.objectContaining({
      code: 'referenced-sku-cleanup', line: 3, related: [{ sourceIndex: 1, line: 4 }],
    }));
  });

  it('exports byte-identical rollbacks for different encodings and mixed record separators', async () => {
    const input = '\r\nHandle,Title,SKU,Price,Barcode\r\n' +
      'coffee,"Café ""house""\rsecond line"," 007 ",5.00,012345678905\n\r';
    const inputs = [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(input)]),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(input, 'utf16le')]),
      Buffer.from(input, 'latin1'),
    ];
    for (const bytes of inputs) {
      const result = await auditCatalogHygiene([{ filename: 'coffee.csv', platform: 'shopify', bytes }], { trimSkus: true });
      expect(result.status, JSON.stringify(result.issues)).toBe('READY');
      const [{ cleanedCsv, rollbackCsv }] = result.artifacts.catalogs;
      expect(rollbackCsv.bytes).toEqual(Uint8Array.from(bytes));
      expect(table(cleanedCsv.bytes)).toEqual([
        [''], ['Handle', 'Title', 'SKU', 'Price', 'Barcode'], ['coffee', 'Café "house"\rsecond line', '007', '5.00', '012345678905'], [''],
      ]);
    }
  });
});
