import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyManualCellEdits, repairCsv, type PlatformId, type RepairOptions } from '../../../src/core';
import { buildAmazonPriceDiff } from '../../../src/core/amazon-price-diff';
import { parseCsv } from '../../../src/core/csv';
import { createBookkeeperSignoffHtml } from '../../../src/core/repair/bookkeeper-signoff';
import { inspectImport } from '../../../src/core/verify-import/inspector';
import { repairAudit } from '../../../src/core/worker/repair-views';

const bytes = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array) => new TextDecoder().decode(data);
const fixture = (dir: string, filename: string) => ({ filename, bytes: readFileSync(new URL(`../../../fixtures/${dir}/${filename}`, import.meta.url)) });
const amazon = (filename: string) => fixture('amazon', filename);
const proposal = (text: string) => ({ filename: 'proposal.csv', bytes: bytes(text) });
const min = 'minimum-seller-allowed-price';
const max = 'maximum-seller-allowed-price';

describe('Amazon Price & Quantity native text pair', () => {
  it.each(['price-quantity.tsv', 'price-quantity.csv', 'price-quantity.txt'])('restores literal cells and preserves scope for %s', async filename => {
    const source = filename.endsWith('.txt') ? { ...amazon('price-quantity.tsv'), filename } : amazon(filename);
    const delimiter = filename.endsWith('.csv') ? ',' : '\t';
    const extension = filename.split('.').at(-1);
    const built = await buildAmazonPriceDiff(source, amazon('proposed.csv'));
    expect(built).toMatchObject({ status: 'ready', canDownload: true, delimiter, issues: [],
      fileNames: { update: 'amazon-update.' + extension, rollback: 'amazon-rollback.' + extension },
      rows: [{ baselineLine: 2, candidateLine: 2, sku: '00007' }, { baselineLine: 4, candidateLine: 3, sku: '00008' }],
      verification: { scope: 'paired-update', restored: true, residualDiffs: 0 } });
    const update = built.updateBytes!;
    const rollback = built.rollbackBytes!;
    const records = (data: Uint8Array) => parseCsv(decode(data), delimiter).records.map(record => record.cells);
    expect(records(update)).toEqual([['sku', 'price', 'quantity'], ['00007', '11.25', '0'], ['00008', '19.99', '']]);
    expect(records(rollback)).toEqual([['sku', 'price', 'quantity'], ['00007', '010.00', '007'], ['00008', '20.00', '']]);
    const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
    expect(JSON.parse(built.auditJson).custody).toMatchObject({ baselineSha256: sha(source.bytes),
      updateSha256: sha(update), rollbackSha256: sha(rollback) });
    expect(await inspectImport('amazon', source.bytes, update)).toMatchObject({ verdict: 'PASS', changedSkus: 2, nonTargetMutations: 0 });
    expect(await inspectImport('amazon', source.bytes, rollback, update)).toMatchObject({ verdict: 'PASS', nonTargetMutations: 0,
      rollback: { restored: true, residualDiffs: 0, pairedUpdateSha256: sha(update) } });
    const replayed = records(source.bytes);
    for (const file of [update, rollback]) {
      const [header, ...rows] = records(file);
      for (const [sku, ...fields] of rows) {
        const row = replayed.find(cells => cells[0] === sku)!;
        fields.forEach((field, index) => { if (field !== '') row[replayed[0].indexOf(header[index + 1])] = field; });
      }
    }
    expect(replayed).toEqual(records(source.bytes));
  });

  it('blocks corridor misses with both physical lines and accepts exact endpoints', async () => {
    const baseline = amazon('price-quantity.tsv');
    const report = await buildAmazonPriceDiff(baseline, amazon('outside-corridor.tsv'));
    expect(report).toMatchObject({ status: 'blocked', updateBytes: null, rollbackBytes: null, verification: null,
      issues: [expect.objectContaining({ code: 'amazon-price-outside-corridor', baselineLine: 2, candidateLine: 4,
        message: expect.stringContaining('11.26') })] });
    expect(report.issues[0].message).toContain('minimum 9.50, maximum 11.25');
    expect(JSON.parse(report.auditJson).custody).not.toHaveProperty('updateSha256');
    expect(await buildAmazonPriceDiff(baseline, proposal('sku,price\n00007,9.50'))).toMatchObject({ status: 'ready' });
    expect(await buildAmazonPriceDiff(baseline, proposal('sku,price\n00008,1.00'))).toMatchObject({ status: 'ready' });
    expect(await buildAmazonPriceDiff(baseline, proposal('sku,price,quantity\n00007,10,7'))).toMatchObject({ status: 'no-changes' });
  });

  it.each([
    ['10.00', 'bad', '12.00', '11.00', 'amazon-invalid-corridor'],
    ['10.00', '12.00', '11.00', '11.25', 'amazon-inverted-corridor'],
    ['8.00', '9.00', '11.00', '10.00', 'amazon-unrestorable-value'],
    ['', '', '', '10.00', 'amazon-unrestorable-value'],
    ['10.00', '', '', '0.00', 'amazon-invalid-value'],
    ['10.00', '', '', '10.001', 'amazon-invalid-value'],
  ])('holds unsafe price/corridor %s / %s / %s -> %s', async (original, minimum, maximum, next, code) => {
    const baseline = { filename: 'offer.csv', bytes: bytes(`sku,price,${min},${max}\n000,${original},${minimum},${maximum}`) };
    const result = await buildAmazonPriceDiff(baseline, proposal(`sku,price\n000,${next}`));
    expect(result).toMatchObject({ status: 'blocked', canDownload: false,
      issues: expect.arrayContaining([expect.objectContaining({ code, baselineLine: 2, candidateLine: 2 })]) });
  });

  it('holds scientific, duplicate, formula and unknown identities and unsupported quantities', async () => {
    const baseline = amazon('price-quantity.csv');
    for (const [body, code] of [
      ['sku,price\n00007,11\n00007,11', 'amazon-duplicate-sku'],
      ['sku,price\n7,11', 'amazon-unknown-sku'],
      ['sku,price\n1.0E+2,11', 'amazon-scientific-sku'],
      ['sku,price\n=7,11', 'amazon-invalid-sku'],
      ['sku,quantity\nFBA-9,0', 'amazon-fba-quantity'],
      ['sku,quantity\n00007,7.0', 'amazon-invalid-value'],
      ['sku,quantity\n00007,-1', 'amazon-invalid-value'],
      ['sku,price,handling-time\n00007,11,2', 'amazon-forbidden-column'],
    ]) {
      expect(await buildAmazonPriceDiff(baseline, proposal(body)), body).toMatchObject({ status: 'blocked',
        issues: expect.arrayContaining([expect.objectContaining({ code })]) });
    }
    const offers = { filename: 'offers.csv', bytes: bytes('sku,price\n7,10\n00007,10') };
    expect(await buildAmazonPriceDiff(offers, proposal('sku,price\n00007,11')), 'leading zero SKU remains distinct').toMatchObject({
      status: 'ready', rows: [{ sku: '00007', baselineLine: 3 }] });
  });

  it('rejects changed rollback text, missing scope, forbidden cells and wrong delimited candidates', async () => {
    const baseline = amazon('price-quantity.tsv');
    const ready = await buildAmazonPriceDiff(baseline, amazon('proposed.csv'));
    const original = decode(ready.rollbackBytes!);
    for (const [tampered, code] of [
      [original.replace('010.00', '10.00'), 'amazon-rollback-residual'],
      [original.replace('\t007', '\t'), 'amazon-rollback-scope'],
      ['sku\tprice\tquantity\thandling-time\n00007\t10\t007\t4', 'amazon-forbidden-column'],
      [original.replaceAll('\t', ','), 'amazon-delimiter-mismatch'],
    ]) {
      const report = await inspectImport('amazon', baseline.bytes, bytes(tampered), ready.updateBytes!);
      expect(report).toMatchObject({ verdict: 'FAIL_UNSAFE', rollback: { restored: false },
        issues: expect.arrayContaining([expect.objectContaining({ code })]) });
    }
  });
});

