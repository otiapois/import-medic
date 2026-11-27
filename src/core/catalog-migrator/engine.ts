import { sha256 } from '../audit/custody';
import { parseCsv, serializeCsv } from '../csv';
import { brandSignoffHtml, type SignoffBrand } from '../branding/signoff-brand';
import { custodyFooter, escapeReportText, offlineReportCsp } from '../report-html';
import { compareAtHeader, inventoryHeader, optionNames, optionValues, parseBaseline, priceHeader, skuHeader } from '../shopify-price-diff/source';
import { parseWooCommerceBaseline, wooRegularHeader, wooSaleHeader, wooStockHeader } from '../woocommerce-price-diff/source';
import { readBigCommerce } from './bigcommerce';
import { type CatalogDialect, type CatalogMigrationResult, type CatalogPlatform, type CatalogSource, type Product } from './model';
import { targetLimit, writeTarget, type TargetTable } from './output';
import { readShopify } from './shopify';
import { readWooCommerceCatalog, wooAttribute } from './woocommerce';

export type { CatalogDialect, CatalogMigrationResult, CatalogPlatform, FieldMapping, MigrationIssue } from './model';

const parser = { shopify: readShopify, woocommerce: readWooCommerceCatalog, bigcommerce: readBigCommerce };
const labels: Record<CatalogDialect, string> = {
  shopify: 'Shopify Products CSV', woocommerce: 'WooCommerce Products CSV',
  'bigcommerce-legacy': 'BigCommerce legacy Product / SKU CSV', 'bigcommerce-modern': 'BigCommerce modern Product / Variant CSV',
};
const encode = (value: string) => new TextEncoder().encode(value);
const countVariants = (products: Product[]) => products.reduce((count, product) => count + product.variants.length, 0);
const priceTarget = (target: CatalogPlatform) => target === 'shopify' ? priceHeader + ' / ' + compareAtHeader :
  target === 'woocommerce' ? wooRegularHeader + ' / ' + wooSaleHeader : 'Price / Sale Price';

