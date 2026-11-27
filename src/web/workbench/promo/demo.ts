import type { StorePlatform } from '../../../core/shopify-price-diff/workspace-profile';

const demos = {
  shopify: [
    'Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price,Variant Compare At Price,Cost per item,Tags,Body (HTML)',
    'summer-shirt,  Summer shirt  ,Size,Medium,DEMO-100,100.00,120.00,83.00,"summer, apparel",Product copy stays put',
    'summer-shirt,,,Small,DEMO-LOW,12.00,,6.00,,',
    'travel-mug,Travel mug,Title,Default Title,DEMO-075,75.50,,42.00,"summer, travel",Keep the original copy',
  ],
  woocommerce: [
    'ID,Type,SKU,Name,Parent,Regular price,Sale price,Description,Images,Meta:source',
    '100,variable,DEMO-SHIRT,Summer shirt,,,,Product copy stays put,,synthetic',
    '101,variation,DEMO-100,Summer shirt - Medium,DEMO-SHIRT,100.00,95.10,,,synthetic',
    '102,variation,DEMO-LOW,Summer shirt - Small,DEMO-SHIRT,12.00,,,,synthetic',
    '103,simple,DEMO-075,Travel mug,,75.50,,Keep the original copy,,synthetic',
  ],
  bigcommerce: [
    'Item Type,Product ID,Product Name,Product Code/SKU,Price,Sale Price,Product Description',
    'Product,101,Summer shirt,DEMO-100,100.00,95.10,Product copy stays put',
    'Product,102,Canvas pouch,DEMO-LOW,15.00,12.00,Keep the original copy',
    'Product,103,Travel mug,DEMO-075,85.50,75.50,Keep the original copy',
  ],
} satisfies Record<StorePlatform, string[]>;

export function campaignDemo(platform: StorePlatform) {
  return new File([`${demos[platform].join('\r\n')}\r\n`], `${platform}-promo-synthetic.csv`, { type: 'text/csv' });
}
