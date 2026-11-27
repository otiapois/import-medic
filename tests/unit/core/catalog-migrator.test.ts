import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCatalogMigration } from '../../../src/core/catalog-migrator/engine';
import { decodeCsv, parseCsv, serializeCsv } from '../../../src/core/csv';
import { buildPriceDiff, parseSupplier, suggestColumns } from '../../../src/core/shopify-price-diff';
import { parseWooCommerceBaseline } from '../../../src/core/woocommerce-price-diff';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL('../../../fixtures/catalog-migrator/' + name + '.csv', import.meta.url)));
const bytes = (value: string) => new TextEncoder().encode(value);
const platforms = ['shopify', 'woocommerce', 'bigcommerce'] as const;
const directions = platforms.flatMap(source => platforms.filter(target => source !== target).map(target => [source, target] as const));
const hex = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const records = (value: Uint8Array) => {
  const [header, ...rows] = parseCsv(decodeCsv(value).text).records;
  return rows.map(row => Object.fromEntries(header.cells.map((column, i) => [column, row.cells[i]])));
};

describe('catalog migration', () => {
  it.each(directions)('verifies actual native CSV bytes, identities, and exact prices from %s to %s', async (source, target) => {
    const original = fixture(source + '-canvas');
    const result = await buildCatalogMigration(source, target, original, source + '-canvas.csv');
    expect(result.issues.filter(issue => issue.level === 'blocked')).toEqual([]);
    const targetCsv = result.artifacts.targetCsv!;
    expect(targetCsv.filename).toBe('migrated-' + source + '-to-' + target + '.csv');
    expect(result.summary).toEqual(source === 'bigcommerce' ? {
      sourceProducts: 2, sourceVariants: 3, targetProducts: 2, targetVariants: 3, variantParity: true,
    } : { sourceProducts: 1, sourceVariants: 2, targetProducts: 1, targetVariants: 2, variantParity: true });
    const targetRows = records(targetCsv.bytes);
    const first = targetRows.find(row => (row.SKU ?? row['Variant SKU']) === '00123');
    const second = targetRows.find(row => (row.SKU ?? row['Variant SKU']) === '0045-A');
    const sale = source === 'bigcommerce' ? '' : '18.50';
    if (target === 'shopify') {
      expect(first).toMatchObject({ Handle: 'canvas-weekender', 'Variant Price': sale || '24.99',
        'Variant Compare At Price': sale ? '24.99' : '', 'Variant Inventory Qty': '7', 'Option1 Name': 'Color', 'Option2 Name': 'Size' });
      expect(second).toMatchObject({ 'Variant Price': '25.00', 'Option1 Value': 'Sand' });
    } else if (target === 'woocommerce') {
      expect(first).toMatchObject({ ID: '', Parent: 'canvas-weekender', Type: 'variation', 'Regular price': '24.99', 'Sale price': sale, Stock: '7' });
      expect(second).toMatchObject({ ID: '', Parent: 'canvas-weekender', 'Regular price': '25.00', Stock: '0', 'Attribute 1 value(s)': 'Sand' });
    } else {
      expect(result.targetDialect).toBe('bigcommerce-modern');
      expect(first).toMatchObject({ Item: 'Variant', ID: '', Name: '', Price: '24.99', 'Sale Price': sale, 'Current Stock': '7',
        Options: 'Type=Dropdown|Name=Color|Value=Indigo\nType=Dropdown|Name=Size|Value=Carry-on' });
      expect(second).toMatchObject({ Item: 'Variant', ID: '', Price: '25.00', 'Current Stock': '0', Weight: '900' });
    }
    const html = decodeCsv(result.artifacts.signOffHtml.bytes).text;
    expect(result.custody).toEqual({ sourceSha256: hex(original), targetSha256: hex(targetCsv.bytes), signOffSha256: hex(result.artifacts.signOffHtml.bytes) });
    expect(JSON.parse(decodeCsv(result.artifacts.auditJson.bytes).text).custody).toEqual(result.custody);
    expect(html).toContain(result.custody.sourceSha256);
    expect(html).toContain(result.custody.targetSha256);
    expect(html).toContain("default-src 'none'; script-src 'none'; connect-src 'none'");
    expect(html).not.toMatch(/\b(?:src|href)=|<script|https?:\/\//i);
    expect(result.mapping.map(field => field.source)).toEqual(parseCsv(decodeCsv(original).text).records[0].cells);
  });

  it('reopens Shopify → WooCommerce creation rows in both migration and existing Build Update', async () => {
    const incoming = fixture('shopify-canvas');
    const woo = await buildCatalogMigration('shopify', 'woocommerce', incoming);
    expect(woo.unmappedColumns).toEqual(['Handle', 'Custom label', 'Image Src']);
    expect(woo.issues).toContainEqual(expect.objectContaining({ code: 'omitted-image-row', line: 5, level: 'disclosure' }));
    const targetByteStream = woo.artifacts.targetCsv!.bytes;
    const baseline = parseWooCommerceBaseline(targetByteStream);
    expect(baseline.variants.map(variant => [variant.sku, variant.price, variant.compareAtPrice])).toEqual([
      ['canvas-weekender', '', ''], ['00123', '24.99', '18.50'], ['0045-A', '25.00', ''],
    ]);
    expect(baseline.issues).toMatchObject([{ code: 'woo-needs-destination-ids', blocking: true }]);
    const supplier = parseSupplier(bytes('SKU,Price\n00123,22.99\n0045-A,25.00'), 'agency.csv').sheets[0];
    const suggestion = suggestColumns(baseline, supplier);
    expect(suggestion.skuColumns).toEqual([0]);
    const comparison = buildPriceDiff(baseline, supplier, { confirmed: true, joinKey: 'sku', skuColumn: 0, priceColumn: 1, dropThresholdPercent: 100 });
    expect(comparison.rows.find(row => row.sku === '00123')).toMatchObject({ oldPrice: '24.99', newPrice: '22.99' });
    expect(comparison.updateCsv).toBeNull();
    expect(comparison.rollbackCsv).toBeNull();
    const big = await buildCatalogMigration('woocommerce', 'bigcommerce', targetByteStream);
    expect(big.issues.filter(issue => issue.level === 'blocked')).toEqual([]);
    expect(big.summary.variantParity).toBe(true);
    const mixed = decodeCsv(targetByteStream).text.replace('\r\n,variable,', '\r\n77,variable,');
    expect(parseWooCommerceBaseline(bytes(mixed)).issues.map(issue => issue.code)).toEqual(['invalid-woo-id', 'invalid-woo-id']);
  });

  it('keeps stable bytes, escapes the offline HTML, and publishes only source custody on hold', async () => {
    const raw = decodeCsv(fixture('shopify-canvas')).text.replace('Custom label', '<img src="https://example.invalid">')
      .replace('18.50,24.99', '25.00,24.99');
    const input = bytes(raw);
    const run = () => buildCatalogMigration('shopify', 'woocommerce', input, '<script>https://bad.example/</script>');
    const [first, second] = await Promise.all([run(), run()]);
    expect(first.artifacts).toEqual(second.artifacts);
    expect(first.preview).toBeNull();
    expect(first.artifacts.targetCsv).toBeNull();
    expect(first.custody.targetSha256).toBeUndefined();
    expect(first.issues).toContainEqual(expect.objectContaining({ code: 'inverted-price', line: 2, column: 'Variant Compare At Price' }));
    const html = decodeCsv(first.artifacts.signOffHtml.bytes).text;
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=');
    expect(html).not.toMatch(/<script>|<img\b|https?:\/\//);
  });

  it.each([
    ['shopify', 'woocommerce', 'unsafe-sku', (csv: string) => csv.replace('0045-A', '\t=CMD')],
    ['shopify', 'bigcommerce', 'duplicate-sku', (csv: string) => csv.replace('0045-A', '00123')],
    ['woocommerce', 'shopify', 'orphan-variation', (csv: string) => csv.replace('id:51', 'id:999')],
    ['bigcommerce', 'shopify', 'unsupported-legacy-rule', (csv: string) => csv.replace('[FIXED]25.00', '[ADD]5%')],
    ['bigcommerce', 'woocommerce', 'conflicting-legacy-rule', (csv: string) => csv.replace('[FIXED]25.00', '[FIXED]26.00')],
  ] as const)('holds an unsafe %s to %s conversion with %s', async (source, target, code, change) => {
    const original = decodeCsv(fixture(source + '-canvas')).text;
    const result = await buildCatalogMigration(source, target, bytes(change(original)));
    expect(result.issues).toContainEqual(expect.objectContaining({ code, level: 'blocked', line: expect.any(Number) }));
    expect(result.artifacts.targetCsv).toBeNull();
  });

  it('holds a scheduled sale on its exact source line', async () => {
    const [header, ...rows] = parseCsv(decodeCsv(fixture('woocommerce-canvas')).text).records;
    const input = bytes(serializeCsv([...header.cells, 'Date sale price starts'],
      rows.map((row, i) => [...row.cells, i === 1 ? '2028-01-01' : '']), 'woocommerce'));
    const result = await buildCatalogMigration('woocommerce', 'bigcommerce', input);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'scheduled-sale', level: 'blocked', line: 3 }));
    expect(result.artifacts.targetCsv).toBeNull();
  });

  it('reads real BigCommerce swatches and option separators, retaining labels and disclosing presentation', async () => {
    const input = bytes(serializeCsv(['Item', 'ID', 'Type', 'Name', 'SKU', 'Options', 'Price', 'Is Visible', 'Product URL'], [
      ['Product', '51', 'digital', 'Download', 'download', '', '9.99', 'true', '/download/'],
      ['Variant', '52', '', '', '0001', 'Type=Swatch|Name=Color|Value=Blue[#0000FF;#CAFEED]Type=Radio|Name=Size|Value=M', '9.99', '', ''],
    ], 'bigcommerce'));
    const result = await buildCatalogMigration('bigcommerce', 'shopify', input);
    expect(result.summary.variantParity).toBe(true);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'omitted-swatch-config', line: 3, level: 'disclosure' }));
    expect(records(result.artifacts.targetCsv!.bytes)).toMatchObject([{ 'Option1 Value': 'Blue', 'Option2 Value': 'M', 'Variant SKU': '0001' }]);
  });

  it('uses private for a Shopify active product withheld from its online store', async () => {
    const input = bytes('Handle,Title,Variant SKU,Variant Price,Status,Published\nitem,Item,001,89.85,active,FALSE');
    const result = await buildCatalogMigration('shopify', 'woocommerce', input);
    expect(records(result.artifacts.targetCsv!.bytes)).toMatchObject([{ Published: '0', 'Visibility in catalog': 'hidden' }]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'lossy-status', line: 2, level: 'disclosure' }));
  });

  it('blocks exact source rows for an absent physical weight and a shared stock pool that Shopify cannot preserve', async () => {
    const thin = bytes('Handle,Title,Variant SKU,Variant Price,Variant Requires Shipping\nitem,Item,001,89.85,TRUE');
    const missing = await buildCatalogMigration('shopify', 'bigcommerce', thin);
    expect(missing.issues).toContainEqual(expect.objectContaining({ code: 'missing-bigcommerce-weight', line: 2, column: 'Weight' }));
    const header = ['ID', 'Type', 'SKU', 'Name', 'Parent', 'Regular price', 'Sale price', 'Stock', 'Attribute 1 name', 'Attribute 1 value(s)'];
    const source = bytes(serializeCsv(header, [
      ['1', 'variable', 'umbrella', 'Umbrella', '', '', '', '8', 'Color', 'Red, Blue'],
      ['2', 'variation', '0001', 'Umbrella', 'id:1', '4.20', '', 'parent', 'Color', 'Red'],
      ['3', 'variation', '0002', 'Umbrella', 'id:1', '4.20', '', 'parent', 'Color', 'Blue'],
    ], 'woocommerce'));
    const shared = await buildCatalogMigration('woocommerce', 'shopify', source);
    expect(shared.issues.filter(issue => issue.code === 'unrepresentable-shared-stock').map(issue => issue.line)).toEqual([3, 4]);
    expect(shared.artifacts.targetCsv).toBeNull();
  });

  it('rejects a same-platform conversion and reports invalid bytes without downloads', async () => {
    const invalid = new Uint8Array([0xfe, 0xff, 0x00, 0x41]);
    const result = await buildCatalogMigration('bigcommerce', 'bigcommerce', invalid);
    expect(result.issues.map(issue => issue.code)).toEqual(['invalid-encoding', 'same-platform']);
    expect(result.artifacts.targetCsv).toBeNull();
  });
});
