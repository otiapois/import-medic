import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { decodeCsv, parseCsv, serializeCsv } from '../../../src/core/csv';
import { buildMultiSupplierDiff, buildPriceDiff, parseBaseline, parseSupplier } from '../../../src/core/shopify-price-diff';

import type { BatchDiffOptions, ColumnSelection, SupplierDiffInput } from '../../../src/core/shopify-price-diff';
import { createSignoffHtml } from '../../../src/core/shopify-price-diff/signoff-html';
import { applySupplierRecipe, createSupplierRecipe, parseSupplierRecipe, serializeSupplierRecipe } from '../../../src/core/shopify-price-diff/recipe';

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/shopify-price-diff/${name}`, import.meta.url));
const baseline = () => parseBaseline(fixture('m6-baseline-inventory.csv'));
const sheet = (name: string) => parseSupplier(fixture(name), name).sheets[0];
const records = (bytes: Uint8Array) => parseCsv(decodeCsv(bytes).text).records.map(({ cells }) => cells);

it('fails closed on a fractional inventory cell and accepts a verified inline replacement', () => {
  const supplier = sheet('m6-supplier-invalid-stock.csv');
  const mapping = { inventoryColumn: 2 };
  const blocked = buildPriceDiff(baseline(), supplier, mapping);
  expect(blocked.issues).toContainEqual(expect.objectContaining({ code: 'invalid-inventory-qty', row: 2, value: '12.5' }));
  expect(blocked.updateBytes).toBeNull();
  expect(blocked.rollbackBytes).toBeNull();

  const fixed = buildPriceDiff(baseline(), supplier, mapping, { 2: { inventoryQty: '12' } });
  expect(fixed.canDownload).toBe(true);
  const [head, red, blue] = records(fixed.updateBytes!);
  const qty = head.indexOf('Variant Inventory Qty');
  expect(head).not.toContain('Tags');
  expect(head).not.toContain('Image Src');
  expect(red[qty]).toBe('12');
  expect(blue[qty]).toBe('0000');
  expect(records(fixed.rollbackBytes!).slice(1).map(row => row[qty])).toEqual(['00020', '0000']);
});

const encode = (text: string) => new TextEncoder().encode(text);
const csv = (headers: string[], data: string[][]) => encode(serializeCsv(headers, data, 'shopify-products'));
const stock = (value: string, price = '11') => parseSupplier(csv(['SKU', 'Price', 'Stock'], [['0001', price, value]]), 'stock.csv').sheets[0];
const inventory = { inventoryColumn: 2 };
const input = (supplierId: string, file: string, selection: ColumnSelection, sheetIndex = 0, label = supplierId): SupplierDiffInput =>
  ({ supplierId, filename: file, label, sheet: parseSupplier(fixture(file), file).sheets[sheetIndex], selection });

const north = () => input('North', 'm6-supplier-north.csv', inventory);
const west = () => input('West', 'm6-supplier-west.csv', { inventoryColumn: 1 });
const east = () => input('East', 'm6-supplier-east.csv', { inventoryColumn: 3 });
const run = (sources: SupplierDiffInput[], options?: BatchDiffOptions) => buildMultiSupplierDiff(baseline(), sources, options);
const review = (result: ReturnType<typeof run>, code: string) => {
  expect(result.issues).toContainEqual(expect.objectContaining({ code, blocking: true }));
  expect(result).toMatchObject({ canDownload: false, updateBytes: null, rollbackBytes: null });
};
const firstVariant = (result: ReturnType<typeof run>) => result.rows.find(({ baselineRow }) => baselineRow === 2)!;

it('blocks three overlapping supplier sheets with complete evidence and exact physical rows', () => {
  const result = run([north(), west(), east()]);
  review(result, 'supplier-conflict');
  expect(result).toMatchObject({ overlapCount: 1, conflictCount: 1 });
  expect(firstVariant(result)).toMatchObject({
    status: 'Blocked', supplierRow: null,
    supplierContenders: [
      expect.objectContaining({ supplierId: 'North', row: 2, price: '11.00000000000000000002', priceColumn: 'Price', inventoryColumn: 'Stock' }),
      expect.objectContaining({ supplierId: 'West', row: 2, price: '11.00000000000000000001', priceColumn: 'New Price', inventoryColumn: 'Inventory' }),
      expect.objectContaining({ supplierId: 'East', row: 2, price: '12.00', priceColumn: 'New Price', inventoryColumn: 'Qty' }),
    ],
  });
  expect(result.rows.find(row => row.sku === '0003')).toMatchObject({ supplierRow: 4, supplierSource: 'North' });
});

it.each([
  ['prefer-first', 'North', '11.00000000000000000002', '12'],
  ['prefer-last', 'East', '12.00', '17'],
  ['prefer-lowest', 'West', '11.00000000000000000001', '14'],
  ['prefer-highest', 'East', '12.00', '17'],
] as const)('resolves %s with an exact whole-file winner, verifiable export and provenance', (conflictPolicy, supplierSource, newPrice, newInventoryQty) => {
  const result = run([north(), west(), east()], { conflictPolicy, conflictPolicyConfirmed: true });
  expect(result.canDownload).toBe(true);
  expect(firstVariant(result)).toMatchObject({ status: 'Updated', supplierSource, newPrice, newInventoryQty });
  const [columns, red, blue, other] = records(result.updateBytes!);
  expect(red[columns.indexOf('Variant Price')]).toBe(newPrice);
  expect(red[columns.indexOf('Variant Inventory Qty')]).toBe(newInventoryQty);
  expect(blue[columns.indexOf('Variant Inventory Qty')]).toBe('0000');
  expect(other[columns.indexOf('Variant Inventory Qty')]).toBe('8');
  expect(records(result.rollbackBytes!).slice(1).map(row => row[columns.indexOf('Variant Inventory Qty')])).toEqual(['00020', '0000', '']);
  expect(result.verification).toEqual({ checked: true, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 });
});

it.each(['prefer-first', 'prefer-last', 'prefer-lowest', 'prefer-highest'] as const)('requires current-batch confirmation for %s', conflictPolicy => {
  review(run([north(), west()], { conflictPolicy }), 'supplier-conflict-confirmation-required');
});

it('uses visible supplier order when applying first and last policies', () => {
  for (const [order, id] of [[[west(), north()], 'West'], [[north(), west()], 'North']] as const) {
    expect(firstVariant(run([...order], { conflictPolicy: 'prefer-first', conflictPolicyConfirmed: true })).supplierId).toBe(id);
  }
});

const inlineInputs = (left: string, right: string, leftColumns: ColumnSelection = inventory, rightColumns: ColumnSelection = inventory) => [
  { supplierId: 'A', filename: 'a.csv', sheet: stock(left), selection: leftColumns },
  { supplierId: 'B', filename: 'b.csv', sheet: stock(right, '11.00'), selection: rightColumns },
];

it('coalesces equivalent decimal price and integer quantity values without requiring a policy', () => {
  const result = run(inlineInputs('0012', '12'));
  expect(result).toMatchObject({ canDownload: true, overlapCount: 1, conflictCount: 0 });
  expect(firstVariant(result)).toMatchObject({ newPrice: '11', newInventoryQty: '12', supplierSource: 'a.csv' });
});

it.each([
  ['prefer-first', 'A'], ['prefer-last', 'B'], ['prefer-lowest', 'A'], ['prefer-highest', 'A'],
] as const)('requires %s confirmation even for equivalent overlapping offers', (conflictPolicy, supplierId) => {
  const input = inlineInputs('0012', '12');
  const pending = run(input, { conflictPolicy, conflictPolicyConfirmed: false });
  review(pending, 'supplier-conflict-confirmation-required');
  expect(pending).toMatchObject({ overlapCount: 1, conflictCount: 0 });
  expect(pending.issues).toContainEqual(expect.objectContaining({ source: 'supplier', code: 'supplier-conflict-confirmation-required' }));
  expect(firstVariant(pending)).toMatchObject({ status: 'Blocked', supplierContenders: [
    expect.objectContaining({ supplierId: 'A' }), expect.objectContaining({ supplierId: 'B' }),
  ] });
  const confirmed = run(input, { conflictPolicy, conflictPolicyConfirmed: true });
  expect(confirmed).toMatchObject({ canDownload: true, overlapCount: 1, conflictCount: 0 });
  const winner = input.find((entry) => entry.supplierId === supplierId)!;
  expect(firstVariant(confirmed)).toMatchObject({ supplierId, supplierSource: winner.filename });
  expect(JSON.parse(confirmed.auditJson).rows[0]).toMatchObject({ supplierId, supplierSource: winner.filename });
  const [header, row] = records(confirmed.updateBytes!);
  const price = header.indexOf('Variant Price');
  expect(row[price]).toBe(supplierId === 'A' ? '11' : '11.00');
  expect(records(confirmed.rollbackBytes!)[1][price]).toBe('010.000');
});

it.each(['block-conflicts', 'prefer-lowest', 'prefer-highest'] as const)('keeps an equal-price quantity disagreement in review under %s', conflictPolicy => {
  review(run(inlineInputs('12', '14'), { conflictPolicy, conflictPolicyConfirmed: true }), 'supplier-conflict');
});

it('keeps an equal-price compare-at disagreement in review', () => {
  const mapped = (label: string, compare: string) => ({ supplierId: label, filename: label + '.csv', selection: { compareAtColumn: 2 },
    sheet: parseSupplier(csv(['SKU', 'Price', 'Compare-at price'], [['0001', '11.00', compare]]), label + '.csv').sheets[0] });
  review(run([mapped('A', '25.00'), mapped('B', '26.00')]), 'supplier-conflict');
});

it('keeps a conflict when identical raw prices use different resulting pricing rules', () => {
  review(run(inlineInputs('12', '12', { ...inventory, confirmed: true, pricingRule: { mode: 'multiplier', multiplier: '1.2' } })), 'supplier-conflict');
});

it('retains the winning unmapped source quantity and scopes the mapped stock column globally', () => {
  const result = run(inlineInputs('12', '14', {}, inventory), { conflictPolicy: 'prefer-first', conflictPolicyConfirmed: true });
  expect(result.canDownload).toBe(true);
  expect(firstVariant(result)).toMatchObject({ supplierId: 'A', oldInventoryQty: '00020', newInventoryQty: '00020', inventoryOutput: 'value' });
  expect(records(result.updateBytes!)[1].at(-1)).toBe('00020');
});

it('retains both original units when lowest would compare unlike currencies', () => {
  const compare = (supplierId: string, price: string) => ({ supplierId, filename: supplierId + '.csv',
    sheet: stock('12', price), selection: { ...inventory, sameCurrencyConfirmed: true } });
  const inputs = [compare('A', 'EUR 11'), compare('B', 'USD 12')];
  review(run(inputs, { conflictPolicy: 'prefer-lowest', conflictPolicyConfirmed: true }), 'incomparable-supplier-prices');
  expect(firstVariant(run(inputs, { conflictPolicy: 'prefer-last', conflictPolicyConfirmed: true }))).toMatchObject({ supplierId: 'B' });
});

it('exposes the exact source of same-currency approval and blocks mismatched winning units across files', () => {
  const second = parseSupplier(csv(['SKU', 'Price', 'Stock'], [['0003', '32 USD', '8']]), 'b.csv').sheets[0];
  const inputs = [{ supplierId: 'a', filename: 'a.csv', sheet: stock('12', '11 EUR'), selection: inventory },
    { supplierId: 'b', filename: 'b.csv', sheet: second, selection: inventory }];
  expect(run(inputs).issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'currency-confirmation-required', supplierId: 'a' }),
    expect.objectContaining({ code: 'currency-confirmation-required', supplierId: 'b' }),
  ]));
  review(run(inputs.map(source => ({ ...source, selection: { ...inventory, sameCurrencyConfirmed: true } }))), 'currency-conflict');
});

it('keeps malformed overlapping inventory reviewable even under an explicit preference', () => {
  const result = run(inlineInputs('12', '12.5'), { conflictPolicy: 'prefer-first', conflictPolicyConfirmed: true });
  review(result, 'invalid-inventory-qty');
  expect(result.rows.find(row => row.supplierId === 'B')).toMatchObject({ baselineRow: 2, supplierRow: 2, status: 'Blocked' });
  const fixed = run(inlineInputs('12', '12.5').map(source => source.supplierId === 'B'
    ? { ...source, resolutions: { 2: { inventoryQty: '12' } } } : source));
  expect(fixed).toMatchObject({ canDownload: true, conflictCount: 0 });
});

it('applies a row skip to its exact sheet only despite equal physical row numbers', () => {
  const [left, right] = inlineInputs('12', '12.5');
  const result = run([left, { ...right, resolutions: { 2: { skip: true } } }]);
  expect(result).toMatchObject({ canDownload: true, conflictCount: 0 });
  expect(firstVariant(result)).toMatchObject({ status: 'Updated', supplierId: 'A' });
  expect(result.rows.find(row => row.supplierId === 'B')).toMatchObject({ status: 'Skipped' });
});

it('does not let a conflict policy silently discard structural same-sheet duplicates', () => {
  const duplicate = parseSupplier(csv(['SKU', 'Price', 'Stock'], [['0001', '11', '12'], ['0001', '11', '12']]), 'duplicate.csv').sheets[0];
  review(run([{ supplierId: 'duplicate', filename: 'duplicate.csv', sheet: duplicate, selection: inventory }, west()],
    { conflictPolicy: 'prefer-last', conflictPolicyConfirmed: true }), 'duplicate-sku');
});

it('handles a selected real sparse XLSX sheet and retains the separate filename and worksheet', () => {
  const source = input('Workbook', 'supplier-agency.xlsx', {}, 1);
  const base = parseBaseline(csv(['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price'], [
    ['item', 'A workbook item', 'Title', 'Default Title', 'P-02', '17'],
  ]));
  const result = buildMultiSupplierDiff(base, [source]);
  expect(result).toMatchObject({ canDownload: true, rows: [expect.objectContaining({
    supplierId: 'Workbook', supplierFilename: 'supplier-agency.xlsx', supplierWorksheet: source.sheet.name,
    supplierRow: source.sheet.rows[0].line, newPrice: '18.00',
  })] });
});

it('keeps source issue objects immutable when a parsed sheet is reused or frozen', () => {
  const parsed = parseSupplier(csv(['SKU', 'Price', 'Price'], [['0001', '11', '12']]), 'dupe.csv').sheets[0];
  Object.freeze(parsed.issues[0]);
  const a = { supplierId: 'A', filename: 'a.csv', sheet: parsed, selection: { confirmed: true } };
  const b = { supplierId: 'B', filename: 'b.csv', sheet: parsed, selection: { confirmed: true } };
  const result = run([a, b]);
  expect(result.issues.filter(({ code }) => code === 'duplicate-header').map(({ supplierId }) => supplierId)).toEqual(['A', 'B']);
  expect(parsed.issues[0]).not.toHaveProperty('supplierId');
});

it.each(['', '12.5', '-1', '+1', '1e2', 'NaN', 'Infinity', ' 12', '12 ', '12\n', '١٢', '=12', '12,000', '0'.repeat(65)])
('rejects malformed inventory %j without changing a price or emitting rollback', value => {
  review(buildPriceDiff(baseline(), stock(value), inventory), 'invalid-inventory-qty');
});

it.each([
  ['4', undefined, undefined], ['3', undefined, 'inventory-drop'], ['0', undefined, 'inventory-zero-out'],
  ['10', 50, undefined], ['9', 50, 'inventory-drop'], ['0', 100, 'inventory-zero-out'],
] as const)('applies exact drop threshold against the original 20 to %j with threshold %j', (value, threshold, code) => {
  const result = buildPriceDiff(baseline(), stock(value), { ...inventory, inventoryDropThresholdPercent: threshold });
  if (code) review(result, code);
  else expect(result.canDownload).toBe(true);
});

it('accepts explicit approval for valid zero-out but still rejects a fractional amount', () => {
  expect(buildPriceDiff(baseline(), stock('0'), inventory, { 2: { confirm: true } }).canDownload).toBe(true);
  review(buildPriceDiff(baseline(), stock('12.5'), inventory, { 2: { confirm: true } }), 'invalid-inventory-qty');
});

it('writes inventory-only changes and preserves unchanged price text in both native CSVs', () => {
  const result = buildPriceDiff(baseline(), stock('12', '10.0'), inventory);
  expect(result.canDownload).toBe(true);
  expect(firstVariant(result)).toMatchObject({ status: 'Updated', oldPrice: '010.000', newPrice: '010.000', newInventoryQty: '12' });
  for (const data of [result.updateBytes!, result.rollbackBytes!]) {
    const [header, red] = records(data);
    expect(red[header.indexOf('Variant Price')]).toBe('010.000');
  }
});

it('omits native and display stock fields when not mapped', () => {
  const result = buildPriceDiff(baseline(), stock('12.5'));
  expect(result.canDownload).toBe(true);
  for (const data of [result.updateBytes!, result.rollbackBytes!, encode(result.auditCsv)]) {
    expect(records(data)[0]).not.toContain('Variant Inventory Qty');
    expect(records(data)[0]).not.toContain('Inventory Output');
  }
});

it.each(['NaN', '12.5', '=1+2'])('rejects malformed original sibling quantity %j only for a scoped stock update', value => {
  const base = parseBaseline(encode(decodeCsv(fixture('m6-baseline-inventory.csv')).text.replace('0000,,', value + ',,')));
  review(buildPriceDiff(base, stock('12'), inventory), 'invalid-baseline-inventory-qty');
  expect(buildPriceDiff(base, stock('12')).canDownload).toBe(true);
});

it('restores signed whole baseline inventory and retains exact baseline text for untouched siblings', () => {
  const base = parseBaseline(encode(decodeCsv(fixture('m6-baseline-inventory.csv')).text.replace('0000,,', '-0002,,')));
  const result = buildPriceDiff(base, stock('12'), inventory);
  expect(result.canDownload).toBe(true);
  expect(records(result.rollbackBytes!)[2].at(-1)).toBe('-0002');
});

it('rejects an inventory mapping without the baseline quantity column', () => {
  const base = parseBaseline(fixture('baseline-agency.csv'));
  review(buildPriceDiff(base, stock('12'), inventory), 'missing-baseline-inventory-qty');
});

it('rejects use of the same mapped column for price and inventory', () => {
  review(buildPriceDiff(baseline(), stock('12'), { inventoryColumn: 1 }), 'invalid-column-selection');
});

it('preserves exact winning and competing source in JSON, spreadsheet-safe CSV and offline HTML', () => {
  const labelled = { ...west(), label: '@West <script> https://example.invalid' };
  const result = run([north(), labelled, east()], { conflictPolicy: 'prefer-lowest', conflictPolicyConfirmed: true });
  const audit = JSON.parse(result.auditJson);
  expect(audit.rows[0]).toMatchObject({ supplierId: 'West', supplierSource: labelled.label, supplierFilename: labelled.filename,
    supplierContenders: expect.arrayContaining([expect.objectContaining({ label: 'East', price: '12.00' })]) });
  const [head, , row] = records(encode(result.auditCsv));
  expect(row[head.indexOf('Supplier Source')]).toBe("'" + labelled.label);
  expect(JSON.parse(row[head.indexOf('Supplier Contenders (JSON)')])).toEqual(audit.rows[0].supplierContenders);
  expect(head.at(-1)).toBe('Review and Resolution (JSON)');
  const html = createSignoffHtml(baseline(), result);
  expect(html).toContain('Supplier updates');
  expect(html).toContain('Inventory changes');
  expect(html).toContain('@West &lt;script&gt; https&#58;//example.invalid');
  expect(html).toContain('m6-supplier-east.csv');
  expect(html).toContain('script-src \'none\'');
  expect(html).not.toContain('<script>');
});

it('saves and reloads a v4 recipe with exact reordering and fresh confirmation', () => {
  const created = createSupplierRecipe('Vendor', ['SKU', 'Price', 'Stock'], {
    joinKey: 'sku', skuColumn: 0, priceColumn: 1, inventoryColumn: 2, inventoryDropThresholdPercent: 67.125,
    conflictPolicy: 'prefer-lowest', confirmed: true, sameCurrencyConfirmed: true,
  }, null);
  expect(created).toMatchObject({ ok: true, value: { version: 4, inventoryColumn: 'Stock', conflictPolicy: 'prefer-lowest' } });
  if (!created.ok) throw new Error('Expected saved recipe');
  const recipeText = serializeSupplierRecipe(created.value);
  const parsed = parseSupplierRecipe(encode(recipeText));
  expect(parsed).toEqual(created);
  expect(recipeText).not.toMatch(/confirm/i);
  const reordered = parseSupplier(csv(['Stock', 'SKU', 'Price'], [['12', '0001', '11']]), 'reordered.csv');
  expect(applySupplierRecipe(created.value, reordered, 0)).toMatchObject({ ok: true, value: { selection: {
    skuColumn: 1, priceColumn: 2, inventoryColumn: 0, inventoryDropThresholdPercent: 67.125, conflictPolicy: 'prefer-lowest', confirmed: false,
  } } });
});

it('rejects a renamed v4 inventory header while keeping matching exact', () => {
  const created = createSupplierRecipe('Vendor', ['SKU', 'Price', 'Stock'], {
    joinKey: 'sku', skuColumn: 0, priceColumn: 1, inventoryColumn: 2, confirmed: true,
  }, null);
  if (!created.ok) throw new Error('Expected saved recipe');
  const renamed = parseSupplier(csv(['SKU', 'Price', 'stock'], [['0001', '11', '12']]), 'renamed.csv');
  expect(applySupplierRecipe(created.value, renamed, 0)).toMatchObject({ ok: false, diagnostics: [{ code: 'recipe-missing-column', field: 'inventoryColumn', expected: 'Stock' }] });
});

it.each([
  ['duplicate role', { inventoryColumn: 'Price' }, 'duplicate-recipe-column'],
  ['case-folded collision', { inventoryColumn: 'pRiCe' }, 'duplicate-recipe-column'],
  ['bad policy', { conflictPolicy: 'choose-randomly' }, 'invalid-recipe-schema'],
  ['unmapped threshold', { inventoryColumn: undefined, inventoryDropThresholdPercent: 50 }, 'invalid-recipe-schema'],
  ['oversized threshold', { inventoryDropThresholdPercent: 100.001 }, 'invalid-recipe-schema'],
  ['sticky approval', { conflictPolicyConfirmed: true }, 'invalid-recipe-schema'],
] as const)('rejects a v4 recipe with %s', (_, extra, code) => {
  const base = { version: 4, supplierLabel: 'Vendor', joinKey: { type: 'sku', skuColumn: 'SKU' }, priceColumn: 'Price',
    compareAtColumn: null, sheetName: null, dropThresholdPercent: 50, increaseThresholdPercent: 200,
    formulaGuard: false, pricingRule: { mode: 'direct' }, inventoryColumn: 'Stock', ...extra };
  expect(parseSupplierRecipe(encode(JSON.stringify(base)))).toMatchObject({ ok: false, diagnostics: [{ code }] });
});

it.each([1, 2, 3, 4] as const)('reads strict version %s without silently enabling an inventory mapping for old recipes', version => {
  const base = { version, supplierLabel: 'Vendor', joinKey: { type: 'sku', skuColumn: 'SKU' }, priceColumn: 'Price',
    compareAtColumn: null, sheetName: null, dropThresholdPercent: 50, increaseThresholdPercent: 200, formulaGuard: false };
  const payload = version === 1 ? base : version === 3 ? {
    ...base, pricingRule: { mode: 'direct', fx: { sourceCurrency: 'EUR', storeCurrency: 'USD', fxRate: '1.1' } }, fxRateNeedsRecheck: true,
  } : { ...base, pricingRule: { mode: 'direct' }, ...(version === 4 ? { inventoryColumn: 'Stock' } : {}) };
  const recipe = parseSupplierRecipe(encode(JSON.stringify(payload)));
  expect(recipe.ok).toBe(true);
  if (!recipe.ok) throw new Error('Expected parsed recipe');
  const mapped = applySupplierRecipe(recipe.value, parseSupplier(fixture('m6-supplier-north.csv'), 'new.csv'), 0);
  expect(mapped).toMatchObject({ ok: true, value: { selection: { confirmed: false } } });
  if (mapped.ok) expect(mapped.value.selection.inventoryColumn).toBe(version === 4 ? 2 : undefined);
});

it('rejects more than three files or repeated supplier IDs without writing a pair', () => {
  review(run([north(), west(), east(), { ...east(), supplierId: 'D' }]), 'invalid-supplier-batch');
  review(run([north(), north()]), 'invalid-supplier-batch');
  review(run([]), 'invalid-supplier-batch');
});

it('discloses each rule and manual FX rate in multi-supplier offline sign-off', () => {
  const [a, b] = inlineInputs('12', '14');
  const inputs = [{ ...a, sheet: stock('12', 'EUR 11'), label: 'FX vendor', selection: {
    ...inventory, confirmed: true, fxRateConfirmed: true, pricingRule: {
      mode: 'multiplier' as const, multiplier: '1.25', fx: { sourceCurrency: 'EUR', storeCurrency: 'USD', fxRate: '1.1' },
    },
  } }, { ...b, sheet: stock('14', 'USD 12'), label: 'Direct vendor', selection: { ...inventory, sameCurrencyConfirmed: true } }];
  const result = run(inputs, { conflictPolicy: 'prefer-first', conflictPolicyConfirmed: true });
  expect(result.canDownload).toBe(true);
  const html = createSignoffHtml(baseline(), result);
  expect(html).toContain('FX vendor · Multiplier × 1.25 · EUR → USD × 1.1');
  expect(html).toContain('Direct vendor · Direct supplier price');
  expect(html).toContain('FX vendor (1) · Direct vendor (0)');
});
