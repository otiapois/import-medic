import { z } from 'zod';
import type { Journal } from '../journal';
import { columnIndex, headerAliases, requireColumn, type Table, type WorkingRow } from '../table';
import { normalizeAmount } from '../values';

const shopifyFields = {
  Handle: ['URL handle'],
  Title: [],
  'Body (HTML)': ['Description'],
  Vendor: [],
  'Product Category': [],
  Type: [],
  Tags: [],
  Published: ['Published on online store'],
  'Option1 Name': ['Option1 name'],
  'Option1 Value': ['Option1 value'],
  'Option1 Linked To': [],
  'Option2 Name': ['Option2 name'],
  'Option2 Value': ['Option2 value'],
  'Option2 Linked To': [],
  'Option3 Name': ['Option3 name'],
  'Option3 Value': ['Option3 value'],
  'Option3 Linked To': [],
  'Variant SKU': ['SKU'],
  'Variant Grams': ['Weight value (grams)'],
  'Variant Inventory Tracker': ['Inventory tracker'],
  'Variant Inventory Qty': ['Inventory quantity'],
  'Variant Inventory Policy': ['Continue selling when out of stock'],
  'Variant Fulfillment Service': ['Fulfillment service'],
  'Variant Price': ['Price'],
  'Variant Compare At Price': ['Compare-at price', 'Variant Compare-at Price'],
  'Variant Requires Shipping': ['Requires shipping'],
  'Variant Taxable': ['Charge tax'],
  'Variant Barcode': ['Barcode'],
  'Image Src': ['Product image URL'],
  'Image Position': ['Image position'],
  'Image Alt Text': ['Image alt text'],
  'Gift Card': [],
  'SEO Title': [],
  'SEO Description': [],
  'Variant Image': ['Variant image URL'],
  'Variant Weight Unit': ['Weight unit for display'],
  'Variant Tax Code': [],
  'Cost per item': [],
  Status: [],
};

export const shopifyAliases = headerAliases(shopifyFields);
export const shopifyNativeHeaders: ReadonlySet<string> = new Set(Object.entries(shopifyFields).flatMap(([name, aliases]) => [name, ...aliases]));
export const shopifyPaddingColumns = new Set(Object.keys(shopifyFields).filter((column) => column !== 'Handle' && column !== 'Title'));

const inventory = z.string().regex(/^-?\d+$/);
const imageUrl = z.string().regex(/^https?:\/\/[^\s\\]+$/i);
const status = z.enum(['active', 'draft', 'archived']);
const published = new Map([['true', 'TRUE'], ['yes', 'TRUE'], ['1', 'TRUE'], ['false', 'FALSE'], ['no', 'FALSE'], ['0', 'FALSE']]);

