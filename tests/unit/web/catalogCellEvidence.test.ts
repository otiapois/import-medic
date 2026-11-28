import { describe, expect, it } from 'vitest';
import { catalogCellEvidence } from '../../../src/web/workbench/catalog-hygiene/cellEvidence';

describe('catalog cell evidence', () => {
  it('preserves leading zeros, case and outer spaces with visible boundaries', () => {
    expect(catalogCellEvidence('  000aB  ')).toBe('"  000aB  "');
    expect(catalogCellEvidence('000000000000')).toBe('"000000000000"');
    expect(catalogCellEvidence('')).toBe('""');
  });

  it('distinguishes invisible characters from literal escape text and HTML-like source text', () => {
    expect(catalogCellEvidence('a\u200Bb\uFEFF\n\t\u0085')).toBe('"a\\u200Bb\\uFEFF\\n\\t\\u0085"');
    expect(catalogCellEvidence(String.raw`a\u200Bb`)).toBe(String.raw`"a\\u200Bb"`);
    expect(catalogCellEvidence('<cost & notes>')).toBe('"<cost & notes>"');
  });
});
