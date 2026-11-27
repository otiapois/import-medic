import { expect } from '@playwright/test';
import { csv, parseCsv } from './m7-files';

export const platforms = ['Shopify', 'WooCommerce', 'BigCommerce'] as const;
export type Platform = (typeof platforms)[number];
const literalSku = 'PROMO-002<em>QA</em>';
const wooSku = 'PROMO-002 & QA';
const first = 'PROMO-001';
const low = 'PROMO-LOW';

const shopId = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU'];
const wooId = ['ID', 'Type', 'SKU', 'Parent'];
const bigId = ['Item Type', 'Product ID', 'Product Name', 'Product Code/SKU'];
const shopPrice = 'Variant Price';
const compare = 'Variant Compare At Price';

// Each matrix includes source-only catalog data that must survive both native imports.
const baselines: Record<Platform, string[][]> = {
  Shopify: [
    [...shopId, shopPrice, compare, 'Cost per item', 'Price / UAE', 'Body (HTML)', 'Tags', 'Image Src'],
    ['tote', '  Travel Tote  ', 'Size', 'Small', first, '0100.000', '0120.00', '83.00', '400.50', '<p>Keep, exactly</p>', 'travel,summer', 'first.jpg'],
    ['tote', '', '', 'Large', low, '12.00', '', '4.01', '44.50', '', '', ''],
    ['mug', 'Mug', 'Title', 'Default Title', literalSku, '075.500', '', '40.00', '', 'Keep mug description', 'summer', 'mug.jpg'],
    ['others', 'Travel case', 'Title', 'Default Title', 'KEEP-009', '029.500', '', '10.00', '100.00', 'Original\r\nsecond line', 'travel', 'case.jpg'],
  ],
  WooCommerce: [
    [...wooId, 'Name', 'Regular price', 'Sale price', 'Description', 'Images', 'Meta:source', 'Stock'],
    ['1000', 'variable', 'PARENT', '', 'Shirt', '', '', 'Keep, unchanged', '', 'local', ''],
    ['1001', 'variation', first, 'id:1000', 'Small', '0100.000', '095.100', 'Small product', '', 'small', '0008'],
    ['1002', 'variation', low, 'PARENT', 'Large', '12.00', '', 'Large product', '', 'large', '0004'],
    ['1003', 'simple', wooSku, '', 'Mug', '075.500', '', 'Mug copy', 'mug.jpg', 'original', '0005'],
    ['1004', 'simple', 'KEEP-009', '', 'Case', '029.500', '', 'Original\r\nsecond line', 'case.jpg', 'case', '0002'],
  ],
  BigCommerce: [
    [...bigId, 'Price', 'Sale Price', 'Product Description', 'Category', 'Meta Keywords', 'Current Stock Level'],
    ['Product', '101', 'Linen shirt', first, '0100.000', '095.100', 'Keep, exactly', 'Apparel', 'linen', '0008'],
    ['Product', '102', 'Canvas pouch', low, '12.00', '', 'Keep original copy', 'Travel', 'pouch', '0005'],
    ['Product', '103', 'Mug', literalSku, '085.500', '075.500', 'Keep mug', 'Home', 'mug', '0004'],
    ['Product', '200', 'Travel case', 'KEEP-009', '029.500', '', 'Original copy', 'Travel', 'case', '0003'],
    ['SKU', '201', '[RB]Color=Brown', 'KEEP-010', '029.500', '', '', '', '', '0002'],
  ],
};

export function catalog(platform: Platform) {
  const rows = baselines[platform];
  const id = platform === 'Shopify' ? shopId : platform === 'WooCommerce' ? wooId : bigId;
  const writable = platform === 'Shopify' ? [shopPrice, compare] : [platform === 'WooCommerce' ? 'Sale price' : 'Sale Price'];
  const sku = platform === 'Shopify' ? 'Variant SKU' : platform === 'WooCommerce' ? 'SKU' : 'Product Code/SKU';
  const stem = 'campaign-' + platform.toLowerCase();
  const input = csv(stem + '.csv', rows);
  return { rows, id, writable, sku, stem, input, secondSku: platform === 'WooCommerce' ? wooSku : literalSku,
    lowLine: platform === 'WooCommerce' ? 4 : 3 };
}

export function replay(platform: Platform, launchText: string, revertText: string) {
  const { rows, sku, id, writable, input, secondSku } = catalog(platform);
  const headers = rows[0];
  const key = headers.indexOf(sku);
  const expected = rows.map(row => [...row]);
  const expectedKeys = platform === 'Shopify' ? [first, low, secondSku] : [first, secondSku];
  for (const row of expected.slice(1)) {
    if (row[key] !== first && row[key] !== secondSku) continue;
    const discounted = row[key] === first ? platform === 'Shopify' ? '80.99' : '76.99' : '60.99';
    row[headers.indexOf(writable[0])] = discounted;
    if (platform === 'Shopify' && row[key] === secondSku) row[headers.indexOf(compare)] = '075.500';
  }

  function apply(base: string[][], nativeText: string) {
    const [nativeHeaders, ...records] = parseCsv(nativeText);
    expect(nativeHeaders).toEqual([...id, ...writable]);
    expect(records.map(row => row[nativeHeaders.indexOf(sku)])).toEqual(expectedKeys);
    const result = base.map(row => [...row]);
    for (const record of records) {
      expect(record).toHaveLength(nativeHeaders.length);
      const original = result.slice(1).find(row => row[key] === record[nativeHeaders.indexOf(sku)])!;
      for (const [i, name] of nativeHeaders.entries()) {
        const index = headers.indexOf(name);
        if (id.includes(name)) expect(record[i], 'Original identity ' + name).toBe(original[index]);
        if (platform !== 'BigCommerce' || record[i] !== '') original[index] = record[i];
      }
    }
    return result;
  }

  const launched = apply(rows, launchText);
  expect(launched).toEqual(expected);
  const differences = launched.slice(1).flatMap((row, index) => headers.flatMap((header, col) =>
    row[col] === rows[index + 1][col] ? [] : [{ sku: row[key], column: header, before: rows[index + 1][col], after: row[col] }]));
  const restored = apply(launched, revertText);
  expect(restored).toEqual(rows);
  expect(csv(input.name, restored).buffer.equals(input.buffer)).toBe(true);
  return differences;
}
