import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../../src/core/csv';
import { buildPriceDiff, parseBaseline, parseSupplier } from '../../../src/core/shopify-price-diff';

describe('large duplicate SKU audit', () => {
  it('references a shared diagnostic rather than repeating 20,000 source lines on every row', () => {
    const count = 20_000;
    const records = Array.from({ length: count }, (_, index) => `item-${index},Item ${index},Title,Default Title,0007,10`);
    const bytes = (head: string, rows: string[]) => new TextEncoder().encode([head, ...rows].join('\n'));
    const baseline = parseBaseline(bytes('Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price', records));
    const supplier = parseSupplier(bytes('SKU,New Price', Array<string>(count).fill('0007,11')), 'duplicates.csv').sheets[0];
    const result = buildPriceDiff(baseline, supplier);
    expect(result.status).toBe('review');
    expect(result.updateCsv).toBeNull();
    const json = result.auditJson;
    const csv = result.auditCsv;
    expect(json.length).toBeLessThan(40_000_000);
    expect(csv.length).toBeLessThan(12_000_000);
    const audit = JSON.parse(json);
    const sourceLines = Array.from({ length: count }, (_, index) => index + 2);
    const duplicates = audit.issues.filter(({ code }: { code: string }) => code === 'duplicate-sku');
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0].rows).toEqual(sourceLines);
    expect(duplicates[1].rows).toEqual(sourceLines);
    const first = audit.rows[0].issues.find(({ issueIndex }: { issueIndex?: number }) => issueIndex !== undefined);
    expect(audit.issues[first.issueIndex].code).toBe('duplicate-sku');
    const [, summary, firstRow] = parseCsv(new TextDecoder().decode(new TextEncoder().encode(csv))).records;
    expect(JSON.parse(summary.cells.at(-1)!).issues).toEqual(audit.issues);
    expect(JSON.parse(firstRow.cells.at(-1)!).issues).toEqual(audit.rows[0].issues);
  }, 20_000);
});
