import { expect, it } from 'vitest';
import { parseCsv } from '../../../src/core/csv';
import { buildMultiSupplierDiff, parseBaseline, parseSupplier } from '../../../src/core/shopify-price-diff';

const bytes = (value: string) => new TextEncoder().encode(value);

it('stores a dense multi-source conflict once and retains every contender through both audit references', () => {
  const count = 800;
  const baseline = parseBaseline(bytes('Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price\nproduct,Example,Title,Default Title,SKU,20.00'));
  const inputs = ['First', 'Second'].map((label, index) => {
    const filename = `${label}.csv`;
    const input = 'SKU,Price\n' + `SKU,${21 + index}.00\n`.repeat(count);
    return { supplierId: label, filename, label, sheet: parseSupplier(bytes(input), filename).sheets[0], selection: { confirmed: true } };
  });
  const result = buildMultiSupplierDiff(baseline, inputs);
  expect(result.canDownload).toBe(false);
  const json = result.auditJson;
  const csv = result.auditCsv;
  expect(json.length).toBeLessThan(4_000_000);
  expect(csv.length).toBeLessThan(2_000_000);
  const report = JSON.parse(json);
  const ref = report.rows.find((row: { supplierContendersIssueIndex?: number }) => row.supplierContendersIssueIndex !== undefined).supplierContendersIssueIndex;
  const shared = report.issues[ref].supplierContenders;
  expect(shared).toHaveLength(2 * (count - 1));
  expect(shared[0]).toMatchObject({ label: 'First', row: 3, price: '21.00' });
  expect(shared.at(-1)).toMatchObject({ label: 'Second', row: count + 1, price: '22.00' });
  expect(report.rows.filter((row: { supplierContendersIssueIndex?: number }) => row.supplierContendersIssueIndex === ref)).toHaveLength(2 * (count - 1) + 1);
  const [{ cells: headers }, { cells: summary }, ...lines] = parseCsv(csv).records;
  const reviewIndex = headers.length - 1;
  expect(headers[reviewIndex]).toBe('Review and Resolution (JSON)');
  expect(JSON.parse(summary[reviewIndex]).issues[ref].supplierContenders).toEqual(shared);
  const contenderColumn = headers.indexOf('Supplier Contenders (JSON)');
  expect(lines.filter(({ cells }) => cells[contenderColumn] === `{"issueIndex":${ref}}`)).toHaveLength(2 * (count - 1) + 1);
});
