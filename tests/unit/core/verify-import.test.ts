import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serializeCsv } from '../../../src/core/csv';
import { inspectImport } from '../../../src/core/verify-import/inspector';

const encode = (value: string) => new TextEncoder().encode(value);
const csv = (header: string[], rows: string[][]) => encode(serializeCsv(header, rows, 'shopify-products'));
const lines = (header: string[], ...rows: string[][]) => [header, ...rows];
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const shopHeaders = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Variant Compare At Price', 'Variant Inventory Qty'];
const red = ['coat', 'Coat\nOriginal', 'Color', 'Red', '00123', '010.000', '', '-002'];
const blue = ['coat', '', '', 'Blue', '014', '10.00', '08.000', ''];
const hat = ['hat', 'Hat', 'Title', 'Default Title', '15', '20.00', '25.00', '3'];
const shopBaseline = csv([...shopHeaders, 'Image Src', 'Tags'], [
  [...red, '', 'keep'], [...blue, '', ''], ['coat', '', '', '', '', '', '', '', 'https://example.test/coat.jpg', ''], [...hat, '', 'stay'],
]);
const shop = (rows: string[][]) => csv(shopHeaders, rows);
const set = (row: string[], index: number, value: string) => row.map((cell, pos) => pos === index ? value : cell);
const changedRed = ['coat', 'Coat\nOriginal', 'Color', 'Red', '00123', '12.001', '17.00', '0'];

const wooHeaders = ['ID', 'Type', 'SKU', 'Parent', 'Regular price', 'Sale price', 'Stock'];
const parent = ['10', 'variable', 'COAT', '', '', '', ''];
const variation = ['11', 'variation', '0012345', 'id:10', '025.005', '020.000', "'-2"];
const variationBySku = ['12', 'variation', '9876', 'COAT', '40.000', '', ''];
const simple = ['20', 'simple', '001', '', '50.00', '20.00', '7'];
const woo = (rows: string[][]) => csv(wooHeaders, rows);
const wooBaseline = csv([...wooHeaders, 'Name', 'Description'], [
  [...parent, 'Coat', 'parent description'], [...variation, '', 'original variation'], [...variationBySku, '', 'another variation'], [...simple, 'Hat', 'original hat'],
]);

