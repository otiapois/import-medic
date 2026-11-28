import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../../src/core/csv';
import { reconcilePayouts, type ReconciliationInput } from '../../../src/core/reconciliation/payout-matcher';

const read = (name: string) => ({ filename: name, bytes: readFileSync(new URL(`../../../fixtures/m26/${name}`, import.meta.url)) });
const source = (filename: string, csv: string) => ({ filename, bytes: new TextEncoder().encode(csv) });
const decode = (file: { bytes: Uint8Array }) => new TextDecoder().decode(file.bytes);
const digest = (file: { bytes: Uint8Array }) => createHash('sha256').update(file.bytes).digest('hex');
const payoutHeader = 'Payout ID,Payout Date,Net Payout Amount,Gross,Fees,Currency';
const bankHeader = 'Bank Date,Description,Amount,Currency,Reference';
const csv = (payouts: string, bank: string, options?: Partial<ReconciliationInput>) =>
  reconcilePayouts({ payouts: source('payouts.csv', payouts), bank: source('bank.csv', bank), ...options });
const fixture = (bank: string) => reconcilePayouts({ payouts: read('shopify-payouts.csv'), bank: read(bank) });
const examples = [
  ['bank-matched.csv', 'READY', 3, []],
  ['bank-missing.csv', 'HOLD', 2, ['UNMATCHED_PAYOUT']],
  ['bank-ambiguous.csv', 'HOLD', 2, ['AMBIGUOUS_TIE']],
  ['bank-fee.csv', 'HOLD', 2, ['UNMATCHED_PAYOUT', 'UNMATCHED_BANK_DEPOSIT', 'UNMATCHED_NEAR_AMOUNT']],
] as const;

