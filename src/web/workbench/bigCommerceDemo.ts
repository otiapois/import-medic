export const BIGCOMMERCE_DEMO = {
  baselineName: 'bigcommerce-baseline-synthetic.csv',
  baseline: [
    'Item Type,Product ID,Product Name,Product Code/SKU,Price,Sale Price,Current Stock Level,Track Inventory,Product Description,Category,Product Image File - 1,Meta Keywords',
    'Product,101,Harbor mug,00123,20.00,18.00,24,by product,Synthetic ceramic mug,Home,harbor-mug.jpg,mug',
    'Product,202,Ridge shirt,00200,32.00,28.00,18,by option,Synthetic cotton shirt,Apparel,ridge-shirt.jpg,shirt',
    'SKU,203,[RB]Size=Small,00201,32.00,,12,,,,,',
    'SKU,204,[RB]Size=Large,00202,32.00,,6,,,,,',
  ].join('\r\n'),
  supplierName: 'bigcommerce-supplier-synthetic.csv',
  supplier: [
    'SKU,New Price,Sale Price,Stock',
    '00123,24.00,21.00,30',
    '00201,32.00,,10',
  ].join('\r\n'),
  candidateName: 'bigcommerce-update-synthetic.csv',
  candidate: [
    'Item Type,Product ID,Product Name,Product Code/SKU,Price',
    'Product,101,Harbor mug,00123,24.00',
  ].join('\r\n'),
};
