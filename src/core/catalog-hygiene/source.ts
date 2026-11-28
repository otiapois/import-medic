import { bigIdHeader, bigNameHeader, bigPriceHeader, bigSkuHeader, bigTypeHeader } from '../bigcommerce-price-diff/source';
import { decodeCsv, parseCsv, type CsvRecord } from '../csv';
import { canonicalShopifyHeader, priceHeader, skuHeader } from '../shopify-price-diff/source';
import { canonicalWooHeader, wooRegularHeader } from '../woocommerce-price-diff/source';
import type { CatalogHygieneIssue, CatalogHygieneSource } from './types';

const schemas = {
  shopify: { required: ['Handle', 'Title', skuHeader, priceHeader], sku: skuHeader, price: priceHeader },
  woocommerce: { required: ['Type', 'SKU', wooRegularHeader], sku: 'SKU', price: wooRegularHeader },
  bigcommerce: { required: [bigTypeHeader, bigIdHeader, bigNameHeader, bigSkuHeader, bigPriceHeader], sku: bigSkuHeader, price: bigPriceHeader },
};
const shopifyImageFields = new Set(['Handle', 'Image Src', 'Image Position', 'Image Alt Text']);
const wooBarcode = 'GTIN, UPC, EAN, or ISBN';
const bigBarcode = 'Product UPC/EAN';
const wooReferenceFields = ['Parent', 'Grouped products', 'Upsells', 'Cross-sells'];
const wooTypes = new Set(['simple', 'variable', 'grouped', 'external', 'variation', 'virtual', 'downloadable']);
export const zeroWidth = /[\u200b\ufeff]/;
export const stripZeroWidths = (value: string) => value.replace(/[\u200b\ufeff]/g, '');
const embedded = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
export const controlsInIdentifier = (value: string) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(stripZeroWidths(value));
const structuralFields = {
  shopify: new Set(['Handle']), woocommerce: new Set(['ID', 'Type']), bigcommerce: new Set([bigIdHeader, bigTypeHeader]),
};

export type AddIssue = (code: string, message: string, details?: Partial<Omit<CatalogHygieneIssue, 'code' | 'message' | 'sourceIndex'>>) => void;

interface CatalogRow {
  record: CsvRecord;
  priceRequired: boolean;
  scanIdentifiers: boolean;
}

export interface CatalogReference {
  line: number;
  value: string;
}

export interface CatalogTable {
  records: CsvRecord[];
  rows: CatalogRow[];
  references: CatalogReference[];
  scannedRows: number;
  headers: string[];
  skuIndex: number;
  priceIndex: number;
  barcodeIndex: number;
  barcodeKind: 'single' | 'shopify-list' | 'woo-global';
}