describe('M21 accounting source evidence', () => {
  it('holds one-cent and duplicate physical lines without deleting any source rows', () => {
    const source = fixture('accounting', 'tax-duplicate.csv');
    const report = repairCsv(source.bytes, source.filename, 'quickbooks-bank');
    expect(report).toMatchObject({ canDownload: false, repairedCsv: '', removedRows: [], rows: [{ row: 2 }, { row: 4 }, { row: 6 }],
      taxReconciliation: { status: 'FAIL_TAX_MISMATCH', checkedRows: 3, mismatchCount: 1, unverifiableCount: 0,
        mismatches: [{ row: 4, net: '100.00', tax: '10.00', gross: '110.01', expectedGross: '110.00', delta: '0.01' }] },
      duplicateTransactions: { affectedRows: 2, groupCount: 1, groups: [{ lines: [2, 4], currency: 'USD' }] } });
    expect(report.issues.filter(({ code }) => code === 'FAIL_DUPLICATE_TRANSACTION')).toMatchObject([
      { row: 2, relatedLines: [4], editable: false }, { row: 4, relatedLines: [2], editable: false },
    ]);
    expect(JSON.stringify(repairAudit(report, {}, { sourceSha256: 'source', repairedCsvSha256: 'removed' }))).toContain('"lines":[2,4]');
    const html = createBookkeeperSignoffHtml(report, { generatedAt: new Date('2026-11-28T00:00:00Z') });
    expect(html).toContain('Duplicate transaction alerts');
    expect(html).toContain('Vendor &lt;sample&gt;');
    expect(html).toContain('<td>2, 4</td>');
    expect(html).toContain('FAIL_TAX_MISMATCH');
    expect(html).toContain("script-src 'none'");
    expect(html).not.toContain('Vendor <sample>');
    const edited = applyManualCellEdits(source.bytes, source.filename, 'quickbooks-bank', {}, [
      { row: 4, column: 'Gross', value: '110.00' }, { row: 4, column: 'Description', value: 'Another transaction' },
    ]);
    expect(edited).toMatchObject({ canDownload: true, taxReconciliation: { status: 'VERIFIED', checkedRows: 3 } });
    expect(edited.duplicateTransactions).toBeUndefined();
  });

  it.each([
    ['xero-bank', 'Date,Amount,Payee,Description\n2026-05-01,9.00,Vendor,same\n2026/05/01,9.000,Vendor,same', {}],
    ['freshbooks-expenses', 'Date,Vendor,Category,Notes,Amount,Currency\n2026-05-01,Vendor,Meals,same,9,USD\n2026/05/01,Vendor,Meals,same,9.00,USD', {}],
    ['stripe-paypal', 'Created (UTC),Description,Gross,Fee,Net,Currency,id\n2026-05-01 08:00:00,Vendor,10,1,9,USD,a\n2026-05-01 09:00:00,Vendor,10.00,1.00,9.00,USD,b', {}],
    ['stripe-paypal', 'Date,Name,Gross,Fee,Net,Currency,Transaction ID,Balance Impact\n2026-05-01,Vendor,10,-1,9,USD,a,Credit\n2026/05/01,Vendor,10.00,-1.00,9.00,USD,b,Credit', {}],
    ['quickbooks-bank', 'Date,Payee,Debit,Credit\n2026-05-01,Vendor,9,\n2026/05/01,Vendor,9.00,', { qboCreditDebit: 'bank', qboLayout: '4col' }],
  ] as [PlatformId, string, RepairOptions][])('audits exact signed movement in %s', (platform, csv, options) => {
    const report = repairCsv(bytes(csv), 'pairs.csv', platform, options);
    expect(report).toMatchObject({ canDownload: false, removedRows: [], duplicateTransactions: {
      groupCount: 1, affectedRows: 2, groups: [{ lines: [2, 3], amount: platform === 'quickbooks-bank' ? '-9' : '9' }] } });
  });

  it('distinguishes exact source descriptions, opposite signs, currencies and removed Memo records', () => {
    const exact = 'Date,Description,Amount\n2026-05-01,"Vendor\nentry",9\n2026-05-01,Vendor entry,9\n2026-05-01,Vendor entry,-9';
    const normal = repairCsv(bytes(exact), 'book.csv', 'quickbooks-bank');
    expect(normal.canDownload).toBe(true);
    expect(normal.duplicateTransactions).toBeUndefined();
    const payment = 'Date,Name,Gross,Fee,Net,Currency,Transaction ID,Balance Impact\n' +
      '2026-05-01,Vendor,10,-1,9,USD,a,Credit\n2026-05-01,Vendor,10,-1,9,EUR,b,Credit\n2026-05-01,Vendor,10,-1,9,USD,c,Memo';
    const excluded = repairCsv(bytes(payment), 'activity.csv', 'stripe-paypal', { excludePayPalMemo: true });
    expect(excluded.canDownload).toBe(true);
    expect(excluded.removedRows).toMatchObject([{ row: 4, code: 'paypal-memo-removed' }]);
    expect(excluded.duplicateTransactions).toBeUndefined();
  });

  it('reports payment settlement tax coverage without treating Net as pre-tax subtotal', () => {
    const headers = 'Date,Name,Gross,Fee,Net,Currency,Transaction ID,Balance Impact,Sales Tax';
    const row = '2026-05-01,Vendor,110,-3.15,106.85,USD,abc,Credit,10';
    const actual = repairCsv(bytes(headers + '\n' + row), 'payment.csv', 'stripe-paypal');
    expect(actual).toMatchObject({ canDownload: true, taxReconciliation: { status: 'UNVERIFIABLE', checkedRows: 0, mismatchCount: 0 } });
    expect(actual.issues.some(({ code }) => code.startsWith('FAIL_TAX'))).toBe(false);
    expect(repairCsv(bytes(headers + ',Subtotal\n' + row + ',100'), 'tax.csv', 'stripe-paypal')).toMatchObject({
      canDownload: true, taxReconciliation: { status: 'VERIFIED', checkedRows: 1 } });
    const broken = repairCsv(bytes(headers + ',Subtotal\n' + row.replace('106.85', '106.84') + ',100.01'), 'tax.csv', 'stripe-paypal');
    expect(broken.issues.map(({ code }) => code)).toEqual(expect.arrayContaining(['FAIL_TAX_MISMATCH', 'reconciliation-mismatch']));
  });

  it.each([
    ['Net,Tax,Gross', '100.001,10,110', 2],
    ['Net,Tax,Gross', '"1,000",10,1010', 2],
    ['Net,Tax,Gross', '100,,110', 2],
    ['Net,Tax,VAT,Gross', '100,10,10,110', 1],
  ])('holds invalid or ambiguous tax evidence %s', (headers, cells, line) => {
    const value = 'Date,Description,Amount,' + headers + '\n2026-05-01,Merchant,110,' + cells;
    const report = repairCsv(bytes(value), 'book.csv', 'quickbooks-bank');
    expect(report.canDownload).toBe(false);
    expect(report.taxReconciliation?.status).toBe('UNVERIFIABLE');
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'FAIL_TAX_UNVERIFIABLE', row: line }));
  });
});
