import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repairCsv, type PlatformId, type RepairOptions } from '../../../src/core/index';

interface GoldenFixture {
  file: string;
  platform: PlatformId;
  options?: RepairOptions;
  expectedManual: { code: string; row: number; column: string }[];
  expectedIssueCodes?: string[];
  expectedRemovedRows?: number[];
  expectedDownload?: boolean;
}

const root = resolve(import.meta.dirname, '../../..');
const manifest = JSON.parse(readFileSync(resolve(root, 'fixtures/manifest.json'), 'utf8')) as {
  schemaVersion: number;
  fixtures: GoldenFixture[];
};

describe('dirty CSV bytes', () => {
  it('covers the versioned fixture corpus', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.fixtures.length).toBeGreaterThanOrEqual(24);
  });

  it.each(manifest.fixtures)('$file', ({ file, platform, options, expectedManual, expectedRemovedRows, expectedIssueCodes, expectedDownload }) => {
    const result = repairCsv(readFileSync(resolve(root, file)), basename(file), platform, options);
    const manual = result.issues.filter(({ severity, autoFixed }) => severity === 'error' && !autoFixed);
    expect(manual.map(({ code, row, column }) => ({ code, row, column }))).toEqual(expectedManual);
    expect(result.needsManualReviewCount).toBe(expectedManual.length);
    if (expectedIssueCodes) expect(result.issues.map(({ code }) => code)).toEqual(expect.arrayContaining(expectedIssueCodes));
    if (expectedRemovedRows) expect(result.removedRows.map(({ row }) => row)).toEqual(expectedRemovedRows);
    if (expectedDownload !== undefined) expect(result.canDownload).toBe(expectedDownload);

    if (!result.canDownload) {
      expect(result.repairedCsv).toBe('');
      expect(expectedManual.length).toBeGreaterThan(0);
      return;
    }

    expect(result.roundtripCheck).toEqual({ checked: true, autoFixableRemaining: 0, needsManualReviewCount: expectedManual.length });
    const exportedBytes = new TextEncoder().encode(result.repairedCsv);
    const outputPlatform = options?.stripePayPalOutput === 'quickbooks-3col' ? 'quickbooks-bank' : platform;
    const output = repairCsv(exportedBytes, 'export.csv', outputPlatform, {
      ...options,
      qboCreditDebit: 'intuit',
      stripePayPalFeeConvention: result.stripePayPalFeeConvention,
      ...(outputPlatform === 'quickbooks-bank' ? { dateOrder: options?.dateOrder === 'DMY' ? 'DMY' : 'MDY' } : {}),
    });
    expect(output.detectedEncoding).toBe('utf-8');
    expect(output.issues.filter(({ autoFixed }) => autoFixed)).toEqual([]);
    expect(output.repairedCsv).toBe(result.repairedCsv);
  });
});
