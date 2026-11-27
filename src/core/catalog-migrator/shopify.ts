import { canonicalShopifyHeader, compareAtHeader, inventoryHeader, optionNames, optionValues, priceHeader, skuHeader } from '../shopify-price-diff/source';
import { CatalogSource, unknownStock, validHandle, validateCatalog, type Product, type Stock } from './model';

const grams = 'Variant Grams';
const tracker = 'Variant Inventory Tracker';
const shipping = 'Variant Requires Shipping';
const linked = ['Option1 Linked To', 'Option2 Linked To', 'Option3 Linked To'];
const imageFields = new Set(['Handle', 'Image Src', 'Image Position', 'Image Alt Text']);
const variantFields = [priceHeader, compareAtHeader, skuHeader, inventoryHeader, tracker, grams, shipping, ...optionNames, ...optionValues];

export function readShopify(bytes: Uint8Array, filename: string): CatalogSource {
  const source = new CatalogSource(bytes, filename, 'shopify', canonicalShopifyHeader);
  if (!source.require(['Handle', 'Title', priceHeader])) return source;
  for (const [index, name] of optionNames.entries()) {
    if (source.columns.has(name) !== source.columns.has(optionValues[index])) {
      source.add('missing-option-column', source.headerLine, name, 'Keep both headers for each option dimension.');
    }
  }
  const groups = new Map<string, Product>();
  const names = new Map<string, string[]>();
  let previous = '';
  for (const row of source.rows) {
    const get = (column: string) => source.value(row, column);
    const handle = get('Handle');
    if (!validHandle(handle)) source.add('invalid-handle', row.line, 'Handle', 'Use the original native handle on every Shopify record.');
    const prior = groups.get(handle);
    if (prior && previous !== handle) source.add('noncontiguous-handle', row.line, 'Handle', 'Keep all rows for this handle together.');
    previous = handle;
    if (get('Image Src') && variantFields.every(field => !get(field)) &&
      row.cells.every(({ value }, index) => value === '' || imageFields.has(canonicalShopifyHeader(source.headers[index])))) {
      source.add('omitted-image-row', row.line, 'Image Src', 'Image-only source row is excluded from this catalog conversion.', 'disclosure');
      if (!prior) source.add('orphan-image-row', row.line, 'Handle', 'Place this image row after the first variant of its product.');
      continue;
    }
    const rawState = get('Status').toLowerCase();
    const state = rawState === 'active' || rawState === 'draft' || rawState === 'archived' ? rawState : '';
    if (rawState && !state) source.add('invalid-status', row.line, 'Status', 'Shopify status must be active, draft, or archived.');
    const published = source.boolean(row, 'Published');
    const visibility = published === 'true' ? 'visible' : published === 'false' ? 'hidden' : '';
    const title = get('Title');
    const product: Product = prior ?? {
      line: row.line, handle, sku: '', title, state, visibility, grouped: false, stock: unknownStock, shipping: '', variants: [],
    };
    if (!prior) {
      groups.set(handle, product);
      source.products.push(product);
      names.set(handle, optionNames.map(get));
    } else {
      if (title && title !== prior.title) source.add('conflicting-title', row.line, 'Title', 'Continuation title differs from the first row.');
      if (state && state !== prior.state) source.add('conflicting-status', row.line, 'Status', 'Continuation status differs from the first row.');
      if (visibility && visibility !== prior.visibility) source.add('conflicting-status', row.line, 'Published', 'Continuation visibility differs from the first row.');
    }
    if (linked.some(field => get(field))) source.add('linked-options', row.line, linked.find(field => get(field)) ?? null, 'Linked options require their native reference data.');
    const productNames = names.get(handle)!;
    const options = optionNames.flatMap((name, index) => {
      const label = get(name);
      const value = get(optionValues[index]);
      if (!label && !value && !productNames[index]) return [];
      if (!productNames[index] || !value || (label && label !== productNames[index]) || productNames.slice(0, index).includes('')) {
        source.add('inconsistent-options', row.line, optionValues[index], 'Keep exact values and the names from the first row for each option.');
      }
      return [{ name: productNames[index], value }];
    });
    const qty = source.count(row, inventoryHeader);
    const service = get(tracker);
    let stock: Stock = unknownStock;
    if (service && service !== 'shopify') source.add('unsupported-tracker', row.line, tracker, 'External or location-specific inventory cannot be represented by this catalog CSV.');
    if (service && !qty) source.add('missing-stock', row.line, inventoryHeader, 'Tracked inventory requires a known quantity. Export the single-location amount.');
    if (qty) {
      if (source.columns.has(tracker) && !service) {
        stock = { mode: 'none', quantity: '' };
        source.add('untracked-stock-value', row.line, inventoryHeader, 'The inventory tracker is blank. The displayed, untracked quantity is omitted.', 'disclosure');
      } else {
        stock = { mode: 'own', quantity: qty };
        if (!service) source.add('derived-tracking', row.line, inventoryHeader, 'Numeric stock is explicitly tracked in the target.', 'disclosure');
      }
    } else if (source.columns.has(tracker) && !service) stock = { mode: 'none', quantity: '' };
    const requiresShipping = source.boolean(row, shipping);
    const weight = source.weight(row, grams, 'g');
    if (weight && !/^\d+$/.test(weight.amount)) source.add('invalid-weight', row.line, grams, 'Shopify’s native CSV expects a whole number of grams.');
    product.variants.push({ line: row.line, sku: get(skuHeader), options, stock, weight,
      shipping: requiresShipping === 'true' ? 'physical' : requiresShipping === 'false' ? 'digital' : '',
      prices: source.money(row, priceHeader, compareAtHeader, true) });
  }
  for (const product of source.products) {
    const first = product.variants[0];
    const isDefault = first.options.length === 1 && first.options[0].name === 'Title' && first.options[0].value === 'Default Title';
    product.grouped = product.variants.length > 1 || (first.options.length > 0 && !isDefault);
    if (!product.grouped) product.sku = first.sku;
    if (isDefault && !product.grouped) first.options = [];
    if (isDefault && product.grouped) source.add('mixed-default-option', first.line, 'Option1 Value', 'The Shopify default option cannot also identify a real variant.');
    if (!product.grouped) product.shipping = first.shipping;
  }
  validateCatalog(source, { sku: skuHeader, title: 'Title', option: 'Option1 Value', handle: 'Handle' });
  return source;
}