export function readCatalog(source: CatalogHygieneSource, sourceIndex: number, add: AddIssue): CatalogTable {
  const table: CatalogTable = { records: [], rows: [], references: [], scannedRows: 0, headers: [],
    skuIndex: -1, priceIndex: -1, barcodeIndex: -1, barcodeKind: 'single' };
  const decoded = decodeCsv(source.bytes, { retainNulls: true });
  if (decoded.encoding === 'unknown') {
    add('invalid-encoding', 'The catalog encoding could not be decoded.');
    return table;
  }
  table.records = parseCsv(decoded.text).records;
  const blank = (record: CsvRecord) => !record.parseError && record.cells.every(cell => cell === '');
  const headerIndex = table.records.findIndex(record => !blank(record));
  const header = table.records[headerIndex];
  if (!header) {
    add('missing-header', 'Include a native catalog header.');
    return table;
  }
  const { platform } = source;
  const schema = schemas[platform];
  const canonical = (value: string) => {
    const key = value.trim().toLowerCase();
    if (platform === 'shopify') return key === 'barcodes' ? 'Barcodes' : canonicalShopifyHeader(value);
    if (platform === 'woocommerce') {
      if ([wooBarcode.toLowerCase(), 'global unique id'].includes(key)) return wooBarcode;
      return wooReferenceFields.find(field => field.toLowerCase() === key) ?? canonicalWooHeader(value);
    }
    if (key === 'product sku') return bigSkuHeader;
    return [...schema.required, bigBarcode].find(field => field.toLowerCase() === key) ?? value;
  };
  table.headers = header.cells;
  const headings = table.headers.map(canonical);
  const columns = new Map<string, number>();
  const duplicate = new Set<string>();
  for (const [index, name] of headings.entries()) {
    const label = table.headers[index];
    const key = name.trim().toLowerCase();
    if (controlsInIdentifier(label) || zeroWidth.test(label) || !key) {
      add('invalid-header', 'Use a nonempty text header without invisible or embedded control characters.',
        { line: header.line, column: label, value: label });
    }
    if (columns.has(key) && !duplicate.has(key)) {
      add('duplicate-header', 'Keep one column for this native heading.', { line: header.line, column: label, value: label });
      duplicate.add(key);
    }
    columns.set(key, index);
  }
  const indexOf = (field: string) => columns.get(field.toLowerCase()) ?? -1;
  for (const column of schema.required) {
    if (indexOf(column) < 0) add('missing-column', 'This native catalog needs the ' + column + ' column.', { line: header.line, column });
  }
  table.skuIndex = indexOf(schema.sku);
  table.priceIndex = indexOf(schema.price);
  table.barcodeKind = platform === 'woocommerce' ? 'woo-global' : 'single';
  table.barcodeIndex = indexOf(platform === 'shopify' ? 'Variant Barcode' : platform === 'woocommerce' ? wooBarcode : bigBarcode);
  const pluralIndex = indexOf('Barcodes');
  if (platform === 'shopify' && pluralIndex >= 0) {
    if (table.barcodeIndex >= 0) add('ambiguous-barcode-column', 'Keep either Barcodes or the singular Barcode heading.',
      { line: header.line, column: 'Barcodes' });
    table.barcodeIndex = pluralIndex;
    table.barcodeKind = 'shopify-list';
  }

  if (header.parseError) add('invalid-csv', header.parseError, { line: header.line, value: header.raw });
  const shapeReady = schema.required.every(column => indexOf(column) >= 0) && duplicate.size === 0;
  const handles = new Set<string>();
  let activeHandle = '';
  let bigHasProduct = false;
  let bigProductPrice = '';
  let bigSawRule = false;
  const wooProductsById = new Map<string, { type: string; line: number }>();
  const wooProductsBySku = new Map<string, { type: string; line: number }>();
  const wooVariations: { parent: string; line: number }[] = [];
  const wooReferences = wooReferenceFields.map(field => [field, indexOf(field)] as const).filter(([, index]) => index >= 0);
  for (const record of table.records.slice(headerIndex + 1)) {
    // A physical blank line is a separator. An all-empty delimited record still has a native width.
    if (blank(record) && (record.cells.length === 1 || record.cells.length === table.headers.length)) continue;
    table.scannedRows++;
    if (record.parseError) {
      add('invalid-csv', record.parseError, { line: record.line, value: record.raw });
      continue;
    }
    if (record.cells.length !== table.headers.length) {
      add('row-width', 'The record has a different number of cells from the native header.', { line: record.line });
      continue;
    }
    const value = (field: string) => record.cells[indexOf(field)] ?? '';
    const flag = (code: string, message: string, field: string) => add(code, message,
      { line: record.line, column: table.headers[indexOf(field)] ?? field, value: value(field) });
    let priceRequired = true;
    let scanIdentifiers = true;
    if (shapeReady && platform === 'shopify') {
      const handle = value('Handle');
      const continuation = handle !== '' && handle === activeHandle;
      const imageOnly = value('Image Src') !== '' &&
        record.cells.every((cell, index) => cell === '' || shopifyImageFields.has(headings[index]));
      if (!/^[\p{L}\p{N}-]+$/u.test(handle) || !/[\p{L}\p{N}]/u.test(handle)) {
        flag('invalid-handle', 'Use the original valid Shopify handle for every product, variant and image row.', 'Handle');
      }
      if (!continuation && handles.has(handle)) {
        flag('noncontiguous-handle', 'Keep each Shopify product and its variant and image rows together.', 'Handle');
      }
      if (!continuation && value('Title').trim() === '') {
        flag('missing-title', 'The first row for a Shopify product needs its title.', 'Title');
      }
      handles.add(handle);
      activeHandle = handle;
      priceRequired = !imageOnly;
    } else if (shapeReady && platform === 'woocommerce') {
      const type = value('Type').split(',')[0];
      const id = value('ID');
      const sku = value('SKU');
      const parent = value('Parent');
      if (!wooTypes.has(type)) flag('invalid-woo-type', 'Use a supported native WooCommerce product type.', 'Type');
      priceRequired = type !== 'variable' && type !== 'grouped';
      if (id) wooProductsById.set(id, { type, line: record.line });
      if (sku) wooProductsBySku.set(sku, { type, line: record.line });
      if (type === 'variation') {
        if (!parent) flag('missing-woo-parent', 'A WooCommerce variation needs its parent SKU or id:ID.', 'Parent');
        else wooVariations.push({ parent, line: record.line });
      } else if (parent) flag('unexpected-woo-parent', 'Only a WooCommerce variation should have a Parent value.', 'Parent');
      for (const [field, index] of wooReferences) {
        const raw = record.cells[index];
        const references = field === 'Parent' ? [raw] : (raw.match(/(?:\\,|[^,])+/g) ?? []).map(item => item.replace(/\\,/g, ','));
        for (const ref of references) if (ref.trim() && !ref.trim().startsWith('id:')) {
          table.references.push({ line: record.line, value: ref });
        }
        if (controlsInIdentifier(raw) || zeroWidth.test(raw)) flag('embedded-control', 'Review the original reference with embedded control characters.', field);
      }
    } else if (shapeReady && platform === 'bigcommerce') {
      const type = value(bigTypeHeader);
      if (type === 'Product') {
        bigHasProduct = true;
        bigSawRule = false;
        bigProductPrice = value(bigPriceHeader);
        if (!value(bigNameHeader).trim()) flag('missing-bigcommerce-name', 'Keep the title on the original legacy Product row.', bigNameHeader);
      } else if (type === 'SKU' || type === 'Rule') {
        if (!bigHasProduct || (type === 'SKU' && bigSawRule)) {
          flag('invalid-bigcommerce-group', 'Keep legacy SKU rows and then any Rule rows below their original Product row.', bigTypeHeader);
        }
        if (type === 'Rule') {
          bigSawRule = true;
          scanIdentifiers = false;
          const sku = value(bigSkuHeader);
          if (sku) table.references.push({ line: record.line, value: sku });
        }
        priceRequired = type === 'SKU' && bigProductPrice === '';
      } else flag('invalid-bigcommerce-type', 'Use a legacy BigCommerce Product, SKU or Rule row.', bigTypeHeader);
    }
    for (const [index, cell] of record.cells.entries()) {
      if (scanIdentifiers && (index === table.skuIndex || index === table.barcodeIndex)) continue;
      if (platform === 'woocommerce' && wooReferences.some(([, refIndex]) => index === refIndex)) continue;
      const structural = index === table.skuIndex || index === table.barcodeIndex || structuralFields[platform].has(headings[index]);
      if (embedded.test(cell) || structural && (zeroWidth.test(cell) || controlsInIdentifier(cell))) {
        add('embedded-control', 'Review the original cell with embedded control characters.',
          { line: record.line, column: table.headers[index], value: cell });
      }
    }
    table.rows.push({ record, priceRequired, scanIdentifiers });
  }
  for (const { parent, line } of wooVariations) {
    const target = parent.startsWith('id:') ? wooProductsById.get(parent.slice(3)) : wooProductsBySku.get(parent);
    if (!target) add('unverified-woo-parent', 'The referenced WooCommerce parent is outside the supplied file. Confirm it before import.',
      { level: 'warning', line, column: 'Parent', value: parent });
    else if (target.type !== 'variable') add('invalid-woo-parent', 'A WooCommerce variation must reference the original variable parent.',
      { line, column: 'Parent', value: parent, related: [{ sourceIndex, line: target.line }] });
  }
  if (!table.rows.some(row => row.scanIdentifiers)) add('missing-products', 'No product or variant data rows were found.', { line: header.line });
  return table;
}
