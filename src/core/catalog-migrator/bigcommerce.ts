import { bigIdHeader, bigNameHeader, bigSkuHeader, bigTrackingHeader, bigTypeHeader, legacyVariantOptions } from '../bigcommerce-price-diff/source';
import { sameAmount, scaled } from '../shopify-price-diff/prices';
import type { SourceRow } from '../shopify-price-diff/types';
import { CatalogSource, exactAmount, identityKey, plainAmount, unknownStock, validHandle, validPrices, validateCatalog,
  type Option, type Product, type Shipping, type Stock, type Variant, type Weight } from './model';

const aliases: Record<string, string[]> = {
  Item: [bigTypeHeader], ID: [bigIdHeader], Name: [bigNameHeader], SKU: [bigSkuHeader, 'Product SKU'],
  Options: [], Price: [], 'Sale Price': [], 'Current Stock': ['Stock Level', 'Current Stock Level'],
  'Inventory Tracking': [bigTrackingHeader], 'Is Visible': ['Product Visible', 'Product Visible?'], 'Product URL': [],
  Weight: ['Product Weight'], Type: ['Product Type'], 'Option Set': [], 'Allow Purchases': ['Allow Purchases?'], 'Stop Processing Rules': [],
};
const headerKeys = new Map(Object.entries(aliases).flatMap(([field, choices]) => [field, ...choices].map(name => [name.toLowerCase(), field])));
const canonicalBigHeader = (header: string) => headerKeys.get(header.trim().toLowerCase()) ?? header;
const modernOptions = /^Type=(Dropdown|Radio|Rectangle|Swatch)\|Name=([^|\r\n=]+)\|Value=([^|\r\n]+)$/;
const modernDivider = /\s*(?=Type=(?:Dropdown|Radio|Rectangle|Swatch)\|Name=)/;
const modernSwatch = /^(.+)\[((?:#[0-9a-f]{6};){0,2}#[0-9a-f]{6}|https?:\/\/[^\s[\]]+)\]$/i;
const legacyTypes: Readonly<Record<string, string>> = { RB: 'Radio', S: 'Dropdown', RT: 'Rectangle', CS: 'Swatch' };
const swatchSuffix = /:(?=#[a-f0-9]{6}|https?:\/\/)/i;

function parseOptions(raw: string, legacy: boolean): Option[] | null {
  if (legacy) {
    return legacyVariantOptions(raw, true)?.map(({ name, value, type }) => {
      const split = type === 'CS' ? value.search(swatchSuffix) : -1;
      return { name, type: legacyTypes[type], value: split < 0 ? value : value.slice(0, split), ...(split >= 0 ? { config: value.slice(split + 1) } : {}) };
    }) ?? null;
  }
  const options: Option[] = [];
  for (const line of raw.split(modernDivider)) {
    const fields = modernOptions.exec(line);
    if (!fields) return null;
    const [, type, name, value] = fields;
    if (type === 'Swatch') {
      const swatch = modernSwatch.exec(value);
      if (!swatch) return null;
      options.push({ type, name, value: swatch[1], config: swatch[2] });
    } else options.push({ type, name, value });
  }
  return options;
}

function ruleAmount(source: CatalogSource, rule: SourceRow, column: string, base: string, reference: string): string {
  const raw = source.value(rule, column);
  if (!raw) return reference;
  const fields = /^\[(FIXED|ADD|REMOVE)\](.+)$/.exec(raw);
  const change = fields && plainAmount(fields[2]);
  const basis = plainAmount(base);
  const exported = plainAmount(reference);
  if (!fields || !change || (!basis && fields[1] !== 'FIXED')) {
    source.add('unsupported-legacy-rule', rule.line, column, 'Only a fixed or a flat decimal BigCommerce adjustment can be replayed with a known base.');
    return reference;
  }
  let result = change.text;
  if (fields[1] !== 'FIXED' && basis) {
    const [oldAmount, adjusted] = scaled(basis, change);
    const units = fields[1] === 'ADD' ? oldAmount + adjusted : oldAmount - adjusted;
    if (units < 0n) {
      source.add('negative-legacy-rule', rule.line, column, 'The rule would result in a negative amount.');
      return reference;
    }
    result = exactAmount(units, Math.max(basis.scale, change.scale));
  }
  if (exported && !sameAmount(exported, plainAmount(result)!)) {
    source.add('conflicting-legacy-rule', rule.line, column, 'The rule does not match the original variant’s exported reference value.');
  }
  source.add('resolved-legacy-rule', rule.line, column, 'The native rule is resolved to an absolute amount.', 'disclosure');
  return reference || result;
}

export function readBigCommerce(bytes: Uint8Array, filename: string): CatalogSource {
  const source = new CatalogSource(bytes, filename, 'bigcommerce-modern', canonicalBigHeader);
  const legacy = source.headers.some(header => header.trim().toLowerCase() === bigTypeHeader.toLowerCase());
  if (legacy) source.dialect = 'bigcommerce-legacy';
  if (!source.require(['Item', 'Name', 'SKU', 'Price'])) return source;
  const identities = new Map<string, number>();
  let product: Product | undefined;
  let children = new Map<string, { row: SourceRow; variant: Variant }>();
  let rules = new Map<string, SourceRow>();
  let sawRule = false;
  let mode = '';
  const complete = () => {
    if (!product) return;
    for (const [sku, rule] of rules) {
      const child = children.get(sku);
      if (!child) {
        source.add('orphan-legacy-rule', rule.line, 'SKU', 'The rule does not have an exact original variant SKU within its Product group.');
        continue;
      }
      const { row, variant } = child;
      if (source.value(rule, 'Price') && product.base?.sale) {
        source.add('ambiguous-legacy-sale', rule.line, 'Price', 'A legacy price rule and a product sale can interact. Export absolute variant prices from the modern tool.');
      }
      if (source.value(rule, 'Sale Price')) source.add('unsupported-legacy-sale', rule.line, 'Sale Price', 'The legacy Rule format does not define a separate variant sale price.');
      const regular = ruleAmount(source, rule, 'Price', product.base?.regular ?? '', source.value(row, 'Price'));
      if (regular) variant.prices.regular = regular;
      const amount = ruleAmount(source, rule, 'Weight', product.weight?.amount ?? '', source.value(row, 'Weight'));
      if (amount) variant.weight = { amount, unit: '', line: rule.line };
      if (source.value(rule, 'Allow Purchases') && source.boolean(rule, 'Allow Purchases') !== 'true') {
        source.add('excluded-legacy-variant', rule.line, 'Allow Purchases', 'The target cannot express this disabled variant rule.');
      }
    }
    if (!product.grouped) return;
    if (product.stock.mode === 'own' && mode !== 'product') source.add('ambiguous-stock', product.line, 'Inventory Tracking', 'Specify product or variant tracking for a grouped stock quantity.');
    if (mode === 'variant' && product.variants.length === 0) source.add('missing-variants', product.line, 'Item', 'Variant tracking requires variant rows.');
    if (mode === 'product' && product.variants.some(variant => variant.stock.mode === 'own')) {
      source.add('mixed-stock', product.line, 'Inventory Tracking', 'Both parent and separate variant quantities were supplied.');
    }
    for (const variant of product.variants) if (!validPrices(variant.prices.regular, variant.prices.sale)) {
      source.add('invalid-variant-prices', variant.line, 'Price', 'The resolved variant requires a regular amount above any sale amount.');
    }
  };
  for (const row of source.rows) {
    const get = (column: string) => source.value(row, column);
    const item = get('Item');
    const id = get('ID');
    const sku = get('SKU');
    if (id && ['Product', 'Variant', 'SKU', 'Rule'].includes(item)) {
      if (!/^[1-9]\d{0,18}$/.test(id)) source.add('invalid-source-id', row.line, 'ID', 'Use a positive original row ID or the blank ID of a creation CSV.');
      const key = item + ':' + id;
      const first = identities.get(key);
      if (first !== undefined) source.add('duplicate-source-id', row.line, 'ID', 'This native row ID repeats line ' + first + '.');
      else identities.set(key, row.line);
    }
    if (item === 'Product') {
      complete();
      children = new Map();
      rules = new Map();
      sawRule = false;
      const visible = source.boolean(row, 'Is Visible');
      if (source.boolean(row, 'Allow Purchases') === 'false') {
        source.add('excluded-legacy-product', row.line, 'Allow Purchases', 'The source explicitly disables purchases. This behavior has no exact native target field.');
      }
      const rawMode = get('Inventory Tracking').toLowerCase();
      mode = rawMode === 'by product' ? 'product' : rawMode === 'by option' ? 'variant' : rawMode;
      if (!['', 'none', 'product', 'variant'].includes(mode)) {
        source.add('invalid-stock-tracking', row.line, 'Inventory Tracking', 'Use native none, product, or variant inventory tracking.');
      }
      const rawType = get('Type').toLowerCase();
      const shipping: Shipping = rawType === 'physical' || legacy && rawType === 'p' ? 'physical' :
        rawType === 'digital' || legacy && rawType === 'd' ? 'digital' : '';
      if (rawType && !shipping) source.add('invalid-product-type', row.line, 'Type', 'Use a native physical or digital product type.');
      const qty = source.count(row, 'Current Stock');
      let stock: Stock = unknownStock;
      if (mode === 'product') {
        if (!qty) source.add('missing-stock', row.line, 'Current Stock', 'Product tracking requires the original quantity.');
        stock = { mode: 'own', quantity: qty };
      } else if (!mode && qty) {
        stock = { mode: 'own', quantity: qty };
        source.add('derived-tracking', row.line, 'Current Stock', 'Numeric stock is explicitly tracked in the target.', 'disclosure');
      } else if (mode === 'none') {
        stock = { mode: 'none', quantity: '' };
        if (qty) source.add('untracked-stock-value', row.line, 'Current Stock', 'The source marks this numeric stock as untracked; it is omitted.', 'disclosure');
      } else if (mode === 'variant' && qty) {
        source.add('inactive-parent-stock-value', row.line, 'Current Stock', 'Only child quantities are tracked; this parent quantity is omitted.', 'disclosure');
      }
      const url = get('Product URL');
      const slug = /^\/([^/]+)\/?$/.exec(url)?.[1] ?? '';
      const handle = validHandle(slug) ? slug : '';
      product = { line: row.line, sku, handle, url: url || undefined, title: get('Name'), state: '', visibility: visible === 'true' ? 'visible' : visible === 'false' ? 'hidden' : '',
        shipping, stock, weight: source.weight(row, 'Weight', ''), base: source.money(row, 'Price', 'Sale Price'),
        grouped: mode === 'variant' || Boolean(get('Option Set')), variants: [] };
      source.products.push(product);
      continue;
    }
    if (item === 'Image' || item === 'Video') {
      source.add('omitted-media-row', row.line, 'Item', 'This media-only source row is excluded.', 'disclosure');
      if (!product) source.add('orphan-media-row', row.line, 'Item', 'Place media below its Product row.');
      if (sku || get('Price') || get('Sale Price') || get('Options') || get('Current Stock') || get('Name')) {
        source.add('mixed-media-row', row.line, 'Item', 'The media row also contains catalog data.');
      }
      continue;
    }
    if (!product) {
      source.add('orphan-catalog-row', row.line, 'Item', 'Place this row after its original Product row.');
      continue;
    }
    if (item === 'Rule' && legacy) {
      sawRule = true;
      if (!sku) {
        if (get('Price') || get('Weight') || get('Sale Price') || get('Allow Purchases')) {
          source.add('unsupported-modifier-rule', row.line, 'Item', 'Modifier rules may change pricing, shipping, or availability and cannot be transferred safely.');
        } else source.add('omitted-modifier-rule', row.line, 'Item', 'This non-SKU modifier rule is omitted.', 'disclosure');
      } else if (rules.has(sku)) source.add('duplicate-legacy-rule', row.line, 'SKU', 'Only one unambiguous native rule may resolve a variant.');
      else rules.set(sku, row);
      continue;
    }
    if (item !== (legacy ? 'SKU' : 'Variant') || sawRule) {
      source.add('unexpected-item', row.line, 'Item', 'Use native variant rows immediately after their matching Product and before any Rule rows.');
      continue;
    }
    product.grouped = true;
    if (!sku) source.add('missing-variant-sku', row.line, 'SKU', 'A BigCommerce variant requires its original SKU.');
    if (!legacy && (get('Name') || get('Type') || get('Inventory Tracking') || get('Is Visible') || get('Product URL'))) {
      source.add('unexpected-variant-product-data', row.line, 'Item', 'Put product-level names, type, and settings on the Product row.');
    }
    if (source.boolean(row, 'Allow Purchases') === 'false') {
      source.add('excluded-legacy-variant', row.line, 'Allow Purchases', 'The target cannot express this disabled variant.');
    }
    const optionField = legacy ? 'Name' : 'Options';
    const rawOptions = parseOptions(get(optionField), legacy);
    if (!rawOptions) source.add('invalid-options', row.line, optionField, 'Keep the original supported BigCommerce variant option expressions.');
    let options = rawOptions ?? [];
    if (product.variants.length) {
      const positions = new Map(product.variants[0].options.map(({ name }, index) => [name, index]));
      options = [...options].sort((a, b) => (positions.get(a.name) ?? Infinity) - (positions.get(b.name) ?? Infinity));
    }
    const qty = source.count(row, 'Current Stock');
    let stock: Stock = unknownStock;
    if (mode === 'variant' || !mode && qty) {
      stock = { mode: 'own', quantity: qty };
      if (!qty) source.add('missing-stock', row.line, 'Current Stock', 'Variant tracking requires each original tracked quantity.');
      if (!mode) source.add('derived-tracking', row.line, 'Current Stock', 'Numeric stock is explicitly tracked in the target.', 'disclosure');
    } else if (mode === 'product') {
      stock = { mode: 'parent', quantity: '' };
      if (qty) source.add('inactive-variant-stock-value', row.line, 'Current Stock', 'This displayed quantity is omitted because the product tracks one shared stock amount.', 'disclosure');
    } else if (mode === 'none') {
      stock = { mode: 'none', quantity: '' };
      if (qty) source.add('untracked-stock-value', row.line, 'Current Stock', 'The source marks this numeric stock as untracked; it is omitted.', 'disclosure');
    }
    const price = get('Price');
    const sale = get('Sale Price');
    if (legacy && sale) source.add('unsupported-legacy-sale', row.line, 'Sale Price', 'The legacy SKU format does not define a separate variant sale price.');
    if (price && !sale && product.base!.sale) source.add('ambiguous-parent-sale', row.line, 'Sale Price', 'The source combines a variant-level price with a parent sale and no explicit variant sale.');
    const prices = !price && sale ? { regular: product.base!.regular, sale } :
      source.money(row, 'Price', 'Sale Price', false, product.base);
    if (!price) source.add('inherited-price', row.line, 'Price', 'The source inherits the regular price from Product line ' + product.line + '.', 'disclosure');
    const weight: Weight | undefined = source.weight(row, 'Weight', '') ?? product.weight;
    const variant = { line: row.line, sku, options, stock, shipping: product.shipping, weight, prices: { ...prices } };
    children.set(sku, { row, variant });
    product.variants.push(variant);
  }
  complete();
  for (const owner of source.products) if (!owner.grouped) owner.variants.push({
    line: owner.line, sku: owner.sku, prices: owner.base!, stock: owner.stock, shipping: owner.shipping, weight: owner.weight, options: [],
  });
  validateCatalog(source, { sku: 'SKU', title: 'Name', option: legacy ? 'Name' : 'Options', handle: 'Product URL' });
  return source;
}