function fieldMappings(source: CatalogSource, target: CatalogPlatform, output: TargetTable | null) {
  const shopify = source.dialect === 'shopify';
  const woo = source.dialect === 'woocommerce';
  const targetSku = target === 'shopify' ? skuHeader : 'SKU';
  const targetName = target === 'shopify' ? 'Title' : 'Name';
  const targetStock = target === 'shopify' ? inventoryHeader : target === 'woocommerce' ? wooStockHeader : 'Current Stock';
  const targetTracking = target === 'shopify' ? 'Variant Inventory Tracker' : target === 'woocommerce' ? wooStockHeader : 'Inventory Tracking';
  const targetVisibility = target === 'shopify' ? 'Status / Published' : target === 'woocommerce' ? 'Published / Visibility in catalog' : 'Is Visible';
  const targetHandle = target === 'woocommerce' ? null : target === 'shopify' ? 'Handle' : 'Product URL';
  const targetWeight = target === 'bigcommerce' ? 'Weight' : target === 'shopify' ? 'Variant Grams' :
    output?.headers.find(header => header.startsWith('Weight (')) ?? 'Weight (unit)';
  source.map(shopify ? skuHeader : 'SKU', targetSku, 'Exact SKU text. Review any separately disclosed parent SKU change.');
  source.map(shopify ? 'Title' : 'Name', targetName + (source.dialect === 'bigcommerce-legacy' ? ' / variant options' : ''));
  source.map(shopify ? priceHeader : woo ? wooRegularHeader : 'Price', priceTarget(target), 'Regular/list and active/sale prices are resolved independently.');
  source.map(shopify ? compareAtHeader : woo ? wooSaleHeader : 'Sale Price', priceTarget(target), 'A sale must be strictly below the regular/list price.');
  source.map(shopify ? inventoryHeader : woo ? wooStockHeader : 'Current Stock', targetStock, 'Exact tracked quantity when supported.');
  source.map(shopify ? 'Variant Inventory Tracker' : 'Inventory Tracking', targetTracking);
  const handleSource = shopify ? 'Handle' : 'Product URL';
  source.map(handleSource, targetHandle, targetHandle ?
    'Preserves a compatible native slug. Path or slug derivation differences are disclosed by row.' : 'WooCommerce’s built-in importer has no native product-slug field.');
  for (const field of shopify ? ['Status', 'Published'] : woo ? ['Published', 'Visibility in catalog'] : ['Is Visible']) {
    source.map(field, targetVisibility, 'Publication and catalog visibility use the destination’s native flags. Any loss of meaning is disclosed by row.');
  }
  for (const field of !woo ? [shopify ? 'Variant Grams' : 'Weight'] : [...source.columns.keys()].filter(field => /^Weight(?: |$)/.test(field))) {
    source.map(field, target === 'shopify' && !woo ? null : targetWeight, target === 'shopify' && !woo ?
      'A native BigCommerce CSV does not identify the source unit, so only a weight of zero is unambiguous.' : 'Weights are carried only where their units can be identified or matched in the destination store.');
  }
  if (shopify) {
    source.map('Variant Requires Shipping', target === 'woocommerce' ? 'Type' : 'Type');
    optionNames.forEach((field, index) => source.map(field, target === 'woocommerce' ? wooAttribute(index + 1, 'name') : 'Options'));
    optionValues.forEach((field, index) => source.map(field, target === 'woocommerce' ? wooAttribute(index + 1, 'value(s)') : 'Options'));
  } else {
    source.map('Type', target === 'shopify' ? 'Variant Requires Shipping' : 'Type');
    source.map('ID', null, 'Original store IDs are deliberately excluded from creation CSVs.');
    if (woo) {
      source.map('Parent', target === 'shopify' ? 'Handle' : 'Item order');
      for (const field of source.columns.keys()) {
        const match = /^Attribute (\d+) (name|value\(s\))$/.exec(field);
        if (match) source.map(field, target === 'bigcommerce' ? 'Options' :
          (match[2] === 'name' ? optionNames : optionValues)[Number(match[1]) - 1] ?? 'Option names / values');
      }
    } else {
      source.map('Item', target === 'shopify' ? 'Handle' : 'Type / Parent');
      source.map('Options', target === 'shopify' ? 'Option names / values' : 'Attribute names / values');
    }
  }
  return source.headers.map(header => source.mappings.get(header) ?? { source: header, target: null, notes: 'No native field is carried in this migration.' });
}

function structuralParity(original: Product[], migrated: Product[], target: CatalogPlatform): boolean {
  return original.length === migrated.length && original.every((product, i) => {
    const actual = migrated[i];
    return product.title === actual.title && product.grouped === actual.grouped &&
      (!product.grouped || target === 'shopify' || !product.sku || product.sku === actual.sku) &&
      (target === 'woocommerce' || !product.handle || product.handle === actual.handle) &&
      product.variants.length === actual.variants.length && (product.stock.mode !== 'own' ||
        !product.grouped || product.stock.quantity === actual.stock.quantity) &&
      product.variants.every((variant, j) => {
        const other = actual.variants[j];
        const tracked = variant.stock.mode === 'own' || variant.stock.mode === 'parent';
        return variant.sku === other.sku && variant.prices.regular === other.prices.regular && variant.prices.sale === other.prices.sale &&
          (tracked ? variant.stock.mode === other.stock.mode && variant.stock.quantity === other.stock.quantity :
            other.stock.mode === 'unknown' || other.stock.mode === 'none') &&
          (variant.shipping === '' || variant.shipping === other.shipping) &&
          JSON.stringify(variant.options.map(({ name, value }) => [name, value])) ===
            JSON.stringify(other.options.map(({ name, value }) => [name, value]));
      });
  });
}

