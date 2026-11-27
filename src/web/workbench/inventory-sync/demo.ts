const INVENTORY = [
  'Handle,Title,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Option3 Name,Option3 Value,SKU,HS Code,COO,Location,On hand (current),On hand (new),Available',
  'field-notebook,Field Notebook,Title,Default Title,,,,,00041,,,Warehouse A,012,,12',
  'desk-tray,Desk Tray,Title,Default Title,,,,,00042,,,Warehouse A,2,,2',
  'pen-case,Pen Case,Title,Default Title,,,,,00043,,,Warehouse A,6,,6',
  'binder,Binder,Title,Default Title,,,,,00044,,,Warehouse A,-3,,0',
  'field-notebook,Field Notebook,Title,Default Title,,,,,00041,,,Warehouse B,004,,4',
  'desk-tray,Desk Tray,Title,Default Title,,,,,00042,,,Warehouse B,7,,7',
  'pen-case,Pen Case,Title,Default Title,,,,,00043,,,Warehouse B,6,,6',
].join('\r\n') + '\r\n';

const SUPPLIER = 'SKU,Stock\r\n00041,19\r\n00042,1\r\n00043,8\r\n';

export function inventoryDemo() {
  return {
    baseline: new File([INVENTORY], 'synthetic-shopify-inventory.csv', { type: 'text/csv' }),
    supplier: new File([SUPPLIER], 'synthetic-supplier-stock.csv', { type: 'text/csv' }),
    mapping: { skuColumn: 0, quantityColumn: 1 },
    settings: { reserveUnits: '2', zeroOutThreshold: '1', maxCap: '' },
  };
}
