import { canonicalWooHeader, wooRegularHeader, wooSaleHeader, wooStockHeader } from '../woocommerce-price-diff/source';
import { CatalogSource, identityKey, unknownStock, validateCatalog, type Option, type Product, type Shipping, type State, type Stock, type Variant, type Visibility } from './model';
import type { SourceRow } from '../shopify-price-diff/types';

const attrs = /^Attribute ([1-9]\d{0,2}) (name|value\(s\)|global|visible|default)$/i;
const weightHeader = /^Weight(?: \((kg|g|lbs?|oz|unit)\))?$/i;
export const wooAttribute = (index: number, field: string) => 'Attribute ' + index + ' ' + field;
export const canonicalWooCatalogHeader = (header: string): string => {
  const reference = header.trim();
  const attribute = attrs.exec(reference);
  if (attribute) return wooAttribute(Number(attribute[1]), attribute[2].toLowerCase());
  const weight = weightHeader.exec(reference);
  if (weight) return 'Weight' + (weight[1] ? ' (' + weight[1].toLowerCase() + ')' : '');
  return ['Published', 'Visibility in catalog', 'In stock?', 'Date sale price starts', 'Date sale price ends'].find(field => field.toLowerCase() === reference.toLowerCase())
    ?? canonicalWooHeader(reference);
};

// WooCommerce separates attribute terms with commas and escapes a literal comma with a backslash.
export const wooValue = (value: string) => value.replace(/,/g, '\\,');
const splitWooValues = (value: string) => value.split(/(?<!\\),/).map(part => part.trim().replace(/\\,/g, ','));
const wooStates: Record<string, State> = { '1': 'active', '0': 'private', '-1': 'draft', '2': 'pending', true: 'active', false: 'draft' };
export const wooPublished: Record<Exclude<State, '' | 'archived'>, string> = { active: '1', private: '0', draft: '-1', pending: '2' };

