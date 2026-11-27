import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCostCreep, costCreepSparkline, inspectCostCreepSource } from '../../../src/core/cost-creep/engine';
import { parseCsv } from '../../../src/core/csv';
import { sha256 } from '../../../src/core/audit/custody';

const bytes = (text: string) => new TextEncoder().encode(text);
const fixture = (name: string) => readFileSync(new URL('../../../fixtures/' + name, import.meta.url));
const quarter = (number: number) => ({ filename: 'q' + number + '.csv', label: 'Q' + number, bytes: fixture('cost-creep/q' + number + '.csv') });
const period = (label: string, csv: string) => ({ label, filename: label + '.csv', bytes: bytes(csv) });

describe('multi-period supplier cost creep', () => {
  it('replays all four quarterly fixtures, preserves raw identifiers, separates gaps, and verifies the actual branded byte digests', async () => {
    const periods = [1, 2, 3, 4].map(quarter);
    const retail = { filename: 'store-retail.csv', bytes: fixture('cost-creep/store-retail.csv') };
    const branding = { agencyName: 'Sand & Sea', preparedFor: 'Buyer', contactNote: '', accentKey: 'navy' as const };
    const result = await buildCostCreep(periods, { retail, branding });
    expect(result.status).toBe('ready');
    expect(result.issues).toEqual([]);
    expect(result.summary).toEqual({ trackedSkus: 5, thresholdSkus: 3, worstCumulativeHikePercent: '20.00', consecutiveMultiHikeSkus: 3 });
    expect(result.rows.map(({ sku, lifecycle }) => [sku, lifecycle])).toEqual([
      ['00098', 'added-later'], ['00042', 'active-all-periods'], ['00083', 'reappeared'], ['00007', 'active-all-periods'], ['00051', 'discontinued'],
    ]);
    const [, increasing, reappearing] = result.rows;
    expect(increasing).toMatchObject({ firstObservedCost: '10.00', latestObservedCost: '11.25', cumulativeDelta: '1.25',
      cumulativeDeltaPercent: '12.50', hikeCount: 3, dropCount: 0, consecutiveHikes: 3, volatility: '1.25', meetsThreshold: true,
      margin: { retail: '22.50', oldGrossMarginPercent: '55.56', newGrossMarginPercent: '50.00', compressionPoints: '5.56' } });
    expect(reappearing).toMatchObject({ cumulativeDeltaPercent: '10.00', hikeCount: 0, consecutiveHikes: 0, meetsThreshold: true });
    expect(costCreepSparkline(reappearing.observations)).toEqual([[{ x: 6, y: 42 }], [{ x: 154, y: 6 }]]);
    const csv = parseCsv(result.historyCsv!);
    expect(csv.lineEnding).toBe('crlf');
    expect(csv.records.map(({ cells }) => cells[0])).toEqual(['SKU', ...result.rows.map(({ sku }) => sku)]);
    expect(result.historyCsv).toContain('20.000');
    const audit = JSON.parse(result.auditJson);
    expect(audit.custody).toEqual(result.custody);
    expect(audit.custody.periods.map(({ sha256 }: { sha256: string }) => sha256)).toEqual(await Promise.all(periods.map(({ bytes }) => sha256(bytes))));
    expect(audit.custody.retail.sha256).toBe(await sha256(retail.bytes));
    expect(audit.custody.historyCsvSha256).toBe(await sha256(bytes(result.historyCsv!)));
    expect(audit.custody.briefHtmlSha256).toBe(await sha256(bytes(result.briefHtml!)));
    expect(result.briefHtml).toContain('Prepared by <strong>Sand &amp; Sea</strong>');
    expect(result.briefHtml).toContain(audit.custody.historyCsvSha256);
    expect(result.briefHtml).not.toContain(audit.custody.briefHtmlSha256);
  });

  it('ranks exact fractions before rounding and never promotes a displayed 10.00% that is below threshold', async () => {
    const result = await buildCostCreep([
      period('Prior', 'SKU,Cost\nA,100\nB,100\nC,100\nD,0\nE,100'),
      period('Recent', 'SKU,Cost\nA,109.999\nB,110.001\nC,110\nD,20\nE,110'),
    ]);
    expect(result.rows.map(({ sku, cumulativeDeltaPercent, meetsThreshold }) => [sku, cumulativeDeltaPercent, meetsThreshold]))
      .toEqual([['B', '10.00', true], ['C', '10.00', true], ['E', '10.00', true], ['A', '10.00', false], ['D', null, false]]);
  });

  it('withholds output bytes for different offers at physical lines 2 and 4', async () => {
    const result = await buildCostCreep([quarter(1), { label: 'Q4', filename: 'conflicting-offers.csv',
      bytes: fixture('cost-creep/conflicting-offers.csv') }]);
    expect(result).toMatchObject({ status: 'blocked', historyCsv: null, briefHtml: null, rows: [],
      issues: [{ code: 'conflicting-duplicate-sku', periodLabel: 'Q4', row: 2, rows: [2, 4], column: 'SKU', sku: '00042' }] });
    expect(result.custody).not.toHaveProperty('historyCsvSha256');
    expect(result.custody).not.toHaveProperty('briefHtmlSha256');
    expect(JSON.parse(result.auditJson).custody.periods).toHaveLength(2);
  });

  it('coalesces only identical prices, retaining each original cost cell in the audit', async () => {
    const result = await buildCostCreep([period('Q1', 'SKU,Cost\n00042,1.00\n00042,1'),
      period('Q2', 'SKU,Cost\n00042,1.10')]);
    expect(result.rows[0]?.observations[0]?.sourceRows).toEqual([{ row: 2, rawCost: '1.00' }, { row: 3, rawCost: '1' }]);
  });

  it('selects an exact visible workbook tab and blocks numeric, formula, and scientific SKU identity', async () => {
    const workbook = { filename: 'supplier-agency.xlsx', bytes: fixture('shopify-price-diff/supplier-agency.xlsx') };
    const inspection = inspectCostCreepSource(workbook);
    expect(inspection.sheetNames.length).toBeGreaterThan(1);
    const name = inspection.sheetNames[1];
    const picked = inspectCostCreepSource({ ...workbook, sheetName: name });
    expect(picked.selectedSheet).toBe(name);
    expect(inspectCostCreepSource({ ...workbook, sheetName: name + ' ' }).issues[0].code).toBe('missing-worksheet');
    const numericWorkbook = { filename: 'supplier-numeric.xlsx', label: 'Numeric', bytes: fixture('shopify-price-diff/supplier-numeric.xlsx') };
    const result = await buildCostCreep([quarter(1), numericWorkbook]);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid-sku', periodLabel: 'Numeric', row: 7 })]));
    const csv = await buildCostCreep([quarter(1), period('Ambiguous', 'SKU,Cost\n001e2,5\n=1+2,4\nA,=1+2')]);
    expect(csv.issues.map(({ code, row }) => [code, row])).toEqual([['invalid-sku', 2], ['invalid-amount', 4]]);
  });

  it('requires proven same-denomination margin and holds conflicting currency evidence', async () => {
    const periods = [period('Earlier', 'SKU,Cost\n00042,10\nother,2'), period('Later', 'SKU,Cost\n00042,11\nother,3')];
    const retail = { filename: 'retail.csv', bytes: bytes('SKU,Retail Price\n00042,24\nother,0') };
    const unknown = await buildCostCreep(periods, { retail });
    expect(unknown.rows.every(({ margin }) => margin === null)).toBe(true);
    const agreed = await buildCostCreep(periods, { currency: 'USD', retail: { ...retail, currency: 'USD' } });
    expect(agreed.rows.find(({ sku }) => sku === '00042')?.margin?.compressionPoints).toBe('4.17');
    expect(agreed.rows.find(({ sku }) => sku === 'other')?.margin).toBeNull();
    const conflict = await buildCostCreep([period('USD quarter', 'SKU,Cost\n00042,USD 10'),
      period('EUR quarter', 'SKU,Cost\n00042,EUR 11')]);
    expect(conflict).toMatchObject({ status: 'blocked', historyCsv: null, briefHtml: null });
    expect(conflict.issues.map(({ periodLabel, row }) => [periodLabel, row])).toEqual([
      ['USD quarter', 2], ['EUR quarter', 2],
    ]);
  });

  it('neutralizes text in the CSV and report and shows the full export count beyond the brief limit', async () => {
    const rows = Array.from({ length: 24 }, (_, i) => 'sku' + i);
    const sku = '=2+2<script src=https://holder.invalid/p></script>';
    const title = '=+https://supplier.invalid/';
    const result = await buildCostCreep([
      period(title, 'SKU,Cost\n' + [sku, ...rows].map((key) => key + ',100').join('\n')),
      period('New', 'SKU,Cost\n' + [sku, ...rows].map((key) => key + ',111').join('\n')),
    ], { branding: { agencyName: 'Brand //evil.invalid', preparedFor: 'Buyer <img src=javascript:alert(1)>',
      contactNote: 'Contact ftp://contact.invalid/', accentKey: 'forest' } });
    expect(result.rows).toHaveLength(25);
    const { records } = parseCsv(result.historyCsv!);
    expect(records).toHaveLength(26);
    expect(records[1].cells[0]).toBe("'" + sku);
    expect(JSON.parse(result.auditJson).rows[0].sku).toBe(sku);
    expect(result.briefHtml).toContain('5 additional');
    expect(result.briefHtml).toContain('&lt;script');
    expect(result.briefHtml).toContain("script-src 'none'");
    expect(result.briefHtml).not.toMatch(/<(script|img|iframe)\b|\b(?:https?|ftp|javascript):|\/\//i);
  });
});