describe('M26 payout-to-bank reconciliation', () => {
  it.each(examples)('replays actual bytes from %s', async (bank, status, count, codes) => {
    const result = await fixture(bank);
    expect(result.status).toBe(status);
    expect(result.summary.matchedPairs).toBe(count);
    expect(result.exceptions.map(({ code }) => code)).toEqual(codes);
    expect(result.summary.byCurrency.map(({ currency, totalPayoutCents }) => [currency, totalPayoutCents]))
      .toEqual([['USD', '20755'], ['EUR', '21000']]);
    expect(parseCsv(decode(result.artifacts.pairsCsv)).records).toHaveLength(count + 1);
    expect(parseCsv(decode(result.artifacts.exceptionsCsv)).records).toHaveLength(codes.length + 1);
    const audit = JSON.parse(decode(result.artifacts.auditJson));
    const { pairsCsv, exceptionsCsv, signoffHtml } = result.artifacts;
    expect(audit.custody.inputs).toMatchObject({
      payouts: { sha256: digest(read('shopify-payouts.csv')) }, bank: { sha256: digest(read(bank)) },
    });
    expect(audit.custody.outputs).toMatchObject({
      pairsCsv: { sha256: digest(pairsCsv) }, exceptionsCsv: { sha256: digest(exceptionsCsv) },
      signoffHtml: { sha256: digest(signoffHtml) },
    });
    expect(decode(signoffHtml)).toContain("connect-src 'none'");
    expect(decode(signoffHtml)).toContain(digest(exceptionsCsv));
    if (bank === 'bank-fee.csv') expect(result.exceptions[2]).toMatchObject({ payoutLines: [2], bankLines: [2], deltaCents: '-1' });
    if (bank === 'bank-ambiguous.csv') expect(result.exceptions[0]).toMatchObject({ payoutLines: [2], bankLines: [2, 5] });
  });

  it('keeps physical lines, mixed line endings and raw values across CSV, audit and offline sign-off', async () => {
    const payouts = payoutHeader + '\r\n"=P(1)\r\nnext",2026-11-08,12.50,13.00,-0.50,USD\n00003,2026-11-08,15.00,,,USD';
    const bank = bankHeader + '\r2026-11-08,"=D(1)\rsecond with ""quote""",12.50,USD,"<img src=x>"\r\n2026-11-09,Transfer,15.00,USD,0009';
    const result = await csv(payouts, bank, {
      branding: { agencyName: '<North & Co>', preparedFor: '', contactNote: '', accentKey: 'navy' },
    });
    expect(result.status).toBe('READY');
    expect(result.pairs.map(({ payoutId, payoutLine, bankLine }) => [payoutId, payoutLine, bankLine]))
      .toEqual([['=P(1)\r\nnext', 2, 2], ['00003', 4, 4]]);
    expect(result.pairs[0]).toMatchObject({ bankDescription: '=D(1)\rsecond with "quote"', bankReference: '<img src=x>' });
    const records = parseCsv(decode(result.artifacts.pairsCsv)).records;
    expect(records[1].cells).toContain("'=P(1)\r\nnext");
    expect(records[1].cells).toContain('\'=D(1)\rsecond with "quote"');
    expect(records[2].cells).toContain('00003');
    const audit = JSON.parse(decode(result.artifacts.auditJson));
    expect(audit.sources.payouts.records[0].cells).toEqual(['=P(1)\r\nnext', '2026-11-08', '12.50', '13.00', '-0.50', 'USD']);
    const html = decode(result.artifacts.signoffHtml);
    expect(html).toContain('&lt;North &amp; Co&gt;');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<img');
  });

  it('holds all exact edges in a connected contender chain and retains independent pairs', async () => {
    const result = await csv(
      payoutHeader + '\nA,2026-11-01,12.00,,,USD\nB,2026-11-04,12.00,,,USD\nC,2026-11-07,12.00,,,USD\nD,2026-11-02,12.00,,,EUR',
      bankHeader + '\n2026-11-02,Bank,12.00,USD,A\n2026-11-05,Bank,12.00,USD,B\n2026-11-08,Bank,12.00,USD,C\n2026-11-03,Bank,12.00,EUR,D',
    );
    expect(result.pairs.map(({ payoutId }) => payoutId)).toEqual(['D']);
    expect(result.exceptions).toEqual([expect.objectContaining({
      code: 'AMBIGUOUS_TIE', payoutLines: [2, 3, 4], bankLines: [2, 3, 4],
      candidateSets: [
        { payoutLines: [2], bankLines: [2, 3] },
        { payoutLines: [3], bankLines: [3, 4] },
        { payoutLines: [4], bankLines: [4] },
      ],
    })]);
  });

  it('holds malformed or missing currency, duplicates and the exact one-cent payout accounting contradiction', async () => {
    const result = await csv(
      payoutHeader + '\n0001,2026-11-01,98.99,100.00,1.00,USD\n0001,2026-11-03,50.00,,,USD\nB,2026-11-01,1.234,,,USD\nC,03/04/2026,3.00,,,\nD,2026-11-01,4.00,,,USD',
      bankHeader + '\n2026-11-03,Transfer,50.00,USD,0001\n2026-11-03,Outgoing,-98.99,USD,\n2026-11-03,Transfer,4.00,USD,D',
      { payoutCurrency: 'USD' },
    );
    expect(result.status).toBe('HOLD');
    expect(result.pairs).toEqual([]);
    expect(result.exceptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PAYOUT_TOTAL_MISMATCH', payoutLines: [2], deltaCents: '-1', expectedCents: '9900', actualCents: '9899' }),
      expect.objectContaining({ code: 'DUPLICATE_PAYOUT_ID', payoutLines: [2, 3] }),
      expect.objectContaining({ code: 'INVALID_ROW', payoutLines: [4] }),
      expect.objectContaining({ code: 'INVALID_ROW', payoutLines: [5] }),
    ]));
    expect(result.summary.byCurrency).toEqual([expect.objectContaining({
      currency: 'USD', totalPayoutCents: '15299', unmatchedPayoutCents: '15299',
      totalBankInflowCents: '5400', unmatchedBankCents: '5400',
    })]);
    const audit = JSON.parse(decode(result.artifacts.auditJson));
    expect(audit.sources.bank.records[1]).toMatchObject({ line: 3, disposition: 'excluded-non-inflow', amountCents: '-9899' });
    expect(parseCsv(decode(result.artifacts.pairsCsv)).records).toHaveLength(1);
  });

  it('requires independent defaults for missing Currency headers and leaves an explicit blank currency unresolved', async () => {
    const payouts = 'Payout ID,Payout Date,Net Payout Amount\n00001,2026-11-01,1.00';
    const bank = 'Bank Date,Description,Amount\n2026-11-01,Bank,1.00';
    expect((await csv(payouts, bank, { payoutCurrency: 'USD' })).exceptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_SOURCE', bankLines: [1] }),
    ]));
    expect((await csv(payouts, bank, { payoutCurrency: 'USD', bankCurrency: 'EUR' })).pairs).toHaveLength(0);
    expect((await csv(payouts, bank, { payoutCurrency: 'USD', bankCurrency: ' usd ' })).pairs).toHaveLength(1);
    expect((await csv(payouts, bankHeader + '\n2026-11-01,Bank,1.00,,ref',
      { payoutCurrency: 'USD', bankCurrency: 'USD' })).exceptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_ROW', bankLines: [2], column: 'Currency' }),
    ]));
  });

  it('rejects malformed headers, quoting, row width, encoding and unsupported currency without inventing cents', async () => {
    for (const malformed of [
      source('bank.csv', bankHeader + ',*Amount\n2026-11-02,Bank,1.00,USD,,1.00'),
      source('bank.csv', bankHeader + '\n2026-11-02,"unterminated,1.00,USD,'),
      source('bank.csv', bankHeader + '\n2026-11-02,Bank,1.00,USD'),
      source('bank.csv', bankHeader + '\n2026-11-02,Bank,1.00,JPY,'),
      { filename: 'bank.csv', bytes: Uint8Array.of(0xff, 0xfe, 0, 0) },
    ]) {
      const result = await reconcilePayouts({ payouts: read('shopify-payouts.csv'), bank: malformed });
      expect(result.status).toBe('HOLD');
      expect(result.pairs).toHaveLength(0);
      expect(result.exceptions.some(({ code }) => code === 'INVALID_SOURCE' || code === 'INVALID_ROW')).toBe(true);
      expect(result.summary.byCurrency.every(({ totalBankInflowCents }) => totalBankInflowCents === '0')).toBe(true);
    }
  });

  it('treats a header-only bank file or one containing only outflows as zero inflow', async () => {
    for (const statement of [bankHeader, bankHeader + '\n2026-11-02,Outflow,-125.40,USD,not-a-deposit']) {
      const result = await reconcilePayouts({ payouts: read('shopify-payouts.csv'), bank: source('bank.csv', statement) });
      expect(result.status).toBe('HOLD');
      expect(result.pairs).toHaveLength(0);
      expect(result.exceptions.map(({ code }) => code)).toEqual(Array(3).fill('UNMATCHED_PAYOUT'));
      expect(result.summary.byCurrency.every(({ totalBankInflowCents }) => totalBankInflowCents === '0')).toBe(true);
    }
  });

  it('holds an unescaped quote in a bare descriptor even when all matching keys parse', async () => {
    const result = await csv(payoutHeader + '\nX,2026-11-04,125.40,,,USD',
      bankHeader + '\n2026-11-04,Bare"Quote,125.40,USD,bank-001');
    expect(result.status).toBe('HOLD');
    expect(result.pairs).toHaveLength(0);
    expect(result.exceptions).toContainEqual(expect.objectContaining({ code: 'INVALID_ROW', bankLines: [2], column: 'CSV row' }));
  });

  it('preserves complete evidence for dense near cohorts without emitting a row per Cartesian pair', async () => {
    const count = 400;
    const payouts = Array.from({ length: count }, (_, i) => `${i},2026-11-04,125.40,,,USD`);
    const bank = Array.from({ length: count }, (_, i) => `2026-11-04,Bank,125.39,USD,bank-${i}`);
    const result = await csv([payoutHeader, ...payouts].join('\n'), [bankHeader, ...bank].join('\n'));
    const lines = Array.from({ length: count }, (_, i) => i + 2);
    expect(result.pairs).toHaveLength(0);
    expect(result.exceptions).toHaveLength(2 * count + 1);
    expect(result.exceptions.at(-1)).toMatchObject({
      code: 'UNMATCHED_NEAR_AMOUNT', payoutLines: lines, bankLines: lines, deltaCents: '-1', lagDays: 0,
    });
  });

  it('uses inclusive directional dates, absolute near limits or exact percent limits and no date rollover', async () => {
    const payouts = payoutHeader + '\nA,2026-11-08,100.00,,,USD\nB,2026-11-08,3000.00,,,EUR\nC,2026-11-08,100.00,,,GBP';
    const bank = bankHeader + '\n2026-11-07,Bank,100.00,USD,A\n2026-11-18,Bank,75.00,USD,B\n2026-11-18,Bank,74.99,USD,C\n2026-11-08,Bank,3060.00,EUR,D\n2026-11-08,Bank,3060.01,EUR,E\n2026-11-19,Bank,100.00,GBP,F';
    const result = await csv(payouts, bank, { maxLagDays: 10 });
    expect(result.pairs).toHaveLength(0);
    expect(result.exceptions.filter(({ code }) => code === 'UNMATCHED_NEAR_AMOUNT').map(({ deltaCents, bankLines }) => [deltaCents, bankLines]))
      .toEqual([['-2500', [3]], ['6000', [5]]]);
    const same = await csv(payoutHeader + '\nX,2024-02-29,100.00,,,USD',
      bankHeader + '\n2024-02-29T23:59:59-05:00,Bank,100.00,USD,X', { maxLagDays: 0 });
    expect(same.pairs[0]).toMatchObject({ lagDays: 0 });
    await expect(csv(payouts, bank, { maxLagDays: 11 })).rejects.toThrow(/lag/i);
  });
});