export function readWooCommerceCatalog(bytes: Uint8Array, filename: string): CatalogSource {
  const source = new CatalogSource(bytes, filename, 'woocommerce', canonicalWooCatalogHeader);
  if (!source.require(['Type', 'SKU', 'Name', wooRegularHeader])) return source;
  const indices = [...new Set([...source.columns.keys()].flatMap(field => {
    const matched = attrs.exec(field);
    return matched ? [Number(matched[1])] : [];
  }))].sort((a, b) => a - b);
  for (const index of indices) {
    if (source.columns.has(wooAttribute(index, 'name')) !== source.columns.has(wooAttribute(index, 'value(s)'))) {
      source.add('missing-option-column', source.headerLine, wooAttribute(index, 'name'), 'Include both columns for every WooCommerce attribute.');
    }
  }
  const weights = [...source.columns.keys()].filter(column => weightHeader.test(column));
  if (weights.length > 1) source.add('duplicate-weight-column', source.headerLine, weights[1], 'Keep only one native weight column.');
  const weightColumn = weights[0];
  const rawUnit = (weightColumn && weightHeader.exec(weightColumn)?.[1]) ?? '';
  const unit = rawUnit === 'unit' ? '' : rawUnit === 'lbs' ? 'lb' : rawUnit;
  const owners = new Map<string, Product>();
  const ownerIds = new Map<string, Product>();
  const catalogIds = new Map<string, number>();
  const definitions = new Map<Product, Map<string, { name: string; terms: string[]; field: string }>>();
  const children: { parent: string; variant: Variant; optionFields: Map<Option, string> }[] = [];
  const readState = (row: SourceRow): State => {
    const raw = source.value(row, 'Published').toLowerCase();
    const state = Object.hasOwn(wooStates, raw) ? wooStates[raw] : '';
    if (raw && !state) source.add('invalid-status', row.line, 'Published', 'Use an original WooCommerce publication status.');
    return state;
  };
  for (const row of source.rows) {
    const get = (column: string) => source.value(row, column);
    const [kind, ...rawFlags] = get('Type').split(',');
    const flags = rawFlags.map(flag => flag.trim());
    if (!['simple', 'variable', 'variation'].includes(kind) || flags.some(flag => !['virtual', 'downloadable'].includes(flag)) ||
      new Set(flags).size !== flags.length) {
      source.add('unsupported-product-type', row.line, 'Type', 'Use simple, variable, or variation rows with native WooCommerce type flags.');
      continue;
    }
    if (flags.includes('downloadable')) {
      source.add('omitted-downloadable-files', row.line, 'Type', 'WooCommerce downloadable-file behavior and attachments are omitted.', 'disclosure');
    }
    const id = get('ID');
    if (id) {
      if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9_223_372_036_854_775_807n) {
        source.add('invalid-source-id', row.line, 'ID', 'Keep the original positive product ID or a blank ID for a creation CSV.');
      }
      const first = catalogIds.get(id);
      if (first !== undefined) source.add('duplicate-source-id', row.line, 'ID', 'This ID repeats the native row ID on line ' + first + '.');
      else catalogIds.set(id, row.line);
    }
    const sku = get('SKU');
    const title = get('Name');
    const parent = get('Parent');
    const state = readState(row);
    const weight = weightColumn ? source.weight(row, weightColumn, unit) : undefined;
    const shipping: Shipping = flags.includes('virtual') ? 'digital' : kind === 'variable' ? '' : 'physical';
    const rawStock = get(wooStockHeader);
    const stock: Stock = rawStock === 'parent' ? { mode: 'parent', quantity: '' } : rawStock ?
      { mode: 'own', quantity: source.count(row, wooStockHeader) } : source.columns.has(wooStockHeader) ? { mode: 'none', quantity: '' } : unknownStock;
    if (rawStock === 'parent' && kind !== 'variation') source.add('orphan-stock', row.line, wooStockHeader, 'Only variations can inherit stock.');
    if (kind !== 'variable' && source.boolean(row, 'In stock?') === 'false' &&
      (stock.mode === 'none' || stock.mode === 'unknown' || stock.mode === 'own' && /^\d+$/.test(stock.quantity) && BigInt(stock.quantity) > 0n)) {
      source.add('unrepresentable-stock-status', row.line, 'In stock?', 'The item is explicitly out of stock without a matching tracked quantity.');
    }
    const date = ['Date sale price starts', 'Date sale price ends'].find(column => get(column));
    if (date) source.add('scheduled-sale', row.line, date, 'A scheduled sale cannot become an unconditional target price.');
    const present = indices.flatMap(index => {
      const nameField = wooAttribute(index, 'name');
      const valueField = wooAttribute(index, 'value(s)');
      const name = get(nameField);
      const raw = get(valueField);
      if (!name && !raw) return [];
      if (!name || !raw || raw.split(/(?<!\\),/).some(value => !value.trim())) {
        source.add('incomplete-attribute', row.line, valueField, 'Use an attribute name and nonempty terms.');
      }
      const terms = splitWooValues(raw);
      return [{ name, terms, valueField }];
    });
    if (kind === 'variation') {
      const optionFields = new Map<Option, string>();
      const seen = new Set<string>();
      const options = present.map(({ name, terms, valueField }) => {
        if (terms.length !== 1) source.add('ambiguous-variant-option', row.line, valueField, 'A variation needs one exact term per option.');
        const key = identityKey(name);
        if (seen.has(key)) source.add('duplicate-variant-attribute', row.line, valueField, 'This option name occurs more than once on the variation.');
        seen.add(key);
        const option = { name, value: terms[0] };
        optionFields.set(option, valueField);
        return option;
      });
      if (title) source.add('variation-title', row.line, 'Name', 'WooCommerce’s separate variation title is omitted.', 'disclosure');
      children.push({ parent, optionFields, variant: { line: row.line, sku, options, state, stock, weight, shipping,
        prices: source.money(row, wooRegularHeader, wooSaleHeader) } });
      continue;
    }
    if (parent) source.add('unexpected-parent', row.line, 'Parent', 'Only a variation can refer to a parent.');
    const rawVisibility = get('Visibility in catalog').toLowerCase();
    const visibility: Visibility = rawVisibility === 'visible' || rawVisibility === 'hidden' || rawVisibility === 'catalog' ||
      rawVisibility === 'search' ? rawVisibility : '';
    if (rawVisibility && !visibility) source.add('invalid-visibility', row.line, 'Visibility in catalog', 'Use the original WooCommerce catalog visibility.');
    const product: Product = { line: row.line, sku, title, handle: '', state, visibility, shipping, weight, stock, grouped: kind === 'variable', variants: [] };
    source.products.push(product);
    if (sku) owners.set(sku, product);
    if (id) ownerIds.set(id, product);
    if (product.grouped) {
      const options = new Map<string, { name: string; terms: string[]; field: string }>();
      for (const { name, terms, valueField } of present) {
        if (options.has(identityKey(name)) || new Set(terms.map(identityKey)).size !== terms.length) {
          source.add('duplicate-parent-attribute', row.line, valueField, 'The parent has duplicate attribute names or terms.');
        }
        options.set(identityKey(name), { name, terms, field: valueField });
      }
      definitions.set(product, options);
      if (get(wooRegularHeader) || get(wooSaleHeader)) {
        product.base = source.money(row, wooRegularHeader, wooSaleHeader);
        source.add('woo-parent-price', row.line, wooRegularHeader, 'WooCommerce variable parent prices are not independently purchasable; child prices determine the sale.', 'disclosure');
      }
    } else {
      if (present.length) source.add('omitted-product-attributes', row.line, present[0].valueField, 'Non-variant product attributes are omitted.', 'disclosure');
      product.variants.push({ line: row.line, sku, options: [], shipping, weight, stock, prices: source.money(row, wooRegularHeader, wooSaleHeader) });
    }
  }
  for (const { variant, parent, optionFields } of children) {
    const product = parent.startsWith('id:') ? ownerIds.get(parent.slice(3)) : owners.get(parent);
    const available = product && definitions.get(product);
    if (!product || !available) {
      source.add('orphan-variation', variant.line, 'Parent', 'Use the exact variable parent SKU or id:ID from this export.');
      continue;
    }
    if (variant.stock.mode === 'parent' && product.stock.mode !== 'own') {
      source.add('unknown-inherited-stock', variant.line, wooStockHeader, 'The parent’s original tracked quantity is missing.');
    }
    for (const option of variant.options) {
      const definition = available.get(identityKey(option.name));
      if (definition?.name !== option.name || !definition.terms.includes(option.value)) {
        source.add('unknown-variant-option', variant.line, optionFields.get(option)!, 'The variant option is not an exact term declared on its parent.');
      }
    }
    // Parent order defines the dimensions even if a WooCommerce child lists columns in another order.
    const byName = new Map(variant.options.map(option => [option.name, option]));
    variant.options = [...available.values()].flatMap(({ name }) => byName.has(name) ? [byName.get(name)!] : []);
    variant.weight ??= product.weight;
    product.variants.push(variant);
  }
  for (const [product, options] of definitions) {
    const used = new Map<string, Set<string>>();
    for (const variant of product.variants) for (const { name, value } of variant.options) {
      const values = used.get(name) ?? new Set<string>();
      values.add(value);
      used.set(name, values);
    }
    for (const { name, terms, field } of options.values()) {
      if (terms.some(value => !used.get(name)?.has(value))) {
        source.add('omitted-unused-terms', product.line, field, 'Parent terms without matching purchasable variants are omitted.', 'disclosure');
      }
    }
  }
  validateCatalog(source, { sku: 'SKU', title: 'Name', option: 'Attribute 1 value(s)' });
  return source;
}
