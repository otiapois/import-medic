import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyManualCellEdits, repairCsv, repairCsvWithBytes } from '../../../src/core';
import type { PlatformId, RepairOptions } from '../../../src/core';
import { parseCsv, serializeCsv } from '../../../src/core/csv';
import { createBookkeeperSignoffHtml } from '../../../src/core/repair/bookkeeper-signoff';
import { suggestPlatforms } from '../../../src/core/worker/platform-suggestion';
import { repairAudit } from '../../../src/core/worker/repair-views';

const bytes = (text: string) => new TextEncoder().encode(text);
const read = (platform: string, file: string) => readFileSync(new URL(`../../../fixtures/${platform}/${file}`, import.meta.url));
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

describe('M15 accounting repair', () => {
  it('replays native Xero bytes with mandatory starred headers and audited physical source balances', () => {
    const source = read('xero-bank', 'balance-verified.csv');
    const { result, verifiedBytes } = repairCsvWithBytes(source, '<img onerror=alert(1)>.csv', 'xero-bank', { formulaGuard: false }, []);
    expect(result.canDownload).toBe(true);
    expect(result.roundtripCheck).toEqual({ checked: true, autoFixableRemaining: 0, needsManualReviewCount: 0 });
    expect(result.balanceChain).toEqual({
      status: 'VERIFIED', direction: 'ascending', currency: 'USD',
      openingBalance: '100.00', netMovement: '97.30', closingBalance: '197.30',
      verifiedLinks: 2, totalLinks: 2, breaks: [], reasons: [],
    });
    expect(result.formulaGuard).toMatchObject({ enabled: true, neutralized: [{ row: 4, column: 'Payee', before: '=SAFE_REVIEW()', after: "'=SAFE_REVIEW()" }] });
    const native = new TextDecoder().decode(verifiedBytes!);
    expect(parseCsv(native).records.map(({ cells }) => cells)).toEqual([
      ['*Date', '*Amount', 'Payee', 'Description', 'Reference', 'Check Number'],
      ['2026/05/01', '100.00', 'Opening payee', 'First deposit\nconfirmed on the statement', '00017', '00091'],
      ['2026/05/02', '-45.20', "'=SAFE_REVIEW()", 'Supplies', '00018', '00092'],
      ['2026/05/03', '42.50', 'Sample payer', 'Final deposit', '00019', '00093'],
    ]);
    const reopened = repairCsv(verifiedBytes!, 'export.csv', 'xero-bank');
    expect(reopened.repairedCsv).toBe(native);
    expect(reopened.balanceChain).toBeUndefined();
    expect(suggestPlatforms(result.sourceHeaders)).toEqual([{ platform: 'xero-bank', provider: 'Xero' }]);
    expect(suggestPlatforms(result.headers)).toEqual([{ platform: 'xero-bank', provider: 'Xero' }]);
    expect(result.changes).toContainEqual(expect.objectContaining({ row: 4, column: 'Balance', before: '154.80', code: 'column-removed' }));

    const custody = { sourceSha256: hash(source), repairedCsvSha256: hash(verifiedBytes!) };
    const audit = repairAudit(result, { formulaGuard: false }, custody);
    expect(JSON.parse(JSON.stringify(audit))).toMatchObject({ custody, balanceChain: result.balanceChain });
    const html = createBookkeeperSignoffHtml(result, { generatedAt: new Date('2026-11-27'), custody });
    for (const value of Object.values(custody)) expect(html).toContain(value);
    expect(html).toContain('VERIFIED (2/2 links)');
    for (const value of ['Opening Balance', 'Net Movement', 'Closing Balance', '100.00', '97.30', '197.30', 'USD']) expect(html).toContain(value);
    expect(html).toContain('&lt;img onerror=alert(1)&gt;.csv');
    expect(html).not.toContain('<img onerror');
    expect(html).toContain("default-src 'none'");
  });

  it('holds a missing movement on the later physical line, then re-runs against the original source and an explicit edit', () => {
    const source = read('xero-bank', 'balance-break.csv');
    const { result, verifiedBytes } = repairCsvWithBytes(source, 'break.csv', 'xero-bank', {}, []);
    expect(verifiedBytes).toBeNull();
    expect(result.repairedCsv).toBe('');
    expect(result.canDownload).toBe(false);
    expect(result.balanceChain).toMatchObject({
      status: 'FAIL_BALANCE_BREAK', direction: 'ascending', verifiedLinks: 0, totalLinks: 1,
      breaks: [{ row: 4, expected: '152.10', actual: '164.60', delta: '12.50' }],
    });
    expect(result.issues).toContainEqual(expect.objectContaining({ row: 4, column: 'Balance', code: 'balance-chain-break', editable: true }));
    const custody = { sourceSha256: hash(source) };
    const staleCustody = { ...custody, repairedCsvSha256: 'a'.repeat(64) };
    const audit = JSON.parse(JSON.stringify(repairAudit(result, {}, staleCustody)));
    expect(audit.custody).toEqual(custody);
    expect(audit.balanceChain).toEqual(result.balanceChain);
    const html = createBookkeeperSignoffHtml(result, { generatedAt: new Date('2026-11-27'), custody: staleCustody });
    for (const value of ['BALANCE BREAK at Line 4', '152.10', '164.60', '+12.50', custody.sourceSha256]) expect(html).toContain(value);
    expect(html).not.toContain('Repaired CSV SHA-256');
    expect(html).not.toContain(staleCustody.repairedCsvSha256);
    const edited = applyManualCellEdits(source, 'break.csv', 'xero-bank', {}, [{ row: 4, column: '*Amount', value: '-35.40' }]);
    expect(edited.balanceChain).toMatchObject({ status: 'VERIFIED', verifiedLinks: 1, breaks: [] });
    expect(edited.canDownload).toBe(true);
  });

  it('replays FreshBooks expense mapping, explicit currency, tax and normalized sign without claiming a mixed ledger', () => {
    const source = read('freshbooks-expenses', 'expenses-verified.csv');
    const result = repairCsv(source, 'expenses.csv', 'freshbooks-expenses');
    expect(result.roundtripCheck).toEqual({ checked: true, autoFixableRemaining: 0, needsManualReviewCount: 0 });
    expect(result.balanceChain).toBeUndefined();
    expect(result.formulaGuard.enabled).toBe(false);
    expect(suggestPlatforms(result.sourceHeaders)).toEqual([{ platform: 'freshbooks-expenses', provider: 'FreshBooks' }]);
    const native = parseCsv(result.repairedCsv).records.map(({ cells }) => cells);
    expect(native).toEqual([
      ['Date', 'Vendor', 'Category', 'Notes', 'Amount', 'Tax 1 Name', 'Tax 1 Amount', 'Currency'],
      ['2026-05-01', 'Example Office', 'Office Expenses', 'Supplies, labels and paper', '-45.20', 'Sales Tax', '2.20', 'USD'],
      ['2026-05-03', 'Example Cafe', 'Meals', 'Crew meeting', '-15.60', 'Sales Tax', '1.60', 'USD'],
    ]);
    expect(repairCsv(bytes(result.repairedCsv), 'export.csv', 'freshbooks-expenses').repairedCsv).toBe(result.repairedCsv);
    expect(repairAudit(result, {}).freshBooksTaxes).toEqual([
      { row: 2, name: 'Sales Tax', amount: '$2.20' }, { row: 3, name: 'Sales Tax', amount: '1.60' },
    ]);
    const xssTax = applyManualCellEdits(source, 'expenses.csv', 'freshbooks-expenses', {}, [{ row: 2, column: 'Tax 1 Name', value: '<script>alert(1)</script>' }]);
    const taxReport = createBookkeeperSignoffHtml(xssTax, { generatedAt: new Date('2026-11-27') });
    expect(taxReport).toContain('FreshBooks tax review');
    expect(taxReport).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(taxReport).not.toContain('<script>');
    const mixed = repairCsv(read('freshbooks-expenses', 'mixed-currencies.csv'), 'mixed.csv', 'freshbooks-expenses');
    expect(mixed.canDownload).toBe(false);
    expect(mixed.currencySplit).toEqual([{ currency: 'USD', lines: [2] }, { currency: 'EUR', lines: [3] }]);
    const signs = native.map((line) => line.slice());
    signs[2][4] = '15.60';
    const mixedSigns = repairCsv(bytes(serializeCsv(signs[0], signs.slice(1), 'freshbooks-expenses')), 'signs.csv', 'freshbooks-expenses');
    expect(mixedSigns.canDownload).toBe(false);
    expect(mixedSigns.issues).toContainEqual(expect.objectContaining({ row: 3, code: 'freshbooks-mixed-sign' }));
  });

  it.each(['3col', '4col'] as const)('checks descending QuickBooks %s after converting bank source signs and keeps tie order', (qboLayout) => {
    const source = bytes('Date,Description,Debit,Credit,Running Balance\n2026-05-02,Last,9.85,,100.15\n2026-05-02,Prior,,20.00,110.00\n2026-05-01,First,10.00,,90.00');
    const options: RepairOptions = { qboLayout, qboCreditDebit: 'bank' };
    const result = repairCsv(source, 'descending.csv', 'quickbooks-bank', options);
    expect(result.canDownload).toBe(true);
    expect(result.balanceChain).toMatchObject({
      status: 'VERIFIED', direction: 'descending', currency: null,
      openingBalance: '100.00', netMovement: '0.15', closingBalance: '100.15', verifiedLinks: 2, totalLinks: 2,
    });
    expect(result.headers).toEqual(qboLayout === '4col' ? ['Date', 'Description', 'Credit', 'Debit'] : ['Date', 'Description', 'Amount']);
    const wrong = repairCsv(source, 'descending.csv', 'quickbooks-bank', { ...options, qboCreditDebit: 'intuit' });
    expect(wrong.canDownload).toBe(false);
    expect(wrong.balanceChain?.breaks).toEqual([
      { row: 2, expected: '119.85', actual: '100.15', delta: '-19.70' },
      { row: 3, expected: '70.00', actual: '110.00', delta: '40.00' },
    ]);
  });

  it.each(['xero-bank', 'quickbooks-bank'] as const)('fails closed on order ambiguity, nonadjacent invalid rows and excess precision in %s', (platform) => {
    const play = (rows: string[][], options?: RepairOptions) => repairCsv(
      bytes(serializeCsv(['Date', 'Description', 'Amount', 'Balance'], rows, platform)), 'statement.csv', platform, options);
    const sameDay = play([['2026-05-01', 'One', '1.00', '1.00'], ['2026-05-01', 'Two', '2.00', '3.00']]);
    expect(sameDay.balanceChain).toMatchObject({ status: 'UNVERIFIABLE', direction: null, totalLinks: 1, verifiedLinks: 0 });
    expect(sameDay.canDownload).toBe(false);
    const reordered = play([['2026-05-01', 'One', '1.00', '1.00'], ['2026-05-03', 'Two', '2.00', '3.00'], ['2026-05-02', 'Three', '3.00', '6.00']]);
    expect(reordered.balanceChain?.reasons).toContainEqual(expect.objectContaining({ row: 4, column: expect.stringMatching(/Date/) }));
    expect(reordered.canDownload).toBe(false);
    const invalid = play([['2026-05-01', 'One', '1.00', '1.00'], ['', '', '', ''], ['2026-05-03', 'Three', '3.00', '4.00'], ['2026-05-04', 'Four', '2.00', '6.00']]);
    expect(invalid.balanceChain).toMatchObject({ status: 'UNVERIFIABLE', direction: 'ascending', totalLinks: 3, verifiedLinks: 1 });
    const excessive = play([['2026-05-01', 'One', '1.00', '1.00'], ['2026-05-02', 'Two', '0.001', '1.001']]);
    expect(excessive.balanceChain).toMatchObject({ status: 'UNVERIFIABLE', direction: 'ascending', totalLinks: 1, verifiedLinks: 0 });
    expect(excessive.canDownload).toBe(false);
    const precise = play([['2026-05-01', 'One', '9007199254740993.04', '9007199254740993.04'], ['2026-05-02', 'Two', '-0.010', '9007199254740993.03']]);
    expect(precise.balanceChain).toMatchObject({ status: 'VERIFIED', netMovement: '9007199254740993.03', closingBalance: '9007199254740993.03' });
    expect(precise.canDownload).toBe(true);
  });

  it.each(['xero-bank', 'quickbooks-bank'] as const)('uses explicit minor-unit precision and rejects incompatible balance symbols in %s', (platform) => {
    const input = (headers: string[], rows: string[][]) => repairCsv(bytes(serializeCsv(headers, rows, platform)), 'statement.csv', platform);
    const header = ['Date', 'Description', 'Amount', 'Balance'];
    const dated = (currency: string, first: string, next: string, balance: string) => input([...header, 'Currency'], [
      ['2026-04-01', 'First', first, first, currency], ['2026-04-02', 'Second', next, balance, currency],
    ]);
    expect(dated('JPY', '100', '-12', '88').balanceChain).toMatchObject({ status: 'VERIFIED', currency: 'JPY', openingBalance: '0', netMovement: '88', closingBalance: '88' });
    expect(dated('KWD', '100.002', '-0.003', '99.999').balanceChain).toMatchObject({ status: 'VERIFIED', currency: 'KWD', openingBalance: '0.000', netMovement: '99.999', closingBalance: '99.999' });
    expect(dated('USD', '9007199254740993.04', '-0.01', '9007199254740993.02').balanceChain?.breaks).toEqual([
      { row: 3, expected: '9007199254740993.03', actual: '9007199254740993.02', delta: '-0.01' },
    ]);
    expect(dated('ZZZ', '100.00', '-0.01', '99.99').balanceChain).toMatchObject({ status: 'UNVERIFIABLE', currency: null, verifiedLinks: 0 });
    const conflict = input(header, [['2026-04-01', 'First', '$1,000.00', '$1,000.00'], ['2026-04-02', 'Second', '(£5.00)', '$995.00']]);
    expect(conflict.balanceChain).toMatchObject({ status: 'UNVERIFIABLE', currency: null, verifiedLinks: 0 });
    expect(conflict.issues).toContainEqual(expect.objectContaining({ code: 'multi-currency', row: 3 }));
    expect(conflict.canDownload).toBe(false);
    const single = input(header, [['2026-04-01', 'Only', '($5.00)', '$995.00']]);
    expect(single.balanceChain).toMatchObject({ status: 'VERIFIED', direction: null, currency: null, openingBalance: '1000.00', netMovement: '-5.00', closingBalance: '995.00', verifiedLinks: 0, totalLinks: 0 });
    expect(single.canDownload).toBe(true);
  });

  it.each<[PlatformId, string]>([
    ['xero-bank', 'Date,Amount\n04/05/2026,-1.00\n06/21/2026,-3.00'],
    ['freshbooks-expenses', 'Date,Merchant,Category,Description,Amount,Currency\n04/05/2026,Sample,Meals,Receipt,-1.00,USD\n06/21/2026,Sample,Meals,Receipt,-3.00,USD'],
  ])('requires choosing the date order explicitly for ambiguous input in %s', (platform, csv) => {
    const result = repairCsv(bytes(csv), 'ambiguous.csv', platform);
    expect(result.canDownload).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ row: 2, code: 'date-order-ambiguous' }));
    expect(repairCsv(bytes(csv), 'ambiguous.csv', platform, { dateOrder: 'MDY' }).canDownload).toBe(true);
    expect(repairCsv(bytes(csv), 'ambiguous.csv', platform, { dateOrder: 'DMY' }).canDownload).toBe(false);
  });
});
