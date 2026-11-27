import { readFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../../src/core/csv';
import { buildPriceDiff, parseBaseline, parseSupplier } from '../../../src/core/shopify-price-diff';

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/shopify-price-diff/${name}`, import.meta.url));

describe('Shopify scoped price updates', () => {
  it('preserves SKU strings and emits complete affected products from real file bytes', () => {
    const baseline = parseBaseline(fixture('baseline-agency.csv'));
    const supplier = parseSupplier(fixture('supplier-agency.csv'), 'supplier.csv').sheets[0];
    const flagged = buildPriceDiff(baseline, supplier);
    expect(flagged.canDownload).toBe(false);
    expect(flagged.rows).toContainEqual(expect.objectContaining({ sku: '00123', status: 'Blocked', baselineRow: 2, supplierRow: 2 }));
    const approved = buildPriceDiff(baseline, supplier, undefined, { 2: { skip: true } });
    expect(approved.canDownload).toBe(true);
    expect(approved.verification).toEqual({ checked: true, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 });
    const [header, ...rows] = parseCsv(approved.updateCsv!).records;
    expect(header.cells).toEqual(['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value', 'Variant SKU', 'Variant Price']);
    expect(rows.map(({ cells }) => [cells[1], cells[8], cells[9]])).toEqual([
      ['  Canvas Jacket  ', '00123', '100.00'], ['', '00045-XL', '24.00'], ['', '00046-L', '22.00'],
    ]);
  });
});

const csvBytes = (text: string) => new TextEncoder().encode(text);
const base = (name = 'baseline-agency.csv') => parseBaseline(fixture(name), name);
const sheet = (name: string, index = 0) => parseSupplier(fixture(name), name).sheets[index];
const codes = (result: ReturnType<typeof buildPriceDiff>) => result.issues.map(({ code }) => code);
const csvCells = (content: string) => parseCsv(content).records.map(({ cells }) => cells);

describe('golden supplier file replay', () => {
  it('uses sparse Excel row numbers, preserves rich and shared text SKUs, and switches worksheets', () => {
    const workbook = parseSupplier(fixture('supplier-agency.xlsx'), 'supplier-agency.xlsx');
    expect(workbook.issues).toEqual([]);
    expect(workbook.sheets.map(({ name }) => name)).toEqual(['Agency prices', 'Secondary']);
    const first = buildPriceDiff(base(), workbook.sheets[0]);
    expect(first.issues).toContainEqual(expect.objectContaining({ code: 'price-drop', row: 2 }));
    expect(first.rows).toContainEqual(expect.objectContaining({ sku: '00045-XL', baselineRow: 4, supplierRow: 5, status: 'Updated', newPrice: '24.00' }));
    expect(first.rows).toContainEqual(expect.objectContaining({ sku: 'AGENCY-NEW', supplierRow: 8, status: 'Unmatched Supplier Row' }));
    const second = buildPriceDiff(base(), workbook.sheets[1]);
    expect(second.status).toBe('ready');
    expect(csvCells(second.updateCsv!).slice(1).map((r) => r.slice(0, 10))).toEqual([
      ['travel-pouch', 'Travel Pouch', 'Color', 'Black', 'Size', 'One', '', '', 'P-01', '16.00'],
      ['travel-pouch', '', '', 'Brown', '', 'One', '', '', 'P-02', '18.00'],
    ]);
  });

  it.each([
    ['supplier-numeric.xlsx', 'non-text-sku', 7],
    ['supplier-scientific.xlsx', 'scientific-sku', 7],
    ['supplier-scientific-text.xlsx', 'scientific-sku', 7],
    ['supplier-scientific.csv', 'scientific-sku', 2],
    ['supplier-duplicate-header.xlsx', 'duplicate-header', 3],
    ['supplier-duplicate-header.csv', 'duplicate-header', 1],
    ['supplier-invalid-quotes.csv', 'invalid-csv', 2],
    ['supplier-short-row.csv', 'row-width', 2],
    ['supplier-missing-key.csv', 'missing-supplier-key', 2],
    ['supplier-missing-option.csv', 'invalid-supplier-variant-key', 2],
  ])('blocks %s at the original row', (name, code, line) => {
    const result = buildPriceDiff(base(), sheet(name));
    expect(result.status).toBe('review');
    expect(result.updateCsv).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code, row: line, blocking: true }));
  });

  it.each([
    ['supplier-dtd.xlsx', 'invalid-xlsx'],
    ['supplier-external.xlsx', 'external-xlsx-relationship'],
  ])('rejects untrusted XLSX structure %s', (name, code) => {
    const workbook = parseSupplier(fixture(name), name);
    expect(workbook.sheets).toEqual([]);
    expect(workbook.issues).toContainEqual(expect.objectContaining({ code, blocking: true }));
  });

  it('rejects truncated archive bytes and unsupported filename types', () => {
    const bytes = fixture('supplier-agency.xlsx');
    expect(parseSupplier(bytes.subarray(0, bytes.length - 10), 'truncated.xlsx').issues[0].code).toBe('invalid-xlsx');
    expect(parseSupplier(bytes, 'macro.xlsm').issues[0].code).toBe('unsupported-file');
  });

  it('rejects malformed sheet cell content, conflicting physical row references and external cached workbooks', () => {
    const mutate = (path: string, edit: (source: string) => string) => {
      const entries = unzipSync(fixture('supplier-agency.xlsx'));
      entries[path] = strToU8(edit(strFromU8(entries[path])));
      return parseSupplier(zipSync(entries), 'malformed.xlsx');
    };
    const worksheet = 'xl/worksheets/sheet1.xml';
    const wrongType = mutate(worksheet, (xml) => xml.replace('<v>24.00</v>', '<v invalid="true">24.00</v>'));
    expect(wrongType.issues[0].code).toBe('invalid-xlsx');
    const wrongRow = mutate(worksheet, (xml) => xml.replace('r="A5"', 'r="A6"'));
    expect(wrongRow.issues[0].code).toBe('invalid-xlsx');
    const cachedLink = mutate('xl/_rels/workbook.xml.rels', (xml) => xml.replace('</Relationships>',
      '<Relationship Id="cache" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="externalLinks/externalLink1.xml"/></Relationships>'));
    expect(cachedLink.issues[0].code).toBe('external-xlsx-relationship');
  });

  it('rejects excessive ZIP entries without attempting to parse a workbook', () => {
    const entries = Object.fromEntries(Array.from({ length: 513 }, (_, index) => ['overflow/test-' + index + '.xml', strToU8('<blank/>')]));
    expect(parseSupplier(zipSync(entries), 'over-entry-limit.xlsx').issues[0].code).toBe('invalid-xlsx');
  });

  it('treats an XLSX currency number format as explicit evidence and preserves the stored decimal', () => {
    const entries = unzipSync(fixture('supplier-agency.xlsx'));
    const rels = strFromU8(entries['xl/_rels/workbook.xml.rels']);
    entries['xl/_rels/workbook.xml.rels'] = strToU8(rels.replace('</Relationships>',
      '<Relationship Id="sty" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'));
    entries['xl/styles.xml'] = strToU8('<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="[$€-407]0.00"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>');
    const source = strFromU8(entries['xl/worksheets/sheet2.xml']);
    entries['xl/worksheets/sheet2.xml'] = strToU8(source.replace('r="B2" t="n"><v>18.00', 'r="B2" t="n" s="1"><v>1.80000000000000001E1'));
    const supplier = parseSupplier(zipSync(entries), 'numeric-style.xlsx').sheets[1];
    expect(codes(buildPriceDiff(base(), supplier))).toContain('currency-confirmation-required');
    const result = buildPriceDiff(base(), supplier, { sameCurrencyConfirmed: true });
    expect(result.rows).toContainEqual(expect.objectContaining({ sku: 'P-02', supplierPrice: '1.80000000000000001E1', newPrice: '18.0000000000000001' }));
    expect(result.canDownload).toBe(true);
  });

  it('uses formula expressions only as original audit data and accepts an explicit valid override', () => {
    const formula = sheet('supplier-formula.xlsx');
    const result = buildPriceDiff(base(), formula);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'invalid-price', row: 9, value: '24.00' }));
    expect(JSON.parse(result.auditJson).rows.find((row: { supplierRow: number }) => row.supplierRow === 9).supplierCells[1]).toEqual({
      value: '24.00', kind: 'formula', formula: '12*2',
    });
    const approved = buildPriceDiff(base(), formula, {}, { 9: { price: '23.75' } });
    expect(approved.status).toBe('ready');
    expect(approved.rows.find((row) => row.supplierRow === 9)?.newPrice).toBe('23.75');
  });

  it('requires explicit currency confirmation and does not revalue a euro amount', () => {
    for (const input of ['supplier-euro.csv', 'supplier-utf16.csv']) {
      const euro = sheet(input);
      const requiresReview = buildPriceDiff(base(), euro);
      expect(codes(requiresReview)).toContain('currency-confirmation-required');
      expect(requiresReview.canDownload).toBe(false);
      const approved = buildPriceDiff(base(), euro, { sameCurrencyConfirmed: true });
      expect(approved.status).toBe('ready');
      expect(approved.rows).toContainEqual(expect.objectContaining({ sku: '00045-XL', newPrice: '19.99', supplierPrice: '19,99 €', deltaPercent: '-0.05' }));
    }
  });

  it('keeps explicit source currency evidence after a numeric override', () => {
    const euro = sheet('supplier-euro.csv');
    expect(codes(buildPriceDiff(base(), euro, {}, { 2: { price: '19.50' } }))).toContain('currency-confirmation-required');
    expect(codes(buildPriceDiff(base(), euro, { sameCurrencyConfirmed: true }, { 2: { price: '$19.50' } }))).toContain('currency-conflict');
  });

  it('blocks conflicting currencies even when same-currency is selected', () => {
    const input = sheet('supplier-mixed-currency.csv');
    const flagged = buildPriceDiff(base(), input, { sameCurrencyConfirmed: true });
    expect(flagged.issues).toContainEqual(expect.objectContaining({ code: 'currency-conflict', rows: [2, 3] }));
    expect(buildPriceDiff(base(), input, { sameCurrencyConfirmed: true }, { 3: { skip: true } }).status).toBe('ready');
  });

  it('uses a separate supplier Currency column when the amounts have no symbol', () => {
    const input = parseSupplier(csvBytes('SKU,New Price,Currency\n00123,98,USD\n00045-XL,24,CAD\n'), 'sup.csv').sheets[0];
    expect(codes(buildPriceDiff(base(), input, { sameCurrencyConfirmed: true }))).toContain('currency-conflict');
  });

  it('blocks duplicate SKU even when a user skips a conflicting row', () => {
    const result = buildPriceDiff(base(), sheet('supplier-duplicate-sku.csv'), {}, { 2: { skip: true } });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'duplicate-sku', rows: [2, 3], value: '00123' }));
    expect(result.rows.filter(({ supplierRow }) => supplierRow !== null).map(({ status }) => status)).toEqual(['Blocked', 'Blocked']);
  });

  it('blocks duplicate handle and option identity independently of the chosen SKU join', () => {
    const duplicate = sheet('supplier-duplicate-options.csv');
    for (const joinKey of ['sku', 'handle-options'] as const) {
      const result = buildPriceDiff(base(), duplicate, { confirmed: true, joinKey });
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'duplicate-variant-key', rows: [2, 3] }));
      expect(result.canDownload).toBe(false);
    }
  });

  it('asks for a mapping choice and honors the selected supplier column positions', () => {
    const inputs = sheet('supplier-ambiguous-mapping.csv');
    const initial = buildPriceDiff(base(), inputs);
    expect(initial.suggestions.priceColumns).toEqual([2, 3]);
    expect(initial.suggestions.skuColumns).toEqual([0, 1]);
    expect(codes(initial)).toContain('mapping-confirmation-required');
    expect(buildPriceDiff(base(), inputs, { confirmed: true, skuColumn: 0, priceColumn: 3 }).rows)
      .toContainEqual(expect.objectContaining({ sku: '00045-XL', status: 'Updated', newPrice: '12.00' }));
    expect(codes(buildPriceDiff(base(), inputs, { confirmed: true, skuColumn: 0, priceColumn: 0 }))).toContain('invalid-column-selection');
    expect(codes(buildPriceDiff(base(), sheet('supplier-agency.csv'), { confirmed: false }))).toContain('mapping-confirmation-required');
  });

  it('joins handle and up to three exact option values without changing the baseline SKU', () => {
    const inputs = sheet('supplier-options.csv');
    const result = buildPriceDiff(base(), inputs);
    expect(result.suggestions.selection.joinKey).toBe('handle-options');
    expect(result.canDownload).toBe(true);
    expect(result.rows).toContainEqual(expect.objectContaining({ sku: '00045-XL', status: 'Updated' }));
    const whitespace = buildPriceDiff(base('baseline-exact-option.csv'), sheet('supplier-options-exact.csv'));
    expect(whitespace.canDownload).toBe(true);
    expect(csvCells(whitespace.updateCsv!)[1][3]).toBe(' Forest ');
    const defaultTitle = buildPriceDiff(base('baseline-default-title.csv'), sheet('supplier-default-title.csv'));
    expect(csvCells(defaultTitle.updateCsv!)[1].slice(2, 4)).toEqual(['Title', 'Default Title']);
  });
});

describe('baseline variant and output invariants', () => {
  const validSupplier = () => sheet('supplier-precision.csv');
  it.each([
    ['baseline-duplicate-sku.csv', 'duplicate-sku', [2, 5]],
    ['baseline-duplicate-options.csv', 'duplicate-variant-key', [4, 5]],
    ['baseline-noncontiguous.csv', 'noncontiguous-handle', [2, 6, 7, 8]],
    ['baseline-missing-title.csv', 'missing-title', [2]],
    ['baseline-option-name-conflict.csv', 'invalid-variant-options', [2, 4]],
    ['baseline-missing-option.csv', 'invalid-variant-options', [2, 5]],
    ['baseline-option-blank-title.csv', 'invalid-variant-options', [2]],
    ['baseline-image-not-variant.csv', 'invalid-baseline-price', [6]],
    ['baseline-missing-price.csv', 'invalid-baseline-price', [5]],
    ['baseline-duplicate-header.csv', 'duplicate-header', [1]],
    ['baseline-linked-option.csv', 'unsupported-linked-option', [2]],
  ])('reports precise baseline rows for %s', (file, code, lines) => {
    const result = buildPriceDiff(base(file), validSupplier());
    expect(result.issues).toContainEqual(expect.objectContaining({ code, rows: lines }));
    expect(result.updateCsv).toBeNull();
  });

  it('preserves a blank baseline SKU on a sibling instead of rehoming or omitting it', () => {
    const result = buildPriceDiff(base('baseline-missing-sku.csv'), validSupplier());
    expect(result.status).toBe('ready');
    expect(csvCells(result.updateCsv!)[3][8]).toBe('');
    expect(result.rows).toContainEqual(expect.objectContaining({ baselineRow: 5, sku: '', status: 'Missing in Supplier' }));
  });

  it('recognizes modern Shopify headers and omits linked values from unaffected groups', () => {
    const modern = buildPriceDiff(base('baseline-modern.csv'), validSupplier());
    expect(modern.status).toBe('ready');
    expect(csvCells(modern.updateCsv!)[1].slice(0, 2)).toEqual(['canvas-jacket', '  Canvas Jacket  ']);
    const unaffected = buildPriceDiff(base('baseline-linked-unaffected.csv'), validSupplier());
    expect(unaffected.status).toBe('ready');
    expect(unaffected.updateCsv).toBe(modern.updateCsv);
  });

  it('keeps original baseline compare-at omitted and auditably distinct from blank when no mapping is chosen', () => {
    const result = buildPriceDiff(base(), sheet('supplier-mapped-partial-compare.csv'));
    const audit = JSON.parse(result.auditJson);
    expect(csvCells(result.updateCsv!)[0]).not.toContain('Variant Compare At Price');
    expect(audit.columns.omittedBaselineHeaders).toEqual(expect.arrayContaining(['Body (HTML)', 'Tags', 'Image Src', 'Variant Compare At Price']));
    expect(audit.rows.find((row: { sku: string }) => row.sku === '00046-L')).toMatchObject({
      oldCompareAtPrice: '', newCompareAtPrice: '', compareAtOutput: 'omitted',
    });
    expect(audit.rows.find((row: { sku: string }) => row.sku === '00123').baselineCells[2].value).toBe('<p>Waxed canvas,\r\nriver green.</p>');
    expect(audit.preservedBaselineRows[0]).toMatchObject({ line: 6 });
    expect(audit.preservedBaselineRows[0].cells[4].value).toBe('https://example.invalid/b.png');
  });

  it('when mapped, emits retained compare-at cells and exact empty baseline siblings', () => {
    const result = buildPriceDiff(base(), sheet('supplier-mapped-partial-compare.csv'), { compareAtColumn: 2 });
    expect(result.status).toBe('ready');
    const [head, ...out] = csvCells(result.updateCsv!);
    expect(head.at(-1)).toBe('Variant Compare At Price');
    expect(out.map((row) => row.at(-1))).toEqual(['130.00', '33.00', '']);
    expect(result.rows.find(({ sku }) => sku === '00046-L')?.compareAtOutput).toBe('empty');
    expect(result.rows.find(({ sku }) => sku === 'P-02')?.compareAtOutput).toBe('omitted');
    expect(result.rows.find(({ sku }) => sku === '00123')?.supplierCompareAtPrice).toBe('');
    const absent = buildPriceDiff(base('baseline-no-compare-at.csv'), sheet('supplier-mapped-partial-compare.csv'), { compareAtColumn: 2 });
    expect(absent.rows.find(({ sku }) => sku === '00123')?.oldCompareAtPrice).toBeNull();
    expect(codes(absent)).toContain('missing-baseline-compare-at');
  });

  it('stages a true compare-at-only change while retaining the original price format', () => {
    const result = buildPriceDiff(base(), sheet('supplier-only-compare-change.csv'), { compareAtColumn: 2 });
    expect(result.rows).toContainEqual(expect.objectContaining({ sku: '00045-XL', status: 'Updated', newPrice: '20.00', newCompareAtPrice: '33.00' }));
    expect(csvCells(result.updateCsv!)[2].slice(9)).toEqual(['20.00', '33.00']);
  });

  it('retains specific Missing in Supplier, Unmatched Supplier Row, Skipped, and Unchanged statuses', () => {
    const unchanged = buildPriceDiff(base(), sheet('supplier-no-effective-change.csv'));
    expect(unchanged.status).toBe('no-changes');
    expect(unchanged.rows).toContainEqual(expect.objectContaining({ sku: '00045-XL', status: 'Unchanged', newPrice: '20.00' }));
    const unmatched = buildPriceDiff(base(), sheet('supplier-unknown-key.csv'));
    expect(unmatched.rows[0]).toMatchObject({ sku: '00123', status: 'Missing in Supplier' });
    expect(unmatched.rows.at(-1)).toMatchObject({ sku: 'no-longer-carried', status: 'Unmatched Supplier Row' });
    const skipped = buildPriceDiff(base(), sheet('supplier-agency.csv'), {}, { 2: { skip: true } });
    expect(skipped.rows[0]).toMatchObject({ sku: '00123', status: 'Skipped', newPrice: '100.00', priceOutput: 'value' });
  });

  it('uses exact decimal change comparison and exact default movement thresholds', () => {
    const precision = buildPriceDiff(base(), validSupplier());
    expect(precision.canDownload).toBe(true);
    expect(csvCells(precision.updateCsv!)[2].at(-1)).toBe('20.000000000000000001');
    const equalBoundary = buildPriceDiff(base(), sheet('supplier-threshold-boundaries.csv'));
    expect(equalBoundary.canDownload).toBe(true);
    expect(equalBoundary.rows.slice(0, 2).map((row) => row.deltaPercent)).toEqual(['-50', '200']);
    const outside = buildPriceDiff(base(), sheet('supplier-increase.csv'));
    expect(codes(outside)).toContain('price-increase');
    expect(outside.canDownload).toBe(false);
  });

  it('requires a valid new price even if the user approves a nonpositive value', () => {
    const zero = sheet('supplier-zero-negative.csv');
    const invalid = buildPriceDiff(base(), zero, {}, { 2: { confirm: true }, 3: { confirm: true } });
    expect(invalid.issues.filter(({ code }) => code === 'invalid-price').map(({ row }) => row)).toEqual([2, 3]);
    expect(invalid.canDownload).toBe(false);
    const fixed = buildPriceDiff(base(), zero, {}, { 2: { price: '40', confirm: true }, 3: { price: '24' } });
    expect(fixed.canDownload).toBe(true);
    expect(fixed.issues).toContainEqual(expect.objectContaining({ code: 'price-drop', row: 2, blocking: false }));
    expect(csvCells(fixed.updateCsv!).slice(1).map((row) => row.at(-1))).toEqual(['40', '24', '22.00']);
    expect(codes(buildPriceDiff(base(), sheet('supplier-ambiguous-grouping.csv')))).toContain('invalid-price');
  });

  it('separates formula-safe CSV audit display cells and reversible original source values', () => {
    const result = buildPriceDiff(base(), sheet('supplier-unsafe-audit.csv'), { confirmed: true });
    expect(result.canDownload).toBe(true);
    const records = csvCells(result.auditCsv);
    const dangerous = records.find((row) => row[1] === "'=HYPERLINK(\"x\")")!;
    expect(dangerous[10]).toBe("'@N/A");
    expect(JSON.parse(dangerous[15])[0].value).toBe('=HYPERLINK("x")');
    const audit = JSON.parse(result.auditJson);
    expect(audit.rows).toContainEqual(expect.objectContaining({ sku: '  +suspicious', status: 'Unmatched Supplier Row' }));
  });

  it('replays a deterministic sweep of affected groups and confirms exact untouched source fields', () => {
    const baseline = base();
    const sourceHeaders = baseline.headers;
    for (const sku of ['00123', '00045-XL', '00046-L', 'P-01', 'P-02']) {
      const selected = baseline.variants.find((variant) => variant.sku === sku)!;
      const changed = String(Number(selected.price) + 1) + '.000000000000001';
      const inputs = parseSupplier(csvBytes('SKU,New Price\n' + sku + ',' + changed), 'sweep.csv').sheets[0];
      const result = buildPriceDiff(baseline, inputs);
      expect(result.verification).toEqual({ checked: true, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 });
      const [outHeaders, ...out] = csvCells(result.updateCsv!);
      const expected = baseline.variants.filter((variant) => variant.handle === selected.handle);
      expect(out.length).toBe(expected.length);
      out.forEach((record, row) => {
        const original = expected[row];
        outHeaders.forEach((column, index) => {
          const originalValue = original.source.cells[sourceHeaders.indexOf(column)].value;
          expect(record[index]).toBe(column === 'Variant Price' && original.sku === sku ? changed : originalValue);
        });
      });
    }
  });
});