describe('Shopify import inspection', () => {
  it('fingerprints actual bytes and computes exact text, signed deltas and physical lines', async () => {
    const candidate = shop([changedRed, blue]);
    const result = await inspectImport('shopify', shopBaseline, candidate);
    expect(result).toMatchObject({ verdict: 'PASS', baselineSha256: digest(shopBaseline), candidateSha256: digest(candidate),
      matchedRows: 2, changedRows: 1, changedSkus: 1, unchangedSiblingSkus: 1, nonTargetMutations: 0, brokenGroups: 0,
      rollback: { scope: 'candidate-vs-baseline', residualDiffs: 3, restored: false }, issues: [] });
    expect(result.rows).toEqual([{ sku: '00123', product: 'coat', baselineLine: 2, candidateLine: 2, changes: [
      { column: 'Variant Price', before: '010.000', after: '12.001', delta: '2.001' },
      { column: 'Variant Compare At Price', before: '', after: '17.00', delta: null },
      { column: 'Variant Inventory Qty', before: '-002', after: '0', delta: '2' },
    ] }]);
  });

  it('verifies a baseline-equivalent candidate with blank and negative original stock', async () => {
    expect(await inspectImport('shopify', shopBaseline, shop([red, blue]))).toMatchObject({ verdict: 'PASS', changedRows: 0,
      rollback: { scope: 'candidate-vs-baseline', residualDiffs: 0, restored: true } });
  });

  it('independently overlays a paired update over the full original before rollback', async () => {
    const update = shop([changedRed, blue]);
    expect(await inspectImport('shopify', shopBaseline, shop([red, blue]), update)).toMatchObject({ verdict: 'PASS', changedRows: 0,
      rollback: { scope: 'paired-update', residualDiffs: 0, restored: true, pairedUpdateSha256: digest(update) } });
  });

  it('does not attest restoration when the rollback omits an entire touched Shopify group', async () => {
    expect(await inspectImport('shopify', shopBaseline, shop([red, blue]), shop([changedRed, blue, set(hat, 5, '21.00')])))
      .toMatchObject({ verdict: 'FAIL_UNSAFE', rollback: { scope: 'paired-update', residualDiffs: 1, restored: false },
        issues: [expect.objectContaining({ code: 'rollback-residual', source: 'candidate' })] });
  });

  it('counts price spelling changes even if the amount is equal', async () => {
    const result = await inspectImport('shopify', shopBaseline, shop([set(red, 5, '10'), blue]));
    expect(result.rows[0].changes).toEqual([{ column: 'Variant Price', before: '010.000', after: '10', delta: '0' }]);
    expect(result.rollback.residualDiffs).toBe(1);
  });

  it('computes precise decimals beyond JavaScript numeric precision', async () => {
    const first = set(hat, 5, '9007199254740993.0000000000000001');
    const candidate = set(first, 5, '9007199254740993.0000000000000002');
    const result = await inspectImport('shopify', shop([first]), shop([candidate]));
    expect(result.rows[0].changes[0].delta).toBe('0.0000000000000001');
  });

  it('accepts modern alias schema with UTF-8 BOM and unused blank option pairs', async () => {
    const header = ['URL handle', 'Title', 'Option1 name', 'Option1 value', 'SKU', 'Price', 'Compare-at price', 'Inventory quantity', 'Option2 name', 'Option2 value', 'Option3 name', 'Option3 value'];
    const raw = csv(header, [[...changedRed, '', '', '', ''], [...blue, '', '', '', '']]);
    const candidate = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]);
    expect(await inspectImport('shopify', shopBaseline, candidate)).toMatchObject({ verdict: 'PASS', matchedRows: 2, candidateSha256: digest(candidate) });
  });

  it.each(['variant price', ' Price ', 'PRICE'])('holds Shopify headings with undocumented casing or padding %j', async (heading) => {
    const candidate = csv(set(shopHeaders, 5, heading), [changedRed, blue]);
    expect(await inspectImport('shopify', shopBaseline, candidate)).toMatchObject({ verdict: 'FAIL_UNSAFE', nonTargetMutations: 1,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'forbidden-column', column: heading })]) });
  });

  it('hashes and inspects the same byte view even when its caller later reuses the buffer', async () => {
    const candidate = shop([changedRed, blue]);
    const exactDigest = digest(candidate);
    const pending = inspectImport('shopify', shopBaseline, candidate);
    candidate.fill(0);
    expect(await pending).toMatchObject({ verdict: 'PASS', candidateSha256: exactDigest, changedRows: 1 });
  });

  it('allows complete product groups in any global product order', async () => {
    expect(await inspectImport('shopify', shopBaseline, shop([hat, red, blue]))).toMatchObject({ verdict: 'PASS', matchedRows: 3 });
  });

  it('allows inventory-only in scope with a baseline quantity', async () => {
    const candidate = csv(shopHeaders.filter((_, index) => index !== 5 && index !== 6), [
      [...red.slice(0, 5), '0003'], [...blue.slice(0, 5), ''],
    ]);
    expect(await inspectImport('shopify', shopBaseline, candidate)).toMatchObject({ verdict: 'PASS', changedSkus: 1, rows: [expect.objectContaining({
      changes: [{ column: 'Variant Inventory Qty', before: '-002', after: '0003', delta: '5' }],
    })] });
  });

  it('counts a blank-SKU variant row while leaving the exact SKU counts scoped to nonblank SKUs', async () => {
    const baseline = shop([set(red, 4, ''), blue]);
    const candidate = shop([set(changedRed, 4, ''), blue]);
    expect(await inspectImport('shopify', baseline, candidate)).toMatchObject({ verdict: 'PASS', changedRows: 1, changedSkus: 0, unchangedSiblingSkus: 1 });
  });

  it.each(['Body (HTML)', 'Description', 'Tags', 'Image Src', 'Product image URL', 'Meta:custom.field', 'Vendor', ''])('holds even a blank forbidden header %j', async (heading) => {
    const candidate = csv([...shopHeaders, heading], [[...red, ''], [...blue, '']]);
    expect(await inspectImport('shopify', shopBaseline, candidate)).toMatchObject({ verdict: 'FAIL_UNSAFE', nonTargetMutations: 1,
      issues: expect.arrayContaining([expect.objectContaining({ source: 'candidate', code: 'forbidden-column', line: 1, column: heading })]) });
  });

  it.each([
    ['stripped leading zero', [set(red, 4, '123'), blue], 'leading-zero-loss'],
    ['scientific SKU', [set(red, 4, '1.23E+11'), blue], 'scientific-sku'],
    ['case or text changed in SKU', [set(red, 4, '00123x'), blue], 'identity-mismatch'],
    ['unknown handle', [set(red, 0, 'new-coat'), blue], 'unknown-variant'],
    ['variant value mutation', [set(red, 3, 'Green'), blue], 'unknown-variant'],
    ['title changed', [set(red, 1, 'Coat'), blue], 'identity-mismatch'],
    ['title inserted in continuation', [red, set(blue, 1, 'Coat\nOriginal')], 'identity-mismatch'],
    ['option name inserted in continuation', [red, set(blue, 2, 'Color')], 'identity-mismatch'],
    ['missing sibling', [red], 'broken-shopify-group'],
    ['split handle', [red, hat, blue], 'broken-shopify-group'],
    ['reversed siblings', [blue, red], 'broken-shopify-group'],
    ['duplicate option identity', [red, red], 'duplicate-variant-key'],
    ['duplicate SKU', [red, set(blue, 4, red[4])], 'duplicate-sku'],
    ['scientific price', [set(red, 5, '1.2e1'), blue], 'invalid-target-value'],
    ['price with a hidden newline', [set(red, 5, '12\n'), blue], 'invalid-target-value'],
    ['blank price', [set(red, 5, ''), blue], 'invalid-target-value'],
    ['fractional quantity', [set(red, 7, '1.2'), blue], 'invalid-target-value'],
    ['new blank quantity', [set(red, 7, ''), blue], 'invalid-target-value'],
    ['new negative quantity', [set(red, 7, '-1'), blue], 'invalid-target-value'],
    ['invalid new compare-at', [set(red, 6, '9'), blue], 'compare-at-not-above-price'],
    ['empty delimiter-only record', [red, blue, shopHeaders.map(() => '')], 'unknown-variant'],
  ] as const)('rejects %s', async (_, rows, code) => {
    const result = await inspectImport('shopify', shopBaseline, shop([...rows]));
    expect(result).toMatchObject({ verdict: 'FAIL_UNSAFE', rollback: { residualDiffs: null, restored: false },
      issues: expect.arrayContaining([expect.objectContaining({ source: 'candidate', code })]) });
  });

  it('rejects duplicate aliases rather than trusting a first or last value', async () => {
    const candidate = csv([...shopHeaders, 'Price'], [[...red, '11'], [...blue, '12']]);
    expect(await inspectImport('shopify', shopBaseline, candidate)).toMatchObject({ verdict: 'FAIL_UNSAFE',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'duplicate-header', line: 1 })]) });
  });

  it('rejects a hidden linked option anywhere in a touched group', async () => {
    const baseline = csv([...shopHeaders, 'Option1 LinkedTo'], [[...red, ''], [...blue, 'product.metafields.custom.color']]);
    expect(await inspectImport('shopify', baseline, shop([changedRed, blue]))).toMatchObject({ verdict: 'FAIL_UNSAFE', brokenGroups: 1,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'linked-shopify-options', line: 4 })]) });
  });

  it('rejects a missing active second dimension', async () => {
    const baseline = csv([...shopHeaders, 'Option2 Name', 'Option2 Value'], [[...red, 'Fit', 'Regular'], [...blue, '', 'Slim']]);
    expect(await inspectImport('shopify', baseline, shop([red, blue]))).toMatchObject({ verdict: 'FAIL_UNSAFE', brokenGroups: 1 });
  });

  it('rejects a missing stock baseline when the candidate writes stock', async () => {
    const baseline = csv(shopHeaders.slice(0, -1), [red.slice(0, -1), blue.slice(0, -1)]);
    expect(await inspectImport('shopify', baseline, shop([changedRed, blue]))).toMatchObject({ verdict: 'FAIL_UNSAFE',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'missing-baseline-target', column: 'Variant Inventory Qty' })]) });
  });

  it('reports the physical line of malformed CSV and hashes the original bytes', async () => {
    const candidate = Buffer.concat([shop([red, blue]), encode('\n"unterminated')]);
    expect(await inspectImport('shopify', shopBaseline, candidate)).toMatchObject({ verdict: 'FAIL_UNSAFE', candidateSha256: digest(candidate),
      issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid-csv', line: 5 })]) });
  });

  it('rejects an unsupported encoding with both file fingerprints', async () => {
    const candidate = Uint8Array.of(0xfe, 0xff, 0x00, 0x7f);
    expect(await inspectImport('shopify', shopBaseline, candidate)).toMatchObject({ verdict: 'FAIL_UNSAFE', baselineSha256: digest(shopBaseline),
      candidateSha256: digest(candidate), issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid-encoding' })]) });
  });
});

describe('WooCommerce import inspection', () => {
  it('allows sparse known variations and preserves an apostrophe-prefixed negative stock rollback', async () => {
    const edited = ['11', 'variation', '0012345', 'id:10', '30.00', '', '6'];
    const update = woo([edited]);
    const result = await inspectImport('woocommerce', wooBaseline, update);
    expect(result).toMatchObject({ verdict: 'PASS', matchedRows: 1, changedSkus: 1, unchangedSiblingSkus: 1, brokenGroups: 0 });
    expect(result.rows[0].changes).toEqual([
      { column: 'Regular price', before: '025.005', after: '30.00', delta: '4.995' },
      { column: 'Sale price', before: '020.000', after: '', delta: null },
      { column: 'Stock', before: "'-2", after: '6', delta: '8' },
    ]);
    expect(await inspectImport('woocommerce', wooBaseline, woo([variation]), update)).toMatchObject({ verdict: 'PASS',
      rollback: { scope: 'paired-update', residualDiffs: 0, restored: true } });
  });

  it('accepts exact parent SKU references independently of numeric ID references', async () => {
    const candidate = csv(wooHeaders.slice(0, -1), [set(variationBySku.slice(0, -1), 4, '45')]);
    expect(await inspectImport('woocommerce', wooBaseline, candidate)).toMatchObject({ verdict: 'PASS', matchedRows: 1 });
  });

  it('recognizes ASCII padding and case folding used by the WooCommerce importer', async () => {
    const candidate = csv(['id', 'type', ' sku ', 'parent', 'REGULAR\tPRICE', 'sale price', ' STOCK '], [variation]);
    expect(await inspectImport('woocommerce', wooBaseline, candidate)).toMatchObject({ verdict: 'PASS', matchedRows: 1 });
  });

  it.each([[4, '\u00a0Regular price\u00a0'], [2, '\u00a0SKU'], [6, '\ufeffStock']] as const)
    ('holds a non-ASCII-padded WooCommerce heading at column %d', async (index, header) => {
      const candidate = csv(set(wooHeaders, index, header), [variation]);
      expect(await inspectImport('woocommerce', wooBaseline, candidate)).toMatchObject({ verdict: 'FAIL_UNSAFE', nonTargetMutations: 1,
        issues: expect.arrayContaining([expect.objectContaining({ code: 'forbidden-column', column: header })]) });
    });

  it.each(['Description', 'Categories', 'Images', 'Meta:cost', 'Name'])('rejects unchanged non-target WooCommerce header %s', async (heading) => {
    expect(await inspectImport('woocommerce', wooBaseline, csv([...wooHeaders, heading], [[...simple, '']]))).toMatchObject({ verdict: 'FAIL_UNSAFE', nonTargetMutations: 1 });
  });

  it.each([
    ['unknown id', set(variation, 0, '99'), 'unknown-woo-id'],
    ['scientific id', set(variation, 0, '1.1E+1'), 'unknown-woo-id'],
    ['leading-zero loss', set(variation, 2, '12345'), 'leading-zero-loss'],
    ['scientific SKU', set(variation, 2, '1.2345E+4'), 'scientific-sku'],
    ['alternate spelling resolving to same parent', set(variation, 3, 'COAT'), 'identity-mismatch'],
    ['bad parent ID', set(variation, 3, 'id:99'), 'identity-mismatch'],
    ['wrong type', set(variation, 1, 'simple'), 'identity-mismatch'],
    ['variable parent product', parent, 'unsupported-woo-update-type'],
    ['unmanaged stock', set(variationBySku, 6, '15'), 'woo-stock-not-managed'],
    ['cleared managed stock', set(variation, 6, ''), 'woo-stock-not-managed'],
    ['retail under retained sale', set(simple, 4, '15'), 'sale-price-not-below-regular-price'],
    ['new fractional stock', set(simple, 6, '1.5'), 'woo-stock-not-managed'],
  ] as const)('rejects %s', async (_, row, code) => {
    expect(await inspectImport('woocommerce', wooBaseline, woo([row]))).toMatchObject({ verdict: 'FAIL_UNSAFE',
      issues: expect.arrayContaining([expect.objectContaining({ source: 'candidate', code })]) });
  });

  it('rejects a variation if the original parent is absent from the baseline', async () => {
    expect(await inspectImport('woocommerce', woo([variation]), woo([variation]))).toMatchObject({ verdict: 'FAIL_UNSAFE', brokenGroups: 1,
      issues: expect.arrayContaining([expect.objectContaining({ source: 'baseline', code: 'invalid-woo-parent', column: 'Parent' })]) });
  });

  it('rejects duplicate existing IDs in the candidate', async () => {
    expect(await inspectImport('woocommerce', wooBaseline, woo([variation, variation]))).toMatchObject({ verdict: 'FAIL_UNSAFE',
      issues: expect.arrayContaining([expect.objectContaining({ source: 'candidate', code: 'duplicate-woo-id' })]) });
  });

  it('rejects price reductions that can silently clear an unseen WooCommerce sale', async () => {
    const baseline = csv(wooHeaders.slice(0, 5), [simple.slice(0, 5)]);
    const candidate = csv(wooHeaders.slice(0, 5), [set(simple.slice(0, 5), 4, '25')]);
    expect(await inspectImport('woocommerce', baseline, candidate)).toMatchObject({ verdict: 'FAIL_UNSAFE',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'woo-sale-price-required' })]) });
  });

  it('rejects an omitted paired sale-price coordinate even though the candidate equals the baseline', async () => {
    const update = woo([set(simple, 5, '25.00')]);
    const candidate = csv([...wooHeaders.slice(0, 5), 'Stock'], [[...simple.slice(0, 5), simple[6]]]);
    expect(await inspectImport('woocommerce', wooBaseline, candidate, update)).toMatchObject({ verdict: 'FAIL_UNSAFE',
      rollback: { scope: 'paired-update', residualDiffs: 1, restored: false },
      issues: expect.arrayContaining([expect.objectContaining({ code: 'rollback-residual', column: 'Sale price' })]) });
  });

  it('rejects restoration claims when the actual paired update is unsafe', async () => {
    const update = csv([...wooHeaders, 'Images'], [[...simple, '']]);
    expect(await inspectImport('woocommerce', wooBaseline, woo([simple]), update)).toMatchObject({ verdict: 'FAIL_UNSAFE',
      rollback: { scope: 'paired-update', residualDiffs: null, restored: false, pairedUpdateSha256: digest(update) },
      issues: expect.arrayContaining([expect.objectContaining({ source: 'update', code: 'forbidden-column' })]) });
  });
});
