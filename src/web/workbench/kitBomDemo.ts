import type { StorePlatform } from '../../core/shopify-price-diff/workspace-profile';

const costs = [
  { sku: '00123', name: 'Synthetic ceramic mug', handle: 'synthetic-mug', retail: '5.00', cost: '2.50' },
  { sku: 'WRAP', name: 'Synthetic gift wrap', handle: 'synthetic-wrap', retail: '2.50', cost: '1.25' },
  { sku: 'BOX', name: 'Synthetic gift box', handle: 'synthetic-box', retail: '4.00', cost: '2.00' },
  { sku: 'SUB', name: 'Synthetic wrapped mug pack', handle: 'synthetic-pack', retail: '14.00', cost: '7.00' },
  { sku: 'KIT', name: 'Synthetic gift kit', handle: 'synthetic-kit', retail: '35.00', cost: '17.50' },
];

const baselines: Record<StorePlatform, string[]> = {
  shopify: [
    'Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price,Cost per item',
    ...costs.map(({ sku, name, handle, retail, cost }) => [handle, name, 'Title', 'Default Title', sku, retail, cost].join(',')),
  ],
  woocommerce: [
    'ID,Type,SKU,Name,Parent,Regular price,Cost',
    ...costs.map(({ sku, name, retail, cost }, index) => [200 + index, 'simple', sku, name, '', retail, cost].join(',')),
  ],
  bigcommerce: [
    'Item Type,Product ID,Product Name,Product Code/SKU,Price,Sale Price,Cost Price',
    ...costs.map(({ sku, name, retail, cost }, index) => ['Product', 300 + index, name, sku, retail, '', cost].join(',')),
  ],
};

const supplier = ['SKU,Cost', '00123,3.00'];
const bom = [
  'Bundle SKU,Component SKU,Quantity,Assembly Cost',
  'SUB,00123,2,0.75',
  'SUB,WRAP,1,',
  'KIT,SUB,2,1.50',
  'KIT,BOX,1,',
];

export const kitDemoBaselineName = (platform: StorePlatform) => `synthetic-kit-${platform}-baseline.csv`;

export function kitBomDemo(platform: StorePlatform) {
  function csv(rows: readonly string[], filename: string) {
    return { file: new File([rows.join('\r\n')], filename, { type: 'text/csv' }), synthetic: true };
  }
  return {
    baseline: csv(baselines[platform], kitDemoBaselineName(platform)),
    supplier: csv(supplier, 'synthetic-kit-supplier-costs.csv'),
    bom: csv(bom, 'synthetic-kit-bom.csv'),
  };
}
