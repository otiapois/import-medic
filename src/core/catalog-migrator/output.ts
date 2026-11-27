import { bigCommerceFileLimit } from '../bigcommerce-price-diff/source';
import { guardSpreadsheetCell } from '../formula-guard';
import { amountGreaterThan } from '../shopify-price-diff/prices';
import { compareAtHeader, inventoryHeader, optionNames, optionValues, priceHeader, skuHeader } from '../shopify-price-diff/source';
import { wooRegularHeader, wooSaleHeader, wooStockHeader } from '../woocommerce-price-diff/source';
import { identityKey, plainAmount, validHandle, wooStableText, issue, type CatalogPlatform, type CatalogSource, type Product, type State, type Variant, type Weight } from './model';
import { wooAttribute, wooPublished, wooValue } from './woocommerce';

type Cells = Record<string, string>;
interface OutputRow { line: number; cells: Cells }
export interface TargetTable { headers: string[]; rows: string[][]; lines: number[] }

const grams = 'Variant Grams';
const requiresShipping = 'Variant Requires Shipping';
const tracker = 'Variant Inventory Tracker';
const legacyId = /^(?:id:)/i;
const negativeQuantity = /^-\d*[1-9]/;
const unitGrams: Record<string, { units: bigint; scale: number }> = {
  g: { units: 1n, scale: 0 }, kg: { units: 1000n, scale: 0 },
  lb: { units: 45359237n, scale: 5 }, oz: { units: 28349523125n, scale: 9 },
};

