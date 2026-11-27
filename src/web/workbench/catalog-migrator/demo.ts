import type { CatalogPlatform } from './migrationWorker';

const DEMOS: Record<CatalogPlatform, string> = {
  shopify: [
    'Handle,Title,Status,Published,Option1 Name,Option1 Value,Variant SKU,Variant Price,Variant Compare At Price,Variant Grams,Variant Inventory Tracker,Variant Inventory Qty,Variant Requires Shipping,Custom Launch Notes',
    'canvas-weekender,Canvas Weekender,active,TRUE,Color,Indigo,00123,18.50,24.99,850,shopify,7,TRUE,Spring collection',
    'canvas-weekender,,,,Color,Sand,0045-A,25.00,,900,shopify,0,TRUE,',
  ].join('\r\n'),
  woocommerce: [
    'ID,Type,SKU,Name,Published,Visibility in catalog,Parent,Regular price,Sale price,Stock,In stock?,Weight (g),Attribute 1 name,Attribute 1 value(s),Attribute 1 visible,Attribute 1 global',
    '100,variable,canvas-weekender,Canvas Weekender,1,visible,,,,,,850,Color,"Indigo, Sand",1,0',
    '101,variation,00123,Canvas Weekender - Indigo,1,visible,canvas-weekender,24.99,18.50,7,1,850,Color,Indigo,1,0',
    '102,variation,0045-A,Canvas Weekender - Sand,1,visible,canvas-weekender,25.00,,0,0,900,Color,Sand,1,0',
  ].join('\r\n'),
  bigcommerce: [
    'Item,ID,Type,Name,SKU,Options,Price,Sale Price,Weight,Current Stock,Inventory Tracking,Is Visible,Product URL',
    'Product,,physical,Canvas Weekender,canvas-weekender,,24.99,,0.85,,variant,TRUE,/canvas-weekender/',
    'Variant,,,,00123,Type=Dropdown|Name=Color|Value=Indigo,24.99,18.50,0.85,7,,,',
    'Variant,,,,0045-A,Type=Dropdown|Name=Color|Value=Sand,25.00,,0.90,0,,,',
  ].join('\r\n'),
};

export function catalogDemo(platform: CatalogPlatform) {
  return new File([`${DEMOS[platform]}\r\n`], `${platform}-catalog-synthetic.csv`, { type: 'text/csv' });
}
