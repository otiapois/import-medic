import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { categorizeTransactions, serializeRulePack, splitInclusiveTax, validateRulePack, type BookkeeperRule,
  type CategorizationInput } from '../../../src/core/accounting/categorization-rules';
import { parseCsv, serializeCsv } from '../../../src/core/csv';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (input: Uint8Array) => new TextDecoder().decode(input);
const fixture = (name: string) => ({ filename: name, bytes: readFileSync(new URL(`../../../fixtures/m23/${name}`, import.meta.url)) });
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const baseRule: BookkeeperRule = { id: 'rule', label: 'Cloud vendor', matchType: 'contains', pattern: 'cloud',
  direction: 'any', accountCode: '00600', accountName: 'Services', taxCode: 'VAT', inclusiveTaxRateBps: 2000 };
const pack = (rules: BookkeeperRule[] = [baseRule], options: Record<string, unknown> = {}) =>
  ({ filename: 'rules.json', bytes: bytes(JSON.stringify({ schemaVersion: 1, rules, ...options })) });
const run = (input: string, rulePack = pack(), options: Partial<CategorizationInput> = {}) =>
  categorizeTransactions({ csv: { filename: 'transactions.csv', bytes: bytes(input) }, rulePack, ...options });

describe('Bookkeeper categorization', () => {
  it('reparses all demo rows in source order and conserves gross, net and tax per currency', async () => {
    const csv = fixture('transactions.csv');
    const rulePack = fixture('rules.json');
    const result = await categorizeTransactions({ csv, rulePack });
    expect(result.status).toBe('ready');
    expect(result.metrics).toEqual({ totalRows: 5, categorizedRows: 4, uncategorizedRows: 1, ambiguousConflicts: 0 });
    expect(result.issues).toEqual([]);
    const { categorizedCsv, accountSummaryCsv, signoffHtml, auditJson } = result.artifacts;
    const exported = parseCsv(text(categorizedCsv!)).records;
    const source = parseCsv(text(csv.bytes)).records;
    expect(exported.map(({ cells }) => cells.slice(0, 5))).toEqual(source.map(({ cells }) => cells));
    expect(exported.map(({ cells }) => cells.slice(5))).toEqual([
      ['Account Code', 'Account Name', 'Tax Code', 'Calculated Net', 'Calculated Tax', 'Matched Rule'],
      ['6100', 'Cloud services', 'UK-VAT20', '-100.00', '-20.00', 'aws-uk'],
      ['6100', 'Cloud services', 'UAE-VAT5', '-100.00', '-5.00', 'aws-uae'],
      ['6100', 'Cloud services', 'UK-VAT20', '10.00', '2.00', 'aws-uk'],
      ['6200', 'Software subscriptions', 'NO-TAX', '-24.00', '0.00', 'shopify'],
      ['', '', '', '-4.50', '0.00', ''],
    ]);
    expect(parseCsv(text(accountSummaryCsv!)).records.map(({ cells }) => cells)).toContainEqual(['GBP', '', '', '', '1', '-4.50', '-4.50', '0.00']);
    for (const { currency, grossCents, netCents, taxCents, rowCount } of result.currencyTotals) {
      const groups = result.accountSummary.filter(row => row.currency === currency);
      expect(groups.reduce((sum, row) => sum + BigInt(row.grossCents), 0n)).toBe(BigInt(grossCents));
      expect(BigInt(netCents) + BigInt(taxCents)).toBe(BigInt(grossCents));
      expect(groups.reduce((sum, row) => sum + row.rowCount, 0)).toBe(rowCount);
    }
    expect(result.currencyTotals.map(({ currency, taxCents }) => [currency, taxCents])).toEqual([['GBP', '-1800'], ['AED', '-500'], ['USD', '0']]);
    const { custody } = JSON.parse(auditJson);
    expect(custody.source.sha256).toBe(sha256(csv.bytes));
    expect(custody.rulePack.sha256).toBe(sha256(rulePack.bytes));
    expect(custody.outputs.map(({ sha256: hash }: { sha256: string }) => hash)).toEqual([sha256(categorizedCsv!), sha256(accountSummaryCsv!), sha256(signoffHtml!)]);
    for (const hash of [custody.source.sha256, custody.rulePack.sha256, sha256(categorizedCsv!), sha256(accountSummaryCsv!)]) expect(signoffHtml).toContain(hash);
  });

  it('rounds exact half cents to even symmetrically and preserves huge signed cents', () => {
    expect(splitInclusiveTax(21n, 2000)).toEqual({ netCents: 18n, taxCents: 3n });
    expect(splitInclusiveTax(27n, 2000)).toEqual({ netCents: 22n, taxCents: 5n });
    expect(splitInclusiveTax(-21n, 2000)).toEqual({ netCents: -18n, taxCents: -3n });
    expect(splitInclusiveTax(-27n, 2000)).toEqual({ netCents: -22n, taxCents: -5n });
    expect(splitInclusiveTax(-1n, 500)).toEqual({ netCents: -1n, taxCents: 0n });
    expect(splitInclusiveTax(0n, 2000)).toEqual({ netCents: 0n, taxCents: 0n });
    const huge = -123456789012345678901234567890n;
    const { netCents, taxCents } = splitInclusiveTax(huge, 2500);
    expect(netCents + taxCents).toBe(huge);
    expect(netCents).toBe(-98765431209876543120987654312n);
  });

  it('holds literal conflicts and high-value unmapped rows with their original physical rows', async () => {
    const csv = 'Description,Payee,Amount,Currency\r\n"Other\r\nline",,1.00,USD\r\nCloud,Company,-1.00,USD\r\nUnmapped,,1.01,USD';
    const overlap: BookkeeperRule = { ...baseRule, id: 'overlap', taxCode: 'OTHER' };
    const result = await run(csv, pack([baseRule, overlap], { unmappedReviewThresholdCents: 100 }));
    expect(result.status).toBe('blocked');
    expect(result.issues).toMatchObject([
      { code: 'ambiguous-rule-match', line: 4, raw: 'Cloud,Company,-1.00,USD', matchingRuleIds: ['rule', 'overlap'] },
      { code: 'unmapped-high-value', line: 5, raw: 'Unmapped,,1.01,USD' },
    ]);
    expect(result.artifacts).toMatchObject({ categorizedCsv: null, accountSummaryCsv: null, signoffHtml: null });
    expect(JSON.parse(result.artifacts.auditJson).custody).not.toHaveProperty('outputs');
    const explicit = await run(csv, pack([overlap, baseRule], { conflictPolicy: 'first-match-wins' }));
    expect(explicit).toMatchObject({ status: 'ready', rows: [{}, { matchingRuleIds: ['overlap', 'rule'], matchedRuleId: 'overlap' }, {}] });
    const sameCodes = await run(csv, pack([baseRule, { ...overlap, taxCode: baseRule.taxCode, inclusiveTaxRateBps: 500 }]));
    expect(sameCodes).toMatchObject({ status: 'ready', rows: [{}, { matchingRuleIds: ['rule', 'overlap'], matchedRuleId: 'rule', taxCents: '-17' }, {}] });
  });

  it('matches canonical case-insensitive Unicode literals against complete separate cells and checks absolute inclusive bounds', async () => {
    const rule: BookkeeperRule = { ...baseRule, pattern: ' CAFÉ [*.]+ ', matchType: 'contains', direction: 'debit', minAmountCents: 100, maxAmountCents: 101 };
    const csv = serializeCsv(['Description', 'Payee', 'Amount'], [
      ['', '  cafe\u0301 [*.]+ shop  ', '-1.00'], ['CAFE\u0301 [*.]+', '', '-1.01'], ['CAFÉ [*.]+', '', '-1.02'],
      ['CAFÉ [*.]+', '', '1.00'], ['CAFÉ', '[*.]+', '-1.00'], ['CAFÉ XX', '', '-1.00'],
    ], 'categorize');
    const result = await run(csv, pack([rule]));
    expect(result.status).toBe('ready');
    expect(result.rows.map(row => [row.matchedRuleId, row.currency])).toEqual([
      ['rule', null], ['rule', null], [null, null], [null, null], [null, null], [null, null],
    ]);
  });

  it('holds incompatible columns, unknown currency evidence, and unsafe split directions', async () => {
    for (const [input, expected] of [
      ['Description,Amount,Gross\nCloud,1.00,2.00', 'ambiguous-amount-columns'],
      ['Description,Net\nCloud,1.00', 'missing-amount-columns'],
      ['Description,Amount,Currency\nCloud,1.005,USD', 'invalid-amount'],
      ['Description,Amount,Currency\nCloud,1.00,JPY', 'invalid-currency'],
      ['Description,Amount,Currency\nCloud,1.00,', 'invalid-currency'],
      ['Description,Amount,Currency\nCloud,$1.00,EUR', 'invalid-amount'],
      ['Description,Amount\nCloud,$1.00', 'missing-symbol-currency'],
      ['Description,Debit,Credit\nCloud,12.00,', 'credit-debit-convention-required'],
      ['Description,Amount,Account Code\nCloud,1.00,A', 'existing-categorization-column'],
      ['Description,Amount\nCloud,1.00,excess', 'row-width'],
    ]) expect(await run(input)).toMatchObject({ status: 'blocked', issues: [{ code: expected }] });
    const split = 'Description,Debit,Credit\nCloud,12.00,0\nCloud,,12.00';
    expect((await run(split, pack(), { creditDebitConvention: 'bank' })).rows.map(row => row.grossCents)).toEqual(['-1200', '1200']);
    expect((await run(split, pack(), { creditDebitConvention: 'intuit' })).rows.map(row => row.grossCents)).toEqual(['1200', '-1200']);
    expect(await run('Description,Debit,Credit\nCloud,12.00,1.00', pack(), { creditDebitConvention: 'bank' }))
      .toMatchObject({ status: 'blocked', issues: [{ code: 'invalid-split-amount', line: 2, raw: 'Cloud,12.00,1.00' }] });
    expect((await run('Description,Withdrawal,Deposit\nCloud,12.00,0\nCloud,,12.00')).rows.map(row => row.grossCents)).toEqual(['-1200', '1200']);
    expect(await run('Description,Amount,Withdrawal,Deposit\nCloud,12.00,12.00,1.00'))
      .toMatchObject({ status: 'blocked', issues: [{ code: 'ambiguous-amount-columns' }] });
    expect(await run('Payee,*Amount\nCloud,$1.00', pack(), { sourceCurrency: 'usd' })).toMatchObject({ status: 'ready', rows: [{ currency: 'USD', grossCents: '100' }] });
  });

  it('guards both CSVs and escapes the branded offline report without altering signed money', async () => {
    const hostile = { ...baseRule, id: '@key', accountCode: '=Code', accountName: '<script src="https://evil.invalid">', taxCode: '+Tax' };
    const input = serializeCsv(['Description', 'Amount', '@Other'], [['cloud', '-1.20', '=CMD("arg")']], 'categorize');
    const result = await run(input, pack([hostile]), { branding: { agencyName: '<b>Test</b> //agency.invalid', preparedFor: 'Client', contactNote: 'file://contact.invalid', accentKey: 'forest' } });
    const { categorizedCsv, accountSummaryCsv, signoffHtml, auditJson } = result.artifacts;
    expect(result.status).toBe('ready');
    expect(parseCsv(text(categorizedCsv!)).records.map(({ cells }) => cells)).toEqual([
      ['Description', 'Amount', "'@Other", 'Account Code', 'Account Name', 'Tax Code', 'Calculated Net', 'Calculated Tax', 'Matched Rule'],
      ['cloud', '-1.20', "'=CMD(\"arg\")", "'=Code", hostile.accountName, "'+Tax", '-1.00', '-0.20', "'@key"],
    ]);
    expect(parseCsv(text(accountSummaryCsv!)).records[1].cells).toEqual(['', "'=Code", hostile.accountName, "'+Tax", '1', '-1.20', '-1.00', '-0.20']);
    expect(JSON.parse(auditJson).formulaGuard.categorizedCsv).toContainEqual({ row: 2, column: '@Other', before: '=CMD("arg")', after: "'=CMD(\"arg\")" });
    expect(signoffHtml).toContain("default-src 'none'; script-src 'none'; connect-src 'none'");
    expect(signoffHtml).toContain('&lt;b&gt;Test&lt;/b&gt;');
    expect(signoffHtml).toContain('&lt;script src=');
    expect(signoffHtml).not.toMatch(/<script|\b(?:https?|file):|\/\//i);
  });

  it('holds output when guarding distinct codes would merge two account groups', async () => {
    const rulePack = pack([{ ...baseRule, accountCode: '@Key' },
      { ...baseRule, id: 'second', pattern: 'other', accountCode: "'@Key" }]);
    const result = await run('Description,Amount\nCloud,-1.20\nOther,-2.40', rulePack);
    expect(result).toMatchObject({ status: 'blocked', issues: [{ code: 'guarded-account-collision', line: 3, raw: 'Other,-2.40' }],
      artifacts: { categorizedCsv: null, accountSummaryCsv: null, signoffHtml: null } });
    expect(result.custody).not.toHaveProperty('outputs');
  });

  it('audits blank lines and malformed quoting at the original physical record boundaries', async () => {
    const input = '\r\nDescription,Amount\r\n"Cloud\rone\nmore",-1.00\r\n\r\n"Cloud\nno closing quote,-2.00';
    const result = await run(input);
    expect(result).toMatchObject({ status: 'blocked', issues: [{ code: 'malformed-csv', line: 7, raw: '"Cloud\nno closing quote,-2.00' }],
      rows: [{ line: 3, raw: '"Cloud\rone\nmore",-1.00' }, { line: 7, status: 'not-evaluated' }] });
    expect(JSON.parse(result.artifacts.auditJson)).toMatchObject({ blankLines: [1, 6], sourceHeader: { line: 2, raw: 'Description,Amount' } });
  });

  it('rejects unknown keys, wrong versions, duplicate fields and IDs, inverted intervals and malformed UTF-8', () => {
    const valid = validateRulePack(pack().bytes);
    expect(valid).toMatchObject({ ok: true, value: { schemaVersion: 1, rules: [baseRule] } });
    if (valid.ok) expect(validateRulePack(bytes(serializeRulePack(valid.value)))).toEqual(valid);
    const invalid = [pack([], { schemaVersion: 2 }).bytes, pack([], { extras: true }).bytes, pack([{ ...baseRule, extra: 1 } as BookkeeperRule]).bytes,
      pack([baseRule, baseRule]).bytes, pack([{ ...baseRule, minAmountCents: 10, maxAmountCents: 9 }]).bytes,
      pack([{ ...baseRule, inclusiveTaxRateBps: 0.1 }]).bytes, pack([{ ...baseRule, pattern: ' ' }]).bytes,
      bytes('{"schemaVersion":1,"schemaVersio\\u006e":1,"rules":[]}'), bytes('{invalid'), new Uint8Array([0xff]),
    ];
    for (const input of invalid) expect(validateRulePack(input)).toMatchObject({ ok: false, issues: [{ code: 'invalid-rule-pack' }] });
  });
});