function verifyTarget(source: CatalogSource, target: CatalogPlatform, csv: string, bytes: Uint8Array, table: TargetTable): Product[] | null {
  const converted = parser[target](bytes, 'Target catalog');
  const problems = converted.issues.filter(problem => problem.level === 'blocked');
  // The established storefront parsers exercise the consumers that also read these CSVs.
  // The modern BigCommerce parser above intentionally leaves the separate legacy updates-only parser strict.
  const baseline = target === 'shopify' ? parseBaseline(bytes, 'Target catalog', { requireUtf8: true, retainEmptyRecords: true }) :
    target === 'woocommerce' ? parseWooCommerceBaseline(bytes, 'Target catalog', { requireUtf8: true, retainEmptyRecords: true }) : null;
  if (baseline) {
    for (const problem of baseline.issues) if (problem.code !== 'woo-needs-destination-ids') {
      problems.push({ code: problem.code, line: problem.row ?? null, column: problem.column ?? null, message: problem.message, level: 'blocked' });
    }
  }
  if (problems.length) {
    const { records } = parseCsv(csv);
    const sourceLines = new Map(records.slice(1).map((record, index) => [record.line, table.lines[index]]));
    for (const problem of problems) source.add('target-' + problem.code, sourceLines.get(problem.line ?? -1) ?? source.headerLine, problem.column, problem.message);
    return null;
  }
  if (!structuralParity(source.products, converted.products, target)) {
    source.add('target-parity-mismatch', source.headerLine, null, 'Re-parsing the emitted CSV changed a product group, identity, option, stock, shipping type, or price.');
    return null;
  }
  return converted.products;
}

type AuditData = Omit<CatalogMigrationResult, 'artifacts' | 'preview' | 'custody'> & { custody: Omit<CatalogMigrationResult['custody'], 'signOffSha256'> };
function signoff(data: AuditData, branding?: SignoffBrand): string {
  const esc = (value: string | number | null) => escapeReportText(value === null ? '—' : String(value));
  const mapping = data.mapping.map(field => '<tr><th scope="row">' + esc(field.source) + '</th><td>' + esc(field.target ?? 'Unmapped') +
    '</td><td>' + esc(field.notes) + '</td></tr>').join('');
  const lines = data.issues.map(item => '<tr><td>' + esc(item.line) + '</td><td>' + esc(item.column) + '</td><td>' + esc(item.level) +
    '</td><td>' + esc(item.code) + '</td><td>' + esc(item.message) + '</td></tr>').join('');
  return brandSignoffHtml('<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="' + offlineReportCsp + '"><title>Migration Sign-Off</title>' +
    '<style>body{max-width:72rem;margin:2rem auto;padding:0 1rem;color:#192638;background:#fff;font:1rem/1.5 system-ui,sans-serif}' +
    'table{width:100%;border-collapse:collapse}th,td{border:1px solid #aeb8c6;text-align:left;padding:.5rem;vertical-align:top;overflow-wrap:anywhere}' +
    'th{background:#eef3fa}code,dd,p,li{overflow-wrap:anywhere}dd{margin:0 0 .7rem}caption{text-align:left;font-weight:650;margin:.8rem 0}' +
    '@media(max-width:36rem){body{margin:1rem auto;padding:0 .7rem}th,td{padding:.3rem;font-size:.85rem}}' +
    '@media print{body{margin:0;padding:0}tr{break-inside:avoid}}</style></head><body><main><h1>Migration Sign-Off</h1>' +
    '<p>' + esc(labels[data.sourceDialect]) + ' to ' + esc(labels[data.targetDialect]) + '</p><p>Source file <strong>' + esc(data.sourceFilename) + '</strong></p>' +
    '<table><caption>Catalog counts</caption><thead><tr><th scope="col">Catalog</th><th scope="col">Products</th><th scope="col">Sellable rows</th></tr></thead><tbody>' +
    '<tr><th scope="row">Source</th><td>' + data.summary.sourceProducts + '</td><td>' + data.summary.sourceVariants + '</td></tr>' +
    '<tr><th scope="row">Target</th><td>' + data.summary.targetProducts + '</td><td>' + data.summary.targetVariants + '</td></tr></tbody></table>' +
    '<p><strong>Variant parity</strong> ' + (data.summary.variantParity ? 'Verified by re-parsing the target CSV.' : 'Target CSV held for review.') + '</p>' +
    '<p>Catalog files use the destination store’s currency and inventory setup. Verify settings before importing. ' +
    'This report records local CSV verification. It does not record a store import.</p>' +
    '<table><caption>Field mapping and unmapped columns</caption><thead><tr><th scope="col">Source column</th><th scope="col">Target field</th>' +
    '<th scope="col">Notes</th></tr></thead><tbody>' + mapping + '</tbody></table>' +
    '<table><caption>Source line disclosures and issues</caption><thead><tr><th scope="col">Line</th><th scope="col">Column</th>' +
    '<th scope="col">Level</th><th scope="col">Code</th><th scope="col">Detail</th></tr></thead><tbody>' + lines + '</tbody></table></main>' +
    custodyFooter([['Source CSV SHA-256', data.custody.sourceSha256], ['Target CSV SHA-256', data.custody.targetSha256]]) + '</body></html>\n', branding);
}

