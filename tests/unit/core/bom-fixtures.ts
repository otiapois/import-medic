import { parseBigCommerceBaseline } from '../../../src/core/bigcommerce-price-diff';
import { serializeCsv } from '../../../src/core/csv';
import { parseBaseline } from '../../../src/core/shopify-price-diff';
import type { StorePlatform } from '../../../src/core/shopify-price-diff/types';
import { parseWooCommerceBaseline } from '../../../src/core/woocommerce-price-diff';

const bytes = (value: string) => new TextEncoder().encode(value);

export function syntheticBomBaseline(platform: StorePlatform, records: readonly (readonly [string, string, string])[], extra: string[] = [], extraRows: string[][] = []) {
  const variants = records.map(([sku, retail, cost], i) => {
    const id = String(i + 1);
    const target = platform === 'shopify' ? ['product-' + id, 'Product ' + id, 'Title', 'Default Title', sku, retail, cost] :
      platform === 'woocommerce' ? [id, 'simple', sku, 'Product ' + id, '', retail, cost] :
        ['Product', id, 'Product ' + id, sku, retail, '', cost];
    return [...target, ...extraRows[i] ?? []];
  });
  const headers = platform === 'shopify' ? ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Cost per item'] :
    platform === 'woocommerce' ? ['ID', 'Type', 'SKU', 'Name', 'Parent', 'Regular price', 'Cost'] :
      ['Item Type', 'Product ID', 'Product Name', 'Product Code/SKU', 'Price', 'Sale Price', 'Cost Price'];
  const data = bytes(serializeCsv([...headers, ...extra], variants, 'price-audit'));
  const parse = platform === 'shopify' ? parseBaseline : platform === 'woocommerce' ? parseWooCommerceBaseline : parseBigCommerceBaseline;
  return { data, baseline: parse(data, 'store.csv') };
}