export function writeTarget(source: CatalogSource, target: CatalogPlatform): TargetTable {
  const disclosure = (code: string, line: number | null, column: string, message: string) =>
    issue(source.issues, code, line, column, message, 'disclosure');
  const blocked = (code: string, line: number, column: string, message: string) => issue(source.issues, code, line, column, message);
  const records: OutputRow[] = [];
  const add = (line: number, cells: Cells) => records.push({ line, cells });
  const products = source.products;
  const allVariants = products.flatMap(product => product.variants);
  const handles = new Map<string, number>();
  const usedSkus = new Set(products.flatMap(product => [product.sku, ...product.variants.map(variant => variant.sku)]).filter(Boolean).map(identityKey));
  const dimensions = products.reduce((greatest, product) => Math.max(greatest, product.variants[0].options.length), 0);
  const targetSku = target === 'shopify' ? skuHeader : 'SKU';
  const handlesFor = (product: Product, field: string) => {
    const derived = product.sku.toLowerCase();
    const handle = product.handle || (validHandle(derived) ? derived :
      product.title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, ''));
    if (!validHandle(handle)) blocked('missing-target-handle', product.line, field, 'Supply a source SKU or title from which a valid destination handle can be formed.');
    if (!product.handle && handle) disclosure('derived-handle', product.line, field, 'The destination slug is derived from the source SKU or title because the source has no native handle.');
    const key = identityKey(handle);
    const first = handles.get(key);
    if (first !== undefined) blocked('duplicate-target-handle', product.line, field, 'This destination handle collides with line ' + first + '.');
    else handles.set(key, product.line);
    return handle;
  };
  const checkSku = (sku: string, line: number) => {
    if (target === 'woocommerce' && sku && (!wooStableText(sku) || legacyId.test(sku))) {
      blocked('unrepresentable-woo-sku', line, targetSku, 'WooCommerce may normalize this SKU or interpret it as a parent ID.');
    }
    if (target === 'bigcommerce' && sku.length > 255) blocked('bigcommerce-sku-too-long', line, targetSku, 'BigCommerce SKUs are limited to 255 characters.');
  };
  const checkVariant = (product: Product, variant: Variant) => {
    checkSku(variant.sku, variant.line);
    if (variant.state && variant.state !== 'active') {
      blocked('disabled-variant', variant.line, 'Published', 'The target cannot preserve a separate disabled or unpublished variant.');
    }
    if (variant.state === 'active') disclosure('inherited-variant-status', variant.line, 'Published', 'The target variant follows product-level publication.');
    for (const option of variant.options) {
      if (option.config) disclosure('omitted-swatch-config', variant.line, 'Options', 'Swatch colors or images are omitted. The exact option label is retained.');
      else if (option.type && option.type !== 'Dropdown') disclosure('omitted-option-presentation', variant.line, 'Options', 'The original BigCommerce option display style is omitted.');
      if (target === 'woocommerce' && [option.name, option.value].some(value => !wooStableText(value) || value.includes('\\'))) {
        blocked('unrepresentable-woo-option', variant.line, 'Attribute 1 value(s)', 'WooCommerce can reinterpret this option text or its escape characters.');
      }
      if (target === 'bigcommerce' && [option.name, option.value].some(value => /[|=]/.test(value))) {
        blocked('unrepresentable-bigcommerce-option', variant.line, 'Options', 'Option names and values cannot contain BigCommerce’s separator characters.');
      }
    }
    if (target === 'shopify' && (variant.stock.mode === 'parent' || product.grouped && product.stock.mode === 'own')) {
      blocked('unrepresentable-shared-stock', variant.line, inventoryHeader, 'A shared parent quantity cannot safely become several Shopify variant quantities.');
    }
    if (target === 'bigcommerce' && negativeQuantity.test(variant.stock.quantity)) {
      blocked('negative-bigcommerce-stock', variant.line, 'Current Stock', 'BigCommerce cannot represent a negative tracked quantity.');
    }
  };
  const stateFor = (product: Product): Exclude<State, ''> => {
    if (product.state) return product.state;
    const derived = product.visibility === 'visible' ? 'active' : 'draft';
    if (target !== 'bigcommerce') disclosure('derived-status', product.line, 'Status', product.visibility === 'visible' ?
      'Known storefront visibility maps to active.' : 'The destination uses draft because there is no published source status.');
    return derived;
  };
  const sellable = (product: Product): boolean => {
    if (product.state && product.state !== 'active') return false;
    if (product.visibility === 'catalog' || product.visibility === 'search') {
      disclosure('partial-visibility', product.line, 'Visibility in catalog', 'The target cannot split search and catalog visibility; this row stays hidden.');
      return false;
    }
    if (source.dialect === 'woocommerce' && product.visibility === 'hidden') {
      disclosure('lossy-visibility', product.line, 'Visibility in catalog', 'WooCommerce’s direct-link visibility is not preserved. The target stays hidden.');
    }
    if (!product.visibility) {
      disclosure('derived-visibility', product.line, 'Published', 'The destination stays hidden because source storefront visibility is unspecified.');
    }
    return product.visibility === 'visible';
  };
  const weightForShopify = (weight: Weight | undefined, physical: boolean): string => {
    if (!weight) return '';
    const factor = unitGrams[weight.unit];
    const decimal = plainAmount(weight.amount)!;
    if (decimal.units === 0n) return '0';
    if (!factor) {
      disclosure('omitted-weight-unit', weight.line, grams, 'The original store’s weight unit is not present in the CSV. The numeric weight is omitted.');
      return '';
    }
    const numerator = decimal.units * factor.units;
    const denominator = 10n ** BigInt(decimal.scale + factor.scale);
    if (numerator % denominator !== 0n) {
      disclosure('omitted-fractional-grams', weight.line, grams, 'The exact source weight is not a whole number of grams. The numeric weight is omitted.');
      return '';
    }
    if (weight.unit !== 'g') disclosure('converted-weight-to-grams', weight.line, grams, 'The original weight is converted to exact whole grams.');
    if (!physical) disclosure('digital-weight', weight.line, grams, 'The source contains a weight for a non-shipping item. The weight is omitted.');
    return physical ? (numerator / denominator).toString() : '';
  };
  let headers: string[];
  if (target === 'shopify') {
    headers = ['Handle', 'Title', ...optionNames.flatMap((name, index) => [name, optionValues[index]]), skuHeader, priceHeader, compareAtHeader,
      tracker, inventoryHeader, grams, requiresShipping, 'Status', 'Published'];
    for (const product of products) {
      const handle = handlesFor(product, 'Handle');
      const state = stateFor(product);
      if (state === 'private' || state === 'pending') disclosure('lossy-status', product.line, 'Status', 'WooCommerce private or pending status is represented as draft.');
      if (product.url && product.url !== '/' + handle && product.url !== '/' + handle + '/') {
        disclosure('omitted-product-url', product.line, 'Product URL', 'The destination can carry a handle, but the original full URL path is omitted.');
      }
      if (product.grouped && product.sku) disclosure('omitted-parent-sku', product.line, 'SKU', 'Shopify has variant SKUs. The separate parent SKU is omitted.');
      if (product.grouped && product.base) disclosure('omitted-parent-price', product.line, 'Price', 'Shopify stores prices on variants. The separate parent price is omitted.');
      if (product.variants.length > 2048) blocked('too-many-shopify-variants', product.line, 'Handle', 'Shopify accepts at most 2,048 variants per product.');
      if (product.variants[0].options.length > optionNames.length) blocked('too-many-shopify-options', product.line, 'Option3 Name', 'Shopify permits up to three named option dimensions.');
      const published = sellable(product) ? 'TRUE' : 'FALSE';
      for (const [index, variant] of product.variants.entries()) {
        checkVariant(product, variant);
        const options = variant.options.length ? variant.options : [{ name: 'Title', value: 'Default Title' }];
        const physical = variant.shipping !== 'digital';
        if (!variant.shipping) disclosure('default-shipping', variant.line, requiresShipping, 'The source omits shipping type. Shopify’s native creation default is physical.');
        const cells: Cells = {
          Handle: handle, Title: index ? '' : product.title, [skuHeader]: variant.sku,
          [priceHeader]: variant.prices.sale || variant.prices.regular, [compareAtHeader]: variant.prices.sale ? variant.prices.regular : '',
          [tracker]: variant.stock.mode === 'own' ? 'shopify' : '', [inventoryHeader]: variant.stock.quantity,
          [grams]: weightForShopify(variant.weight, physical), [requiresShipping]: physical ? 'TRUE' : 'FALSE',
          Status: index ? '' : state === 'private' || state === 'pending' ? 'draft' : state, Published: index ? '' : published,
        };
        for (const [dimension, option] of options.slice(0, optionNames.length).entries()) {
          cells[optionNames[dimension]] = index ? '' : option.name;
          cells[optionValues[dimension]] = option.value;
        }
        add(variant.line, cells);
      }
    }
  } else if (target === 'woocommerce') {
    const weights = [...products.map(product => product.weight), ...allVariants.map(variant => variant.weight)].filter(weight => weight !== undefined);
    const unit = weights[0]?.unit;
    const weightColumn = 'Weight (' + (unit || 'unit') + ')';
    if (weights.length) disclosure('destination-weight-unit', null, weightColumn, unit ?
      'The destination store must use ' + unit + ' as the weight unit.' : 'Match the destination weight unit to the source store and map the Weight column.');
    headers = ['ID', 'Type', 'SKU', 'Name', 'Parent', wooRegularHeader, wooSaleHeader, wooStockHeader, 'Published', 'Visibility in catalog',
      ...(weights.length ? [weightColumn] : []), ...Array.from({ length: dimensions }, (_, i) => ['name', 'value(s)', 'global'].map(field => wooAttribute(i + 1, field))).flat()];
    for (const product of products) {
      let state = stateFor(product);
      const visibility = product.visibility || 'hidden';
      if (state === 'archived') disclosure('lossy-status', product.line, 'Published', 'An archived product is carried as a draft.');
      if (state === 'active' && product.visibility === 'hidden' && source.dialect === 'shopify') {
        state = 'private';
        disclosure('lossy-status', product.line, 'Published', 'An active Shopify product withheld from the online store becomes private to keep it unavailable to customers.');
      }
      if (!product.visibility) disclosure('derived-visibility', product.line, 'Visibility in catalog', 'The destination stays hidden because source storefront visibility is unspecified.');
      if (product.handle || product.url) disclosure('omitted-native-handle', product.line, 'Handle', 'WooCommerce’s built-in product CSV has no native slug field.');
      if (product.grouped && product.base) disclosure('omitted-parent-price', product.line, 'Price', 'WooCommerce prices come from the variations. The separate parent price is omitted.');
      if (!wooStableText(product.title) || /[\r\n\t]/.test(product.title) || product.title !== product.title.trim()) {
        blocked('unrepresentable-woo-title', product.line, 'Name', 'WooCommerce text cleanup could change the exact product title.');
      }
      const base: Cells = {
        ID: '', Name: product.title, SKU: product.sku, Published: state === 'archived' ? '-1' : wooPublished[state],
        'Visibility in catalog': state === 'archived' ? 'hidden' : visibility, [weightColumn]: product.weight?.amount ?? '',
      };
      let parentSku = product.sku;
      if (product.grouped) {
        if (!parentSku) {
          const usableHandle = product.handle && !usedSkus.has(identityKey(product.handle));
          parentSku = usableHandle ? product.handle : 'im-parent-' + product.line;
          while (usedSkus.has(identityKey(parentSku))) parentSku += '-x';
          usedSkus.add(identityKey(parentSku));
          disclosure('derived-parent-sku', product.line, 'SKU', 'A unique native WooCommerce parent SKU is derived solely to link the creation rows.');
        }
        checkSku(parentSku, product.line);
        const cells: Cells = { ...base, Type: 'variable', SKU: parentSku, [wooStockHeader]: product.stock.quantity };
        for (const [index, { name }] of product.variants[0].options.entries()) {
          cells[wooAttribute(index + 1, 'name')] = name;
          cells[wooAttribute(index + 1, 'value(s)')] = [...new Set(product.variants.map(variant => variant.options[index].value))].map(wooValue).join(', ');
          cells[wooAttribute(index + 1, 'global')] = '0';
        }
        add(product.line, cells);
      }
      for (const variant of product.variants) {
        checkVariant(product, variant);
        if (!variant.shipping) disclosure('default-shipping', variant.line, 'Type', 'The source omits shipping type. WooCommerce’s native creation default is physical.');
        const cells: Cells = {
          ...(!product.grouped ? base : { ID: '', Name: product.title, Parent: parentSku, Published: '1' }),
          Type: (product.grouped ? 'variation' : 'simple') + (variant.shipping === 'digital' ? ', virtual' : ''),
          SKU: variant.sku, [wooRegularHeader]: variant.prices.regular, [wooSaleHeader]: variant.prices.sale,
          [wooStockHeader]: variant.stock.mode === 'parent' ? 'parent' : variant.stock.quantity, [weightColumn]: variant.weight?.amount ?? '',
        };
        if (product.grouped) disclosure('derived-variation-name', variant.line, 'Name', 'The required variation Name is seeded from the product’s exact title.');
        for (const [index, { name, value }] of variant.options.entries()) {
          cells[wooAttribute(index + 1, 'name')] = name;
          cells[wooAttribute(index + 1, 'value(s)')] = wooValue(value);
          cells[wooAttribute(index + 1, 'global')] = '0';
        }
        add(variant.line, cells);
      }
    }
  } else {
    headers = ['Item', 'ID', 'Type', 'Name', 'SKU', 'Options', 'Price', 'Sale Price', 'Weight', 'Current Stock', 'Inventory Tracking', 'Is Visible', 'Product URL'];
    const weightUnit = products.find(product => product.weight || product.variants.some(variant => variant.weight));
    const unit = weightUnit?.weight?.unit || weightUnit?.variants.find(variant => variant.weight)?.weight?.unit;
    if (weightUnit) disclosure('destination-weight-unit', null, 'Weight', unit ?
      'The destination store must use ' + unit + ' as the weight unit.' : 'The destination weight unit must match the original store.');
    for (const product of products) {
      const first = product.variants[0];
      const types = new Set(product.variants.map(variant => variant.shipping || product.shipping));
      const shipping = types.size === 1 ? [...types][0] : '';
      if (!shipping) blocked('missing-or-mixed-bigcommerce-type', product.line, 'Type', 'BigCommerce requires one explicit physical or digital type for the entire product.');
      if (product.variants.length > 600) blocked('too-many-bigcommerce-variants', product.line, 'Options', 'BigCommerce accepts at most 600 variants per product.');
      if (product.state && product.state !== 'active') disclosure('lossy-status', product.line, 'Is Visible', 'The separate lifecycle status is represented as hidden.');
      checkSku(product.sku, product.line);
      let inventory = 'none';
      if (product.grouped && product.stock.mode === 'own') {
        inventory = 'product';
        if (product.variants.some(variant => variant.stock.mode !== 'parent')) {
          blocked('mixed-stock', product.line, 'Inventory Tracking', 'A shared product quantity cannot coexist with independently tracked or untracked variants.');
        }
      } else if (product.grouped && product.variants.some(variant => variant.stock.mode === 'own')) {
        inventory = 'variant';
        if (product.variants.some(variant => variant.stock.mode !== 'own')) {
          blocked('mixed-stock', product.line, 'Inventory Tracking', 'BigCommerce requires tracking for either every variant or none of them.');
        }
      } else if (!product.grouped && first.stock.mode === 'own') inventory = 'product';
      const quantity = product.grouped ? product.stock.quantity : first.stock.quantity;
      if (inventory === 'product' && negativeQuantity.test(quantity)) {
        blocked('negative-bigcommerce-stock', product.line, 'Current Stock', 'BigCommerce cannot represent a negative tracked quantity.');
      }
      let base = product.base ?? first.prices;
      if (product.grouped) {
        const minimum = product.variants.reduce((best, variant) =>
          amountGreaterThan(plainAmount(best.prices.regular)!, plainAmount(variant.prices.regular)!) ? variant : best, first);
        base = { regular: minimum.prices.regular, sale: '' };
        disclosure('derived-parent-price', product.line, 'Price', 'The required base price is the lowest exact variant regular price. Each variant retains its own absolute prices.');
      }
      const weight = product.weight ?? product.variants.find(variant => variant.weight)?.weight;
      if (shipping === 'physical' && !weight) {
        blocked('missing-bigcommerce-weight', product.line, 'Weight', 'The modern importer requires a real source weight for physical products.');
      }
      if (shipping === 'physical' && weight && product.grouped && !product.weight) {
        disclosure('derived-parent-weight', product.line, 'Weight', 'The required product weight is copied from an explicit variant weight.');
      }
      const handle = handlesFor(product, 'Product URL');
      const visibility = sellable(product) ? 'TRUE' : 'FALSE';
      add(product.line, {
        Item: 'Product', ID: '', Type: shipping, Name: product.title, SKU: product.sku, Price: base.regular, 'Sale Price': base.sale,
        Weight: shipping === 'physical' ? weight?.amount ?? '' : '',
        'Current Stock': inventory === 'product' ? quantity : '', 'Inventory Tracking': inventory, 'Is Visible': visibility, 'Product URL': '/' + handle + '/',
      });
      for (const variant of product.variants) {
        checkVariant(product, variant);
        if (variant.shipping === 'digital' && variant.weight?.amount && plainAmount(variant.weight.amount)?.units !== 0n) {
          disclosure('digital-weight', variant.line, 'Weight', 'The numeric weight of this digital item is omitted.');
        }
        if (!product.grouped) continue;
        if (!variant.sku) blocked('missing-bigcommerce-variant-sku', variant.line, 'SKU', 'A BigCommerce variant requires an explicit source SKU.');
        if (shipping === 'physical' && !variant.weight) blocked('missing-bigcommerce-weight', variant.line, 'Weight', 'Every physical variant needs an original weight or an explicit source parent weight.');
        add(variant.line, { Item: 'Variant', ID: '', SKU: variant.sku,
          Options: variant.options.map(option => 'Type=Dropdown|Name=' + option.name + '|Value=' + option.value).join('\n'),
          Price: variant.prices.regular, 'Sale Price': variant.prices.sale,
          Weight: shipping === 'physical' ? variant.weight?.amount ?? '' : '', 'Current Stock': inventory === 'variant' ? variant.stock.quantity : '',
        });
      }
    }
  }
  const rows = records.map(record => headers.map(header => {
    const value = record.cells[header] ?? '';
    if (guardSpreadsheetCell(value) !== value) blocked('unsafe-target-cell', record.line, header, 'The native cell would require a meaning-changing formula escape.');
    return value;
  }));
  return { headers, rows, lines: records.map(record => record.line) };
}

export function targetLimit(source: CatalogSource, target: CatalogPlatform, bytes: Uint8Array): void {
  if (target === 'bigcommerce' && bytes.byteLength > bigCommerceFileLimit) {
    source.add('bigcommerce-file-limit', source.headerLine, null, 'Split the source catalog into complete products. BigCommerce CSV imports are limited to 20 MB.');
  }
}
