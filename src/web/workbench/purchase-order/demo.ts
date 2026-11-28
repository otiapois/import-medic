export function purchaseOrderDemo() {
  return {
    targetLocation: 'Warehouse East',
    reorderPoint: '5',
    targetStock: '13',
    poReference: 'DEMO-PO-001',
    inventory: new File([
      'SKU,Location,Available,Reorder Point,Target Stock\r\n',
      '00042,Warehouse East,2,4,16\r\n',
      '00084,Warehouse East,5,,\r\n',
      '00126,Warehouse East,22,,\r\n',
      '00042,Warehouse West,23,4,16\r\n',
      '00084,Warehouse West,19,,\r\n',
    ], 'Inventory Demo.csv', { type: 'text/csv' }),
    suppliers: [
      new File([
        'SKU,Unit Cost,MOQ,Case Pack,Lead Time Days,Supplier SKU\r\n',
        '00042,2.80,12,6,4,000420-N\r\n',
        '00084,2.95,10,10,6,000840-N\r\n',
      ], 'Northstar Supply.csv', { type: 'text/csv' }),
      new File([
        'SKU,Unit Cost,MOQ,Case Pack,Lead Time Days,Supplier SKU\r\n',
        '00042,2.55,12,12,3,000420-H\r\n',
        '00084,2.12,10,5,5,000840-H\r\n',
      ], 'Harbor Wholesale.csv', { type: 'text/csv' }),
    ],
  };
}