function slugify(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function groupByCell(rows: readonly WorkingRow[], index: number): Map<string, WorkingRow[]> {
  const groups = new Map<string, WorkingRow[]>();
  for (const row of rows) {
    const value = row.cells[index];
    if (value.trim() === '') continue;
    const group = groups.get(value) ?? [];
    group.push(row);
    groups.set(value, group);
  }
  return groups;
}

export function repairShopify(table: Table, journal: Journal): void {
  const handleIndex = requireColumn(table, 'Handle', journal);
  const titleIndex = requireColumn(table, 'Title', journal);
  if (handleIndex === undefined || titleIndex === undefined) return;
  const validRows = table.rows.filter(({ invalid }) => !invalid);
  const handles = groupByCell(validRows, handleIndex);
  const normalizedHandles = new Map<string, string[]>();
  for (const raw of handles.keys()) {
    const slug = slugify(raw);
    if (slug === '') continue;
    const incoming = normalizedHandles.get(slug) ?? [];
    incoming.push(raw);
    normalizedHandles.set(slug, incoming);
  }

  const seen = new Set<string>();
  let previous = '';
  for (const row of table.rows) {
    if (row.invalid) {
      previous = '';
      continue;
    }
    const line = row.source.line;
    const handle = row.cells[handleIndex];
    const title = row.cells[titleIndex];
    const slug = slugify(handle);
    const continuation = handle !== '' && previous === handle;
    if (handle.trim() === '') {
      journal.issue('missing-handle', line, 'Handle', handle, 'Enter the product handle. Repeat it on each variant or image row.', { editable: true });
    } else if (!slug) {
      journal.issue('invalid-handle', line, 'Handle', handle, 'Enter a handle containing letters or digits.', { editable: true });
    } else if ((normalizedHandles.get(slug)?.length ?? 0) > 1) {
      journal.issue('handle-collision', line, 'Handle', handle, `Different source handles would become "${slug}". Enter distinct handles before exporting.`, { editable: true, block: true });
    } else {
      row.cells[handleIndex] = journal.fix('handle-normalized', line, 'Handle', handle, slug, 'Normalized the product handle while preserving its variant and image records.');
    }
    if (!continuation && handle.trim() !== '' && seen.has(handle)) {
      journal.issue('noncontiguous-handle', line, 'Handle', handle, 'Place all rows for this product together before exporting.', { block: true });
    }
    if (!continuation && title.trim() === '') {
      journal.issue('missing-title', line, 'Title', title, 'Enter a title on the first record for this product.', { editable: true });
    }
    if (handle.trim() !== '') seen.add(handle);
    previous = handle.trim() === '' ? '' : handle;
  }

  for (const column of ['Variant Price', 'Variant Compare At Price']) {
    const index = columnIndex(table, column);
    if (index === undefined) continue;
    for (const row of validRows) {
      const source = row.cells[index];
      if (!source.trim()) continue;
      const fixed = normalizeAmount(source);
      if (fixed === undefined || fixed.startsWith('-')) {
        journal.issue('invalid-price', row.source.line, column, source, 'Enter a nonnegative decimal price from your product data.', { editable: true });
      } else {
        row.cells[index] = journal.fix('price-normalized', row.source.line, column, source, fixed, 'Removed currency formatting without changing the price.');
      }
    }
  }

  const sku = columnIndex(table, 'Variant SKU');
  if (sku !== undefined) {
    for (const [value, duplicates] of groupByCell(validRows, sku)) {
      if (duplicates.length < 2) continue;
      const lines = duplicates.map(({ source }) => source.line);
      for (const row of duplicates) {
        journal.issue('duplicate-sku', row.source.line, 'Variant SKU', value, `This SKU occurs on lines ${lines.join(', ')}. Enter a distinct variant SKU.`, { editable: true });
      }
    }
  }

  const inventoryTracker = columnIndex(table, 'Variant Inventory Tracker');
  for (const column of ['Variant Inventory Qty', 'Image Src', 'Published', 'Status']) {
    const index = columnIndex(table, column);
    if (index === undefined) continue;
    for (const row of validRows) {
      const source = row.cells[index];
      const value = source.trim();
      const line = row.source.line;
      const trackedQuantity = column === 'Variant Inventory Qty' && inventoryTracker !== undefined &&
        row.cells[inventoryTracker].trim().toLowerCase() === 'shopify';
      if (!value && !trackedQuantity) continue;
      if (column === 'Variant Inventory Qty') {
        if (!inventory.safeParse(value).success) journal.issue('invalid-inventory-qty', line, column, source, 'Confirm the stock level and enter a whole-number inventory quantity.', { editable: true });
        else row.cells[index] = journal.fix('inventory-qty-normalized', line, column, source, value, 'Trimmed the inventory quantity.');
      } else if (column === 'Image Src') {
        if (!imageUrl.safeParse(value).success || !URL.canParse(value)) journal.issue('invalid-image-url', line, column, source, 'Enter a complete HTTP or HTTPS image URL.', { editable: true });
        else row.cells[index] = journal.fix('image-url-normalized', line, column, source, value, 'Trimmed whitespace around the image URL.');
      } else if (column === 'Published') {
        const fixed = published.get(value.toLowerCase());
        if (!fixed) journal.issue('invalid-published', line, column, source, 'Enter TRUE or FALSE for the published state.', { editable: true });
        else row.cells[index] = journal.fix('published-normalized', line, column, source, fixed, 'Standardized the published state to TRUE or FALSE.');
      } else {
        const fixed = value.toLowerCase();
        if (!status.safeParse(fixed).success) journal.issue('invalid-status', line, column, source, 'Enter active, draft, or archived.', { editable: true });
        else row.cells[index] = journal.fix('status-normalized', line, column, source, fixed, 'Standardized the product status.');
      }
    }
  }
}