export async function buildCatalogMigration(sourcePlatform: CatalogPlatform, targetPlatform: CatalogPlatform, bytes: Uint8Array,
  filename = sourcePlatform + '-catalog.csv', branding?: SignoffBrand): Promise<CatalogMigrationResult> {
  const sourceSha256 = sha256(bytes);
  const source = parser[sourcePlatform](bytes, filename);
  const targetDialect = targetPlatform === 'bigcommerce' ? 'bigcommerce-modern' : targetPlatform;
  if (sourcePlatform === targetPlatform) source.add('same-platform', source.headerLine, null, 'Choose a different destination platform.');
  let verified: Product[] | null = null;
  let table: TargetTable | null = null;
  let targetCsv: CatalogMigrationResult['artifacts']['targetCsv'] = null;
  if (source.issues.every(problem => problem.level !== 'blocked')) {
    table = writeTarget(source, targetPlatform);
    if (source.issues.every(problem => problem.level !== 'blocked')) {
      const csv = serializeCsv(table.headers, table.rows, targetPlatform === 'shopify' ? 'shopify-products' : targetPlatform);
      const output = encode(csv);
      targetLimit(source, targetPlatform, output);
      if (source.issues.every(problem => problem.level !== 'blocked')) verified = verifyTarget(source, targetPlatform, csv, output, table);
      if (verified) targetCsv = { filename: 'migrated-' + sourcePlatform + '-to-' + targetPlatform + '.csv', bytes: output };
    }
  }
  const mapping = fieldMappings(source, targetPlatform, table);
  const targetSha256 = targetCsv ? await sha256(targetCsv.bytes) : undefined;
  const data: AuditData = {
    sourcePlatform, targetPlatform, sourceDialect: source.dialect, targetDialect, sourceFilename: filename,
    issues: source.issues, mapping, unmappedColumns: mapping.flatMap(field => field.target === null ? [field.source] : []),
    summary: { sourceProducts: source.products.length, sourceVariants: countVariants(source.products), targetProducts: verified?.length ?? 0,
      targetVariants: verified ? countVariants(verified) : 0, variantParity: verified !== null },
    custody: { sourceSha256: await sourceSha256, ...(targetSha256 ? { targetSha256 } : {}) },
  };
  const signOffHtml = { filename: 'migration-sign-off.html', bytes: encode(signoff(data, branding)) };
  const custody = { ...data.custody, signOffSha256: await sha256(signOffHtml.bytes) };
  const filenames = { targetCsv: targetCsv?.filename ?? null, auditJson: 'migration-audit.json', signOffHtml: signOffHtml.filename };
  const auditJson = { filename: filenames.auditJson, bytes: encode(JSON.stringify({ schemaVersion: 1, ...data, custody, filenames }, null, 2) + '\n') };
  return { ...data, custody, preview: table && targetCsv ? { headers: table.headers, rows: table.rows } : null, artifacts: { targetCsv, auditJson, signOffHtml } };
}

export async function brandCatalogMigrationReports(result: CatalogMigrationResult, branding?: SignoffBrand) {
  const { signOffHtml, auditJson } = result.artifacts;
  if (branding === undefined) return { signOffHtml, auditJson, signOffSha256: result.custody.signOffSha256 };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const report = { ...signOffHtml, bytes: encode(brandSignoffHtml(decoder.decode(signOffHtml.bytes), branding)) };
  const signOffSha256 = await sha256(report.bytes);
  const audit = JSON.parse(decoder.decode(auditJson.bytes)) as { custody: CatalogMigrationResult['custody'] };
  audit.custody.signOffSha256 = signOffSha256;
  return { signOffHtml: report, auditJson: { ...auditJson, bytes: encode(JSON.stringify(audit, null, 2) + '\n') }, signOffSha256 };
}
