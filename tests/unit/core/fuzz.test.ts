import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { repairCsv, repairCsvWithBytes } from '../../../src/core';
import { sha256 } from '../../../src/core/audit/custody';
import { analyzeCatalogImpact, createCatalogImpact } from '../../../src/core/analytics/catalog-impact';
import { parseBigCommerceBaseline } from '../../../src/core/bigcommerce-price-diff/source';
import { SIGNOFF_ACCENTS, brandSignoffHtml, type SignoffBrand } from '../../../src/core/branding/signoff-brand';
import { brandCatalogMigrationReports, buildCatalogMigration, type CatalogPlatform } from '../../../src/core/catalog-migrator/engine';
import { readBigCommerce } from '../../../src/core/catalog-migrator/bigcommerce';
import { readShopify } from '../../../src/core/catalog-migrator/shopify';
import { readWooCommerceCatalog } from '../../../src/core/catalog-migrator/woocommerce';
import { createCustodyManifest, dispatchCli, type CliResult } from '../../../src/core/cli/dispatch';
import { isSafeFileName, isSafeLocalPath } from '../../../src/core/cli/paths';
import { decodeCsv, parseCsv, serializeCsv } from '../../../src/core/csv';
import { guardSpreadsheetCell } from '../../../src/core/formula-guard';
import { buildInventorySync } from '../../../src/core/inventory-sync/engine';
import { buildPromoCampaign, type PromoCampaignOptions } from '../../../src/core/promo-campaign/engine';
import { createBookkeeperSignoffHtml } from '../../../src/core/repair/bookkeeper-signoff';
import { escapeReportText, offlineReportCsp } from '../../../src/core/report-html';
import { buildMultiSupplierDiff, buildPriceDiff, parseBaseline, parseSupplier } from '../../../src/core/shopify-price-diff';
import { preparePricing, validatePricingRule } from '../../../src/core/shopify-price-diff/pricing-rules';
import type { PricingBracket, PricingRule } from '../../../src/core/shopify-price-diff/pricing-rules';
import { readAmount } from '../../../src/core/shopify-price-diff/prices';
import { applySupplierRecipe, createSupplierRecipe, parseSupplierRecipe, serializeSupplierRecipe } from '../../../src/core/shopify-price-diff/recipe';
import type { SupplierRecipe } from '../../../src/core/shopify-price-diff/recipe';
import { createWorkspaceProfile, parseWorkspaceProfile, serializeWorkspaceProfile } from '../../../src/core/shopify-price-diff/workspace-profile';
import { createSignoffHtml } from '../../../src/core/shopify-price-diff/signoff-html';
import type { RowResolution } from '../../../src/core/shopify-price-diff/types';
import { parseWooCommerceBaseline } from '../../../src/core/woocommerce-price-diff';
import { inspectImport } from '../../../src/core/verify-import/inspector';
import { brandSupplierDeltaReports, buildSupplierDelta } from '../../../src/core/supplier-delta/engine';
import { runPriceComparison, simulatePriceScenarios, type PriceComparison, type WhatIfScenario } from '../../../src/core/whatif/simulator';
import { listWorkbookSheets } from '../../../src/core/xlsx';
import { parseBom, rollupBom, type BomCost } from '../../../src/core/bom/rollup';
import { syntheticBomBaseline } from './bom-fixtures';


const fuzzExecutions = { accepted: 0, discarded: 0, properties: 0 };

function recordFuzz<T>(details: fc.RunDetails<T>, target: number) {
  if (details.failed) throw new Error(fc.defaultReportMessage(details), { cause: details.errorInstance });
  expect(details.interrupted).toBe(false);
  expect(details.numRuns).toBe(target);
  expect(details.numSkips).toBe(0);
  fuzzExecutions.accepted += details.numRuns;
  fuzzExecutions.discarded += details.numSkips;
  fuzzExecutions.properties++;
}

function checkFuzz<T>(property: fc.IProperty<T>, settings: { seed: number; numRuns: number }) {
  recordFuzz(fc.check(property, settings), settings.numRuns);
}

async function checkAsyncFuzz<T>(property: fc.IAsyncProperty<T>, settings: { seed: number; numRuns: number }) {
  recordFuzz(await fc.check(property, settings), settings.numRuns);
}

const seed = 20261126;
const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/shopify-price-diff/${name}`, import.meta.url));
const bytes = (value: string) => new TextEncoder().encode(value);
const csvBytes = (headers: string[], rows: string[][]) => bytes(serializeCsv(headers, rows, 'shopify-products'));
function cents(units: bigint): string {
  const digits = (units < 0n ? -units : units).toString().padStart(3, '0');
  return (units < 0n ? '-' : '') + digits.slice(0, -2) + '.' + digits.slice(-2);
}
const signedDecimal = fc.tuple(fc.constantFrom('-', '+'), fc.nat({ max: 1_000_000 }), fc.integer({ min: 10, max: 99 }))
  .map(([sign, integer, decimal]) => `${sign}${integer}.${decimal}`);
const dangerousText = fc.tuple(
  fc.constantFrom('', ' ', '\t', '\r', '\n', '\uFEFF', '\u200b'),
  fc.constantFrom('=HYPERLINK("https://example.invalid")', '+text', '-markup', '@label', '＝column', '＋tag', '－batch', '＠file', '-1e5'),
).map(([prefix, value]) => prefix + value);
const variedText = fc.oneof(
  { weight: 12, arbitrary: fc.string({ maxLength: 64 }) },
  { weight: 3, arbitrary: fc.constantFrom('a"b,c', 'first\rsecond\r\nthird\nfourth', '00,005', 'العربية / français', 'café', '🎁') },
  { weight: 1, arbitrary: fc.constant('part "quoted",\n'.repeat(4096)) },
  { weight: 3, arbitrary: dangerousText },
);

describe('M3 deterministic property replay', () => {
  it('preserves 240 serialized CSV matrices across encodings and fails closed on damaged encodings', () => {
    checkFuzz(fc.property(
      fc.array(variedText, { minLength: 1, maxLength: 6 }),
      fc.constantFrom('utf-8', 'utf-8-bom', 'utf-16le', 'windows-1252'),
      fc.uint8Array({ maxLength: 72 }),
      (values, encoding, mutation) => {
        const rows = values.map((value, index) => [`00${index}`, encoding === 'windows-1252' ? 'café ' + value.replace(/[^\x20-\x7e]/g, '?') : value]);
        const csv = serializeCsv(['SKU', 'Note'], rows, 'price-audit');
        const buffer = encoding === 'utf-8-bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(csv)]) :
          encoding === 'utf-16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, 'utf16le')]) :
          encoding === 'windows-1252' ? Buffer.from(csv, 'latin1') : bytes(csv);
        const decoded = decodeCsv(buffer);
        expect(decoded.encoding).toBe(encoding);
        const parsed = parseCsv(decoded.text).records;
        expect(parsed.map(({ cells }) => cells)).toEqual([['SKU', 'Note'], ...rows]);
        expect(parsed.every((entry, index) => !entry.parseError && (index === 0 || entry.line > parsed[index - 1].line))).toBe(true);
        const invalidBytes = Buffer.concat([Buffer.from([0xfe, 0xff]), mutation]);
        expect(parseSupplier(invalidBytes, 'invalid.csv').sheets[0].issues[0].code).toBe('invalid-encoding');
        const arbitrary = parseSupplier(mutation, 'untrusted.csv');
        expect(arbitrary.sheets).toHaveLength(1);
      },
    ), { seed, numRuns: 240 });
  });

  it('processes 160 sparse XLSX and corrupted archive cases using real workbook bytes', () => {
    const entries = unzipSync(fixture('supplier-agency.xlsx'));
    const sheetPart = 'xl/worksheets/sheet2.xml';
    const worksheet = strFromU8(entries[sheetPart]);
    checkFuzz(fc.property(
      fc.integer({ min: 5, max: 1_000_000 }), fc.constantFrom('18.75', '0', '-12.50', 'NaN', '1e999', '1.234E1', 'Infinity'),
      fc.constantFrom('sparse', 'mismatched-address', 'formula', 'truncated'),
      (line, amount, mode) => {
        const adjusted = worksheet.replaceAll(/([="A-B])2(?=["<])/g, `$1${line}`).replace('<v>18.00</v>',
          mode === 'formula' ? '<f>2*9</f><v>18</v>' : `<v>${amount}</v>`);
        const data = zipSync({ ...entries, [sheetPart]: strToU8(mode === 'mismatched-address' ? adjusted.replace(`A${line}`, `A${line + 1}`) : adjusted) });
        const parsed = parseSupplier(mode === 'truncated' ? data.subarray(0, data.length - 15) : data, 'updated.xlsx');
        if (mode === 'truncated' || mode === 'mismatched-address') {
          expect(parsed.issues.map(({ code }) => code)).toEqual(['invalid-xlsx']);
          expect(parsed.sheets).toHaveLength(0);
        } else {
          expect(parsed.issues).toEqual([]);
          expect(parsed.sheets[1].rows).toHaveLength(1);
          const [row] = parsed.sheets[1].rows;
          expect(row.line).toBe(line);
          expect(row.cells[0]).toMatchObject({ value: 'P-02', kind: 'text' });
          expect(row.cells[1]).toMatchObject(mode === 'formula' ? { kind: 'formula', value: '18', formula: '2*9' } : { kind: 'number', value: amount });
        }
      },
    ), { seed: seed + 1, numRuns: 160 });
  });

  it('executes 220 Shopify joins and replays projections against every original variant field', () => {
    const headers = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Variant Compare At Price', 'Body (HTML)', 'Tags'];
    checkFuzz(fc.property(
      fc.array(fc.constantFrom('none', 'first', 'second', 'both'), { minLength: 1, maxLength: 8 }),
      fc.constantFrom('sku', 'handle-options'), fc.boolean(), fc.boolean(), fc.boolean(),
      (updates, joinKey, compareAt, duplicate, guardEnabled) => {
        const source = updates.flatMap((_, group) => [
          [`item-${group}`, `  Item ${group}, "new"  `, 'Color', 'Sand', `000${group}0`, '10.00', '19.00', 'first\r\nsecond', 'tags, original'],
          [`item-${group}`, '', '', 'Forest', `000${group}1`, '11.00', '', '', ''],
        ]);
        const supplierRows = source.flatMap(([handle, , , option, sku], index) => {
          const state = updates[Math.floor(index / 2)];
          if (!(state === 'both' || state === (index % 2 ? 'second' : 'first'))) return [];
          return [[...(joinKey === 'sku' ? [sku] : [handle, option]), '12.25', index % 2 ? '21.75' : '']];
        });
        if (duplicate) {
          const key = joinKey === 'sku' ? [source[0][4]] : [source[0][0], source[0][3]];
          if (!supplierRows.some((row) => row[0] === key[0] && (joinKey === 'sku' || row[1] === key[1]))) supplierRows.push([...key, '14.25', '']);
          supplierRows.push([...key, '11.50', '']);
        }
        const baseline = parseBaseline(csvBytes(headers, source));
        const input = parseSupplier(csvBytes([...(joinKey === 'sku' ? ['SKU'] : ['Handle', 'Option1 Value']), 'New Price', 'Compare-at price'], supplierRows.reverse()), 'batch.csv').sheets[0];
        const result = buildPriceDiff(baseline, input, { joinKey, compareAtColumn: compareAt ? input.headers.length - 1 : null, formulaGuard: guardEnabled });
        if (duplicate) {
          expect(result.issues.some(({ code }) => code === (joinKey === 'sku' ? 'duplicate-sku' : 'duplicate-variant-key'))).toBe(true);
          expect(result.updateCsv).toBeNull();
          return;
        }
        if (supplierRows.length === 0) {
          expect(result.status).toBe('no-changes');
          return;
        }
        expect(result.verification).toEqual({ checked: true, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 });
        const [header, ...records] = parseCsv(decodeCsv(bytes(result.updateCsv!)).text).records;
        const expected = source.filter((_, index) => updates[Math.floor(index / 2)] !== 'none');
        expect(records).toHaveLength(expected.length);
        records.forEach(({ cells, parseError }, index) => {
          expect(parseError).toBeUndefined();
          const original = expected[index];
          const originalIndex = source.indexOf(original);
          const state = updates[Math.floor(originalIndex / 2)];
          const updated = state === 'both' || state === (originalIndex % 2 ? 'second' : 'first');
          expect(cells).toEqual([
            ...original.slice(0, 4), '', '', '', '', original[4], updated ? '12.25' : original[5],
            ...(compareAt ? [updated && originalIndex % 2 ? '21.75' : original[6]] : []),
          ]);
          expect(header.cells).not.toContain('Tags');
          expect(header.cells).not.toContain('Body (HTML)');
        });
        expect(baseline.rows.map(({ cells }) => cells.map(({ value }) => value))).toEqual(source);
      },
    ), { seed: seed + 2, numRuns: 220 });
  });

  it('executes 220 strict recipe roundtrips, reordered headers and unsafe mutations', () => {
    checkFuzz(fc.property(
      fc.nat({ max: 1_000_000 }), fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 100_000_000 }),
      fc.boolean(), fc.constantFrom('schema', 'duplicate', 'missing', 'renamed', 'oversize', 'bad-encoding', 'valid'),
      (key, drop, increase, formulaGuard, mode) => {
        const sku = `SKU ${key}`;
        const price = `New price ${key}`;
        const recipe: SupplierRecipe = {
          version: 1, supplierLabel: `Agency ${key}`, joinKey: { type: 'sku', skuColumn: sku }, priceColumn: price,
          compareAtColumn: null, sheetName: null, dropThresholdPercent: drop / 1000, increaseThresholdPercent: increase / 1000, formulaGuard,
        };
        const validRecipe = serializeSupplierRecipe(recipe);
        expect(parseSupplierRecipe(bytes(validRecipe))).toEqual({ ok: true, value: recipe });
        if (mode === 'schema' || mode === 'duplicate' || mode === 'oversize' || mode === 'bad-encoding') {
          const mutated = mode === 'schema' ? bytes(JSON.stringify({ ...recipe, privateKey: 'unexpected' })) :
            mode === 'duplicate' ? bytes(validRecipe.replace('"version": 1', '"version": 0, "version": 1')) :
            mode === 'oversize' ? bytes(validRecipe + ' '.repeat(65_536)) : new Uint8Array([0xff, 0xfe, 0x7b]);
          expect(parseSupplierRecipe(mutated).ok).toBe(false);
          return;
        }
        const supplier = parseSupplier(csvBytes([mode === 'missing' ? 'Selling price' : mode === 'renamed' ? price.toUpperCase() : price, 'Notes', sku], []), 'batch.csv');
        const applied = applySupplierRecipe(recipe, supplier, 0);
        if (mode === 'valid') {
          expect(applied).toMatchObject({ ok: true, value: { selection: { priceColumn: 0, skuColumn: 2, confirmed: false, sameCurrencyConfirmed: false, formulaGuard } } });
        } else {
          expect(applied).toMatchObject({ ok: false, diagnostics: [{ code: 'recipe-missing-column', expected: price }] });
        }
      },
    ), { seed: seed + 3, numRuns: 220 });
  });

  it('neutralizes 180 dangerous text prefixes without changing any plain signed decimal', () => {
    checkFuzz(fc.property(signedDecimal, dangerousText, (amount, text) => {
      const guarded = guardSpreadsheetCell(text);
      expect(guarded).toBe("'" + text);
      expect(guardSpreadsheetCell(guarded)).toBe(guarded);
      expect(guardSpreadsheetCell(amount)).toBe(amount);
      const reparsed = parseCsv(decodeCsv(csvBytes(['Text', 'Amount'], [[guarded, amount]])).text);
      expect(reparsed.records[1].cells).toEqual([guarded, amount]);
    }), { seed: seed + 4, numRuns: 180 });
  });

  it('re-parses all 240 available bank and Stripe/PayPal repair exports without silent amount repair', () => {
    checkFuzz(fc.property(
      signedDecimal, variedText, dangerousText, fc.boolean(),
      fc.constantFrom('valid', 'NaN', 'Infinity', '1e9', '1,23', '($12.50)', '03/04/2026'),
      fc.constantFrom('bank', 'stripe', 'paypal'),
      (amount, description, formula, enabled, variant, format) => {
        const valid = variant === 'valid' || variant === '($12.50)';
        const date = variant === '03/04/2026' ? variant : '2026-11-24';
        const val = variant === 'valid' || variant === '03/04/2026' ? amount : variant;
        const platform = format === 'bank' ? 'quickbooks-bank' : 'stripe-paypal';
        const headers = format === 'bank' ? ['Date', 'Description', 'Amount'] :
          [format === 'stripe' ? 'Created (UTC)' : 'Date', 'Description', 'Gross', 'Fee', 'Net', 'Currency', ...(format === 'paypal' ? ['Balance Impact'] : [])];
        const row = (when: string, text: string, money: string) => format === 'bank' ? [when, text, money] :
          [when, text, money, '0', money, 'USD', ...(format === 'paypal' ? [money.startsWith('-') || money.startsWith('(') ? 'Debit' : 'Credit'] : [])];
        const options = { formulaGuard: enabled };
        const result = repairCsv(csvBytes(headers, [row(date, description, val), row('2026-11-25', formula, '-12.50')]), 'batch.csv', platform, options);
        if (!result.canDownload) {
          expect(result.repairedCsv).toBe('');
          expect(result.formulaGuard.neutralized).toEqual([]);
          expect(result.needsManualReviewCount).toBeGreaterThan(0);
          return;
        }
        expect(result.roundtripCheck).toMatchObject({ checked: true, autoFixableRemaining: 0 });
        const exported = parseCsv(decodeCsv(bytes(result.repairedCsv)).text).records;
        expect(exported.map(({ cells }) => cells)).toEqual([result.headers, ...result.rows.map(({ after }) => after)]);
        const amountIndex = result.headers.indexOf(platform === 'quickbooks-bank' ? 'Amount' : 'Net');
        expect(exported[2].cells[amountIndex]).toBe('-12.50');
        if (!valid && variant !== '03/04/2026') expect(exported[1].cells[amountIndex]).toBe(val);
        expect(result.formulaGuard.blocked).toEqual([]);
        if (enabled) expect(result.formulaGuard.neutralized).toContainEqual(expect.objectContaining({ row: result.rows[1].row, column: 'Description' }));
      },
    ), { seed: seed + 5, numRuns: 240 });
  });
});

describe('M8 deterministic catalog impact and non-target replay', () => {
  const decimal = (units: bigint, places: number) => {
    const digits = (units < 0n ? -units : units).toString().padStart(places + 1, '0');
    return `${units < 0n ? '-' : ''}${digits.slice(0, -places)}.${digits.slice(-places)}`;
  };
  const percent = (numerator: bigint, denominator: bigint) => {
    const negative = numerator < 0n;
    const absolute = (negative ? -numerator : numerator) * 10_000n;
    const remainder = absolute % denominator;
    const cents = absolute / denominator + (remainder + remainder >= denominator ? 1n : 0n);
    return decimal(negative ? -cents : cents, 2);
  };

  it('checks 800 exact FX margin cohorts and replays actual bytes through the whole catalog matrix', async () => {
    const amount = fc.bigInt({ min: 1n, max: 900719925474099300n });
    const headers = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Body (HTML)', 'Tags'];
    await checkAsyncFuzz(fc.asyncProperty(amount, amount, amount, amount, fc.bigInt({ min: 2400n, max: 25_000n }),
      fc.string({ maxLength: 30 }), async (retailA, retailB, costA, costB, rate, tag) => {
        const originals = [
          ['product', 'Exact title', 'Size', 'Small', 'A', decimal(retailA + 19n, 2), '<b>Markup & text</b>', tag],
          ['product', '', '', 'Large', 'B', decimal(retailB + 23n, 2), 'Keep,\n"bytes"', 'sibling'],
        ];
        const baselineBytes = csvBytes(headers, originals);
        const baseline = parseBaseline(baselineBytes);
        const supplier = parseSupplier(csvBytes(['SKU', 'Cost'], [['A', decimal(costA, 2)], ['B', decimal(costB, 2)]]), 'wholesale.csv').sheets[0];
        const pricingRule: PricingRule = { mode: 'direct', fx: { sourceCurrency: 'EUR', storeCurrency: 'USD', fxRate: decimal(rate, 4) } };
        const result = buildPriceDiff(baseline, supplier, { confirmed: true, fxRateConfirmed: true, pricingRule }, {
          2: { price: decimal(retailA, 2), confirm: true }, 3: { price: decimal(retailB, 2), confirm: true },
        });
        expect(result.canDownload).toBe(true);
        expect(await inspectImport('shopify', baselineBytes, result.updateBytes!)).toMatchObject({ verdict: 'PASS', changedSkus: 2 });
        expect(await inspectImport('shopify', baselineBytes, result.rollbackBytes!, result.updateBytes!))
          .toMatchObject({ verdict: 'PASS', rollback: { scope: 'paired-update', residualDiffs: 0 } });
        const denominatorA = retailA * 10_000n;
        const denominatorB = retailB * 10_000n;
        const numeratorA = denominatorA - costA * rate;
        const numeratorB = denominatorB - costB * rate;
        const a = numeratorA * denominatorB;
        const b = numeratorB * denominatorA;
        const den = denominatorA * denominatorB;
        const summary = analyzeCatalogImpact(result.rows, false);
        expect(summary.margin).toEqual({ count: 2, averagePercent: percent(a + b, 2n * den),
          lowestPercent: percent(a < b ? a : b, den), highestPercent: percent(a > b ? a : b, den),
          watchlistCount: Number(numeratorA <= 0n) + Number(numeratorB <= 0n) });
        expect(result.verification).toMatchObject({ nonTargetFieldsChanged: 0, brokenVariantGroups: 0 });
        for (const [restoring, payload] of [result.updateBytes!, result.rollbackBytes!].entries()) {
          const [head, ...records] = parseCsv(decodeCsv(payload).text).records;
          const actual = originals.map(row => [...row]);
          for (const [index, record] of records.entries()) {
            const fields = record.cells;
            for (const [position, column] of head.cells.entries()) {
              const originalIndex = headers.indexOf(column);
              if (originalIndex >= 0) actual[index][originalIndex] = fields[position];
            }
          }
          const expected = originals.map(row => [...row]);
          if (!restoring) {
            expected[0][5] = decimal(retailA, 2);
            expected[1][5] = decimal(retailB, 2);
          }
          expect(actual).toEqual(expected);
        }
      }), { seed: seed + 15, numRuns: 800 });
  }, 15_000);

  it('checks 550 half-open histogram and Woo sale-margin cases with BigInt sub-cent offsets', () => {
    const bounds = [-20n, -5n, 0n, 5n, 20n];
    checkFuzz(fc.property(fc.integer({ min: 0, max: 4 }), fc.integer({ min: -1, max: 1 }),
      fc.bigInt({ min: 1n, max: 5_000_000_000_000_000n }), fc.constantFrom('keep', 'watch', 'safe'), (index, direction, scale, mode) => {
        const units = scale * 100n + 17n;
        const oldPrice = units * 100n;
        const cut = bounds[index];
        const next = (100n + cut) * units + BigInt(direction);
        const sale = next / 2n;
        const cost = mode === 'watch' ? sale + 1n : sale - 1n;
        const headers = ['ID', 'Type', 'SKU', 'Parent', 'Name', 'Regular price', 'Sale price', 'Description'];
        const baseline = parseWooCommerceBaseline(csvBytes(headers, [['1', 'simple', '001', '', 'Item', decimal(oldPrice, 6), decimal(sale, 6), 'Exact']]));
        const supplier = parseSupplier(csvBytes(['SKU', 'Wholesale Price'], [['001', decimal(cost, 6)]]), 'costs.csv').sheets[0];
        const result = buildPriceDiff(baseline, supplier, { confirmed: true }, { 2: { price: decimal(next, 6), confirm: true } });
        const impact = createCatalogImpact(false);
        const row = impact.add(result.rows[0]);
        expect(row?.grossMarginPercent).toBe(percent(sale - cost, sale));
        expect(row?.belowOrAtCost).toBe(mode === 'watch');
        const expected = [
          [0, 1, 1], [1, 2, 2], [2, 3, 4], [4, 4, 5], [5, 5, 6],
        ][index][direction + 1];
        expect(impact.summarize().histogram.map(({ count }) => count)).toEqual(Array.from({ length: 7 }, (_, key) => Number(key === expected)));
      }), { seed: seed + 16, numRuns: 550 });
  });
});

describe('M4 deterministic property replay', () => {
  it('checks 290 exact wholesale transformations against independently derived cents and ending bounds', () => {
    const decimal = (value: number, places: number) => {
      const digits = Math.abs(value).toString().padStart(places + 1, '0');
      return (value < 0 ? '-' : '') + digits.slice(0, -places) + '.' + digits.slice(-places);
    };
    checkFuzz(fc.property(
      fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 700 }),
      fc.integer({ min: 0, max: 3_999 }), fc.integer({ min: -9_999, max: 9_999 }),
      fc.integer({ min: 0, max: 2_500_000 }), fc.constantFrom('multiplier', 'percent-markup', 'target-margin'),
      fc.constantFrom('none', 'ending-99', 'ending-95', 'nearest-whole'),
      (cost, factor, fee, percent, minimum, mode, rounding) => {
        const floor = minimum === 0 ? undefined : decimal(minimum, 4);
        const rule: PricingRule = mode === 'multiplier'
          ? { mode, multiplier: decimal(factor, 2), fixedFee: decimal(fee, 3), minimumRetail: floor, rounding }
          : mode === 'percent-markup'
            ? { mode, markupPercent: decimal(percent, 2), minimumRetail: floor, rounding }
            : { mode, marginPercent: decimal(Math.abs(percent), 2), minimumRetail: floor, rounding };
        // Input uses 1/10,000 currency units. Express each result in cents as an
        // independent integer ratio so divisibility and the exact ties are visible.
        const [numerator, denominator] = mode === 'multiplier'
          ? [BigInt(cost * factor + fee * 1_000), 10_000n]
          : mode === 'percent-markup'
            ? [BigInt(cost * (10_000 + percent)), 1_000_000n]
            : [BigInt(cost * 100), BigInt(10_000 - Math.abs(percent))];
        const output = preparePricing(rule)(readAmount(decimal(cost, 4))!);
        const cents = output?.units ?? 0n;
        const minimumCents = BigInt(minimum);
        expect(cents * 100n >= minimumCents).toBe(true);
        if (rounding === 'ending-99' || rounding === 'ending-95') {
          expect(cents % 100n).toBe(rounding === 'ending-99' ? 99n : 95n);
          expect(cents * denominator >= numerator).toBe(true);
          expect((cents - 100n) * denominator < numerator || (cents - 100n) * 100n < minimumCents).toBe(true);
        } else {
          const interval = rounding === 'nearest-whole' ? 100n : 1n;
          const divisor = interval * denominator;
          const minimumSteps = (minimumCents + interval * 100n - 1n) / (interval * 100n);
          const nearest = numerator / divisor + (numerator % divisor * 2n >= divisor ? 1n : 0n);
          expect(cents).toBe(interval * (nearest > minimumSteps ? nearest : minimumSteps));
        }
        if (output) expect(output.text).toMatch(/^\d+\.\d{2}$/);
      },
    ), { seed: seed + 6, numRuns: 290 });
  });

  it('replays 300 actual update and rollback byte pairs into exact original full matrices', async () => {
    const headers = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Variant Compare At Price', 'Tags', 'Image Src'];
    await checkAsyncFuzz(fc.asyncProperty(
      fc.integer({ min: 1, max: 900 }),
      fc.array(fc.constantFrom('none', 'first', 'second', 'both'), { minLength: 1, maxLength: 8 }),
      fc.constantFrom('sku', 'handle-options'), fc.boolean(), fc.boolean(),
      async (cost, affected, joinKey, compareAt, guardEnabled) => {
        const groups = ['first', ...affected];
        const base = groups.flatMap((_, group) => [
          [`item-${group}`, `  Côte "${group}", Red  `, 'Color', 'Red', `000${group}0`, '0010.000', '', 'a,b', ''],
          [`item-${group}`, '', '', 'Blue', `000${group}1`, '0011.000', '020.000', '', ''],
          [`item-${group}`, '', '', '', '', '', '', '', `https://example.invalid/${group}.png`],
        ]);
        const inputRows = base.flatMap(([handle, , , option, sku], index) => {
          const state = groups[Math.floor(index / 3)];
          if (!sku || !(state === 'both' || state === (index % 3 ? 'second' : 'first'))) return [];
          return [[...(joinKey === 'sku' ? [sku] : [handle, option]), String(cost), `${2 * cost + 5}.${index % 3 ? '75' : '25'}`]];
        });
        const supplierHeaders = [...(joinKey === 'sku' ? ['SKU'] : ['Handle', 'Option1 Value']), 'Cost', 'Compare-at price'];
        const supplier = parseSupplier(csvBytes(supplierHeaders, inputRows.reverse()), 'batch.csv').sheets[0];
        const baselineBytes = csvBytes(headers, base);
        const baseline = parseBaseline(baselineBytes);
        const result = buildPriceDiff(baseline, supplier, {
          joinKey, confirmed: true, compareAtColumn: compareAt ? supplierHeaders.length - 1 : null, formulaGuard: guardEnabled,
          dropThresholdPercent: 100, increaseThresholdPercent: 100_000,
          pricingRule: { mode: 'multiplier', multiplier: '2', rounding: 'ending-99' },
        });
        expect(result.canDownload).toBe(true);
        expect(await inspectImport('shopify', baselineBytes, result.updateBytes!)).toMatchObject({ verdict: 'PASS' });
        expect(await inspectImport('shopify', baselineBytes, result.rollbackBytes!, result.updateBytes!))
          .toMatchObject({ verdict: 'PASS', rollback: { scope: 'paired-update', residualDiffs: 0 } });
        const original = base.map((row) => [...row]);
        const replay = (data: Uint8Array) => {
          const [header, ...records] = parseCsv(decodeCsv(data).text).records;
          const keys: string[] = [];
          for (const { cells, parseError } of records) {
            expect(parseError).toBeUndefined();
            const sku = cells[header.cells.indexOf('Variant SKU')];
            keys.push(sku);
            const row = original.find((row) => row[4] === sku)!;
            header.cells.forEach((column, index) => {
              const position = headers.indexOf(column);
              if (position !== -1) row[position] = cells[index];
              else expect(cells[index]).toBe('');
            });
          }
          return keys;
        };
        const keys = replay(result.updateBytes!);
        expect(keys).toEqual(base.filter((row, index) => row[4] && groups[Math.floor(index / 3)] !== 'none').map((row) => row[4]));
        expect(original).toEqual(base.map((record, index) => {
          const state = groups[Math.floor(index / 3)];
          if (!record[4] || !(state === 'both' || state === (index % 3 ? 'second' : 'first'))) return record;
          const row = [...record];
          row[5] = `${2 * cost}.99`;
          if (compareAt) row[6] = `${2 * cost + 5}.${index % 3 ? '75' : '25'}`;
          return row;
        }));
        expect(replay(result.rollbackBytes!)).toEqual(keys);
        expect(original).toEqual(base);
        expect(result.rollbackVerification).toEqual({ checked: true, restoredVariants: keys.length });
      },
    ), { seed: seed + 7, numRuns: 300 });
  }, 15_000);
});

describe('M5 deterministic property replay', () => {
  it('matches independently computed FX retail and automatic compare-at cents across 350 full comparisons', () => {
    const baseline = parseBaseline(fixture('baseline-fx.csv'));
    const centsText = (cents: bigint) => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
    checkFuzz(fc.property(
      fc.integer({ min: 1_000, max: 6_000 }), fc.integer({ min: 8_000, max: 18_000 }),
      fc.integer({ min: 100, max: 300 }), fc.integer({ min: 0, max: 150 }),
      fc.constantFrom('none', 'ending-99', 'ending-95', 'nearest-whole'),
      (cost, rate, markup, fee, rounding) => {
        const source = csvBytes(['SKU', 'Cost', 'Currency'], [['001', centsText(BigInt(cost)), 'EUR']]);
        const sheet = parseSupplier(source, 'batch.csv').sheets[0];
        const rule: PricingRule = {
          mode: 'multiplier', multiplier: centsText(BigInt(markup)), fixedFee: centsText(BigInt(fee)), rounding,
          fx: { sourceCurrency: 'EUR', storeCurrency: 'USD', fxRate: (rate / 10_000).toFixed(4) },
          compareAtRule: { multiplier: '1.25' },
        };
        function expected(numerator: bigint, denominator: bigint): bigint {
          if (rounding === 'ending-99' || rounding === 'ending-95') {
            const whole = numerator / (denominator * 100n);
            const ending = rounding === 'ending-99' ? 99n : 95n;
            const lower = whole * 100n + ending;
            return lower * denominator < numerator ? lower + 100n : lower;
          }
          const stepSize = rounding === 'nearest-whole' ? 100n : 1n;
          const divisor = denominator * stepSize;
          const fraction = numerator % divisor;
          return (numerator / divisor + (fraction >= divisor - fraction ? 1n : 0n)) * stepSize;
        }
        const retail = expected(BigInt(cost * rate * markup + fee * 1_000_000), 1_000_000n);
        const compareAt = expected(retail * 5n, 4n);
        const result = buildPriceDiff(baseline, sheet, {
          confirmed: true, fxRateConfirmed: true, dropThresholdPercent: 100, increaseThresholdPercent: 100_000, pricingRule: rule,
        });
        const finalRetail = retail === 2_000n ? '020.000' : centsText(retail);
        expect(result.canDownload).toBe(true);
        expect(result.rows[0]).toMatchObject({ computedPrice: centsText(retail), newPrice: finalRetail, newCompareAtPrice: centsText(compareAt), fxApplied: rule.fx });
        const [, record] = parseCsv(decodeCsv(result.updateBytes!).text).records;
        expect(record.cells.slice(-2)).toEqual([finalRetail, centsText(compareAt)]);
      },
    ), { seed: seed + 8, numRuns: 350 });
  });

  it('checks 350 v3 recipe and exact FX rollback replays, including unsafe batch and Compare-at inputs', () => {
    const baseline = parseBaseline(fixture('baseline-fx.csv'));
    const original = baseline.rows.map(({ cells }) => cells.map(({ value }) => value));
    checkFuzz(fc.property(
      fc.integer({ min: 5, max: 100 }), fc.integer({ min: 1000, max: 2000 }),
      fc.constantFrom('auto', 'mapped', 'unconfirmed', 'lower', 'conflicting-unit'),
      (cost, rate, mode) => {
        const auto = mode === 'auto' || mode === 'unconfirmed';
        const unit = mode === 'conflicting-unit' ? 'GBP' : 'EUR';
        const compare = (mode === 'lower' ? cost : 3 * cost).toString();
        const initial = ['SKU', 'Cost', 'Compare-at price', 'Currency'];
        const pricingRule: PricingRule = {
          mode: 'multiplier', multiplier: '2.2', rounding: 'ending-99',
          fx: { sourceCurrency: 'EUR', storeCurrency: 'USD', fxRate: (rate / 1000).toFixed(3) },
          ...(auto ? { compareAtRule: { multiplier: '1.25' } } : {}),
        };
        const created = createSupplierRecipe('Agency', initial, {
          confirmed: true, fxRateConfirmed: true, joinKey: 'sku', skuColumn: 0, priceColumn: 1, compareAtColumn: auto ? null : 2,
          dropThresholdPercent: 100, increaseThresholdPercent: 100_000, pricingRule,
        }, null);
        if (!created.ok) throw new Error('Expected v3 recipe');
        const parsed = parseSupplierRecipe(bytes(serializeSupplierRecipe(created.value)));
        expect(parsed).toEqual(created);
        if (!parsed.ok) throw new Error('Expected valid serialized recipe');
        const supplier = parseSupplier(csvBytes(initial.reverse(), [[unit, compare, cost.toString(), '001']]), 'new.csv');
        const applied = applySupplierRecipe(parsed.value, supplier, 0);
        expect(applied).toMatchObject({ ok: true, value: { selection: { confirmed: false, fxRateConfirmed: false, skuColumn: 3, priceColumn: 2 } } });
        if (!applied.ok) throw new Error('Expected an applied v3 recipe');
        const result = buildPriceDiff(baseline, supplier.sheets[0], { ...applied.value.selection, confirmed: true, fxRateConfirmed: mode !== 'unconfirmed' });
        if (mode === 'unconfirmed' || mode === 'lower' || mode === 'conflicting-unit') {
          const code = mode === 'unconfirmed' ? 'fx-rate-confirmation-required' : mode === 'lower' ? 'compare-at-not-above-price' : 'fx-source-currency-conflict';
          expect(result.issues).toContainEqual(expect.objectContaining({ code, blocking: true }));
          expect(result).toMatchObject({ canDownload: false, updateBytes: null, rollbackBytes: null });
          return;
        }
        expect(result.canDownload).toBe(true);
        const matrix = original.map((row) => [...row]);
        for (const data of [result.updateBytes!, result.rollbackBytes!]) {
          const [header, ...records] = parseCsv(decodeCsv(data).text).records;
          expect(records).toHaveLength(2);
          for (const { cells, parseError } of records) {
            expect(parseError).toBeUndefined();
            const sku = cells[header.cells.indexOf('Variant SKU')];
            const originalIndex = original.findIndex((row) => row[4] === sku);
            header.cells.forEach((column, index) => {
              const position = baseline.headers.indexOf(column);
              if (position >= 0) matrix[originalIndex][position] = cells[index];
              else expect(cells[index]).toBe('');
            });
          }
        }
        expect(matrix).toEqual(original);
        expect(result.rollbackVerification).toEqual({ checked: true, restoredVariants: 2 });
      },
    ), { seed: seed + 9, numRuns: 350 });
  });
});


describe('M6 deterministic multi-supplier and inventory replay', () => {
  const headers = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Inventory quantity', 'Tags', 'Image Src'];
  const baselineRows = [
    ['stock', 'Stock', 'Color', 'Red', '0001', '10.000', '00100', 'unchanged', ''],
    ['stock', '', '', 'Blue', '0002', '020.00', '-0003', '', ''],
    ['stock', '', '', '', '', '', '', '', 'https://example.invalid/image.png'],
    ['other', 'Other', 'Title', 'Default Title', '9000', '011.00', '27', 'original', ''],
  ];
  const baselineBytes = csvBytes(headers, baselineRows);
  const baseline = parseBaseline(baselineBytes);
  const selection = { inventoryColumn: 2, inventoryDropThresholdPercent: 100 };

  it('replays 500 three-source exact price choices in both directions against the whole original matrix', async () => {
    await checkAsyncFuzz(fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: 9_999 }), { minLength: 3, maxLength: 3 }),
      fc.tuple(fc.integer({ min: 20, max: 200 }), fc.integer({ min: 20, max: 200 }), fc.integer({ min: 20, max: 200 })),
      fc.constantFrom('prefer-first', 'prefer-last', 'prefer-lowest', 'prefer-highest'), fc.boolean(),
      async (amounts, quantities, conflictPolicy, guardEnabled) => {
        const prices = amounts.map(amount => `11.0000000000000000${String(amount).padStart(4, '0')}`);
        const inputs = prices.map((price, index) => {
          const filename = `supplier-${index}.csv`;
          const sheet = parseSupplier(csvBytes(['SKU', 'Price', 'Stock'], [['0001', price, String(quantities[index])]]), filename).sheets[0];
          return { supplierId: filename, filename, sheet, selection: { ...selection, formulaGuard: guardEnabled } };
        });
        const winner = conflictPolicy === 'prefer-first' ? 0 : conflictPolicy === 'prefer-last' ? 2 :
          amounts.indexOf(conflictPolicy === 'prefer-lowest' ? Math.min(...amounts) : Math.max(...amounts));
        const expectedQuantity = quantities[winner] === 100 ? '00100' : String(quantities[winner]);
        const result = buildMultiSupplierDiff(baseline, inputs, { conflictPolicy, conflictPolicyConfirmed: true });
        expect(result).toMatchObject({ canDownload: true, overlapCount: 1, conflictCount: 1, rollbackVerification: { checked: true, restoredVariants: 2 } });
        expect(await inspectImport('shopify', baselineBytes, result.updateBytes!))
          .toMatchObject({ verdict: 'PASS', matchedRows: 2, changedSkus: 1, unchangedSiblingSkus: 1 });
        expect(await inspectImport('shopify', baselineBytes, result.rollbackBytes!, result.updateBytes!))
          .toMatchObject({ verdict: 'PASS', rollback: { scope: 'paired-update', residualDiffs: 0 } });
        expect(result.rows[0]).toMatchObject({ supplierId: inputs[winner].supplierId, newPrice: prices[winner], newInventoryQty: expectedQuantity });
        const copy = baselineRows.map(row => [...row]);
        const replay = (payload: Uint8Array) => {
          const [header, ...variants] = parseCsv(decodeCsv(payload).text).records;
          expect(variants).toHaveLength(2);
          expect(header.cells).not.toContain('Tags');
          expect(header.cells).not.toContain('Image Src');
          for (const { cells, parseError } of variants) {
            expect(parseError).toBeUndefined();
            const sku = cells[header.cells.indexOf('Variant SKU')];
            const target = copy.find(row => row[4] === sku)!;
            header.cells.forEach((column, index) => {
              const position = headers.indexOf(column === 'Variant Inventory Qty' ? 'Inventory quantity' : column);
              if (position < 0) expect(cells[index]).toBe('');
              else target[position] = cells[index];
            });
          }
        };
        replay(result.updateBytes!);
        expect(copy).toEqual(baselineRows.map((row, index) => index === 0
          ? [...row.slice(0, 5), prices[winner], expectedQuantity, ...row.slice(7)] : row));
        replay(result.rollbackBytes!);
        expect(copy).toEqual(baselineRows);
        expect(baseline.rows.map(({ cells }) => cells.map(({ value }) => value))).toEqual(baselineRows);
      },
    ), { seed: seed + 10, numRuns: 500 });
  }, 15_000);

  it('replays 450 v4 recipes and verifies exact independent threshold decisions and immutable inputs', () => {
    checkFuzz(fc.property(
      fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 100_000 }),
      fc.constantFrom('valid', 'explicit-approval', 'fractional', 'missing', 'negative'),
      (stock, tolerance, mode) => {
        const source = mode === 'fractional' ? `${stock}.0` : mode === 'missing' ? '' : mode === 'negative' ? `-${stock}` : String(stock);
        const recipe = createSupplierRecipe('Vendor', ['SKU', 'Price', 'Stock'], {
          skuColumn: 0, priceColumn: 1, inventoryColumn: 2, joinKey: 'sku', confirmed: true,
          conflictPolicy: 'prefer-lowest', inventoryDropThresholdPercent: tolerance / 1000,
        }, null);
        expect(recipe.ok).toBe(true);
        if (!recipe.ok) throw new Error('Expected a v4 recipe');
        expect(parseSupplierRecipe(bytes(serializeSupplierRecipe(recipe.value)))).toEqual(recipe);
        const supplier = parseSupplier(csvBytes(['Stock', 'Price', 'SKU'], [[source, '11', '0001']]), 'reordered.csv');
        const recovered = applySupplierRecipe(recipe.value, supplier, 0);
        expect(recovered).toMatchObject({ ok: true, value: { selection: { confirmed: false, inventoryColumn: 0, conflictPolicy: 'prefer-lowest' } } });
        if (!recovered.ok) throw new Error('Expected exact recipe mapping');
        const output = buildPriceDiff(baseline, supplier.sheets[0], { ...recovered.value.selection, confirmed: true },
          mode === 'explicit-approval' ? { 2: { confirm: true } } : {});
        const invalid = mode === 'fractional' || mode === 'missing' || mode === 'negative';
        const guard = stock === 0 || (100 - stock) * 1000 > tolerance;
        if (invalid || guard && mode !== 'explicit-approval') {
          expect(output).toMatchObject({ canDownload: false, updateBytes: null, rollbackBytes: null });
          expect(output.issues).toContainEqual(expect.objectContaining({ blocking: true, code: invalid
            ? 'invalid-inventory-qty' : stock === 0 ? 'inventory-zero-out' : 'inventory-drop' }));
        } else {
          expect(output).toMatchObject({ canDownload: true, verification: { nonTargetFieldsChanged: 0, brokenVariantGroups: 0 } });
          const update = parseCsv(decodeCsv(output.updateBytes!).text).records;
          const rollback = parseCsv(decodeCsv(output.rollbackBytes!).text).records;
          expect(update.map(({ cells }) => cells.at(-1))).toEqual(['Variant Inventory Qty', stock === 100 ? '00100' : String(stock), '-0003']);
          expect(rollback.map(({ cells }) => cells.at(-1))).toEqual(['Variant Inventory Qty', '00100', '-0003']);
        }
        expect(supplier.sheets[0].rows[0].cells[0].value).toBe(source);
        expect(baseline.rows.map(({ cells }) => cells.map(({ value }) => value))).toEqual(baselineRows);
      },
    ), { seed: seed + 11, numRuns: 450 });
  });
});

describe('M7 deterministic tiered pricing and WooCommerce replay', () => {
  const decimal = (number: number | bigint, places: number) => {
    const digits = number.toString().padStart(places + 1, '0');
    return digits.slice(0, -places) + '.' + digits.slice(-places);
  };

  it('matches 900 exact FX tier and rounding decisions against independent integer arithmetic', () => {
    checkFuzz(fc.property(
      fc.integer({ min: 1, max: 50_000 }), fc.constantFrom(10_000, 12_500, 17_500),
      fc.uniqueArray(fc.integer({ min: 1, max: 300_000 }), { minLength: 1, maxLength: 5 }),
      fc.integer({ min: 100, max: 500 }), fc.integer({ min: 0, max: 50_000 }), fc.integer({ min: 0, max: 500 }),
      fc.integer({ min: 0, max: 400_000 }), fc.constantFrom('none', 'ending-99', 'ending-95', 'nearest-whole'),
      fc.constantFrom('boundary', 'over', 'under', 'natural', 'non-monotonic', 'missing-catch-all'),
      (amount, rate, limits, factor, percent, fee, floor, rounding, mode) => {
        const force = mode === 'boundary' || mode === 'over' || mode === 'under';
        const source = force ? amount * 4 + (mode === 'over' ? 1 : mode === 'under' ? -1 : 0) : amount;
        const cutoffs = [...new Set(force ? [amount * 4 * rate / 10_000, ...limits.slice(1)] : limits)].sort((a, b) => a - b);
        const brackets: PricingBracket[] = [...cutoffs.map(limit => decimal(limit, 2)), null].map((upTo, index) =>
          index % 2 === 0 ? { upTo, mode: 'multiplier', multiplier: decimal(factor + index, 2), fixedFee: decimal(fee, 2) } :
            { upTo, mode: 'percent-markup', markupPercent: decimal(percent + index, 2), fixedFee: decimal(fee, 2) });
        if (mode === 'non-monotonic') brackets.splice(1, 0, { ...brackets[0] });
        if (mode === 'missing-catch-all') brackets.at(-1)!.upTo = '999999.99';
        const rule: PricingRule = {
          mode: 'tiered-brackets', brackets, rounding, minimumRetail: floor > 0 ? decimal(floor, 4) : undefined,
          fx: { sourceCurrency: 'EUR', storeCurrency: 'USD', fxRate: decimal(rate, 4) },
        };
        if (mode === 'non-monotonic' || mode === 'missing-catch-all') {
          expect(validatePricingRule(rule)).toBeTruthy();
          return;
        }
        expect(validatePricingRule(rule)).toBeNull();
        const comparison = BigInt(source) * BigInt(rate);
        const tier = cutoffs.filter(cutoff => comparison > BigInt(cutoff) * 10_000n).length;
        const denominator = 100_000_000n;
        const ratePerTenThousand = BigInt(tier % 2 === 0 ? 100 * (factor + tier) : 10_000 + percent + tier);
        const adjusted = comparison * ratePerTenThousand + BigInt(fee) * denominator;
        const minimum = BigInt(floor) * 1_000_000n;
        const step = rounding === 'nearest-whole' ? 100n : 1n;
        let expected: bigint;
        if (rounding === 'ending-99' || rounding === 'ending-95') {
          const ending = rounding === 'ending-99' ? 99n : 95n;
          const target = adjusted < minimum ? minimum : adjusted;
          const candidate = (target / (100n * denominator)) * 100n + ending;
          expected = candidate * denominator < target ? candidate + 100n : candidate;
          expect((expected - 100n) * denominator < target).toBe(true);
        } else {
          const divisor = denominator * step;
          const remainder = adjusted % divisor;
          const nearest = (adjusted / divisor + (remainder >= divisor - remainder ? 1n : 0n)) * step;
          const floored = (minimum / divisor + (minimum % divisor === 0n ? 0n : 1n)) * step;
          expected = nearest < floored ? floored : nearest;
        }
        const result = preparePricing(rule)(readAmount(decimal(source, 2))!);
        if (expected === 0n) expect(result).toBeNull();
        else {
          expect(result?.text).toBe(decimal(expected, 2));
          expect(result?.matchedTier).toMatch(new RegExp('^Tier ' + (tier + 1) + ' '));
        }
      },
    ), { seed: seed + 12, numRuns: 900 });
  });

  it('replays 650 WooCommerce parent groups and rejects anomaly cases before either download', async () => {
    const headers = ['ID', 'Type', 'SKU', 'Parent', 'Regular price', 'Sale price', 'Stock', 'Description', 'Images', 'Meta:test'];
    await checkAsyncFuzz(fc.asyncProperty(
      fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 50, max: 150 }), fc.integer({ min: 1, max: 1000 }), fc.boolean(),
      fc.constantFrom('ordinary', 'backorder', 'broken-parent', 'duplicate-sku', 'duplicate-id', 'scientific', 'inherited-stock', 'retained-sale'),
      async (key, amount, stock, idRef, mode) => {
        const parentId = String(key * 3);
        const parentSku = '00' + parentId;
        const childId = String(key * 3 + 1);
        const siblingId = String(key * 3 + 2);
        const sku = '00' + childId;
        const parent = mode === 'broken-parent' ? 'id:999999999' : idRef ? 'id:' + parentId : parentSku;
        const regular = mode === 'retained-sale' ? '39.00' : decimal(amount * 100 + 3, 2);
        const originals = [
          [parentId, 'variable', parentSku, '', '', '', '', 'Parent, exact"\r\nText', 'https://example.invalid/p', 'literal'],
          [childId, 'variation, virtual', sku, parent, '045.000', '40.00', mode === 'inherited-stock' ? 'parent' : mode === 'backorder' ? '-003' : '004', 'Variation', '', ''],
          [mode === 'duplicate-id' ? childId : siblingId, 'variation', mode === 'duplicate-sku' ? sku : '00' + siblingId,
            parentSku, '30', '', '002', 'Untouched sibling', '', 'sibling'],
        ];
        const baselineBytes = csvBytes(headers, originals);
        const baseline = parseWooCommerceBaseline(baselineBytes);
        const supplier = parseSupplier(csvBytes(['SKU', 'Price', 'Stock'], [[mode === 'scientific' ? '123E4' : sku, regular, String(stock)]]), 'woo.csv').sheets[0];
        const result = buildMultiSupplierDiff(baseline, [{ supplierId: 'csv', filename: 'woo.csv', sheet: supplier,
          selection: { confirmed: true, inventoryColumn: 2, dropThresholdPercent: 100, increaseThresholdPercent: 100_000 } }]);
        const anomalies: Record<string, string> = { 'broken-parent': 'invalid-woo-parent', 'duplicate-sku': 'duplicate-sku',
          'duplicate-id': 'duplicate-woo-id', scientific: 'scientific-sku', 'inherited-stock': 'woo-stock-not-managed', 'retained-sale': 'woo-sale-not-below-regular' };
        if (anomalies[mode]) {
          expect(result.issues).toContainEqual(expect.objectContaining({ code: anomalies[mode], blocking: true }));
          expect(result).toMatchObject({ canDownload: false, updateBytes: null, rollbackBytes: null });
          return;
        }
        expect(result).toMatchObject({ canDownload: true, verification: { checked: true, nonTargetFieldsChanged: 0, brokenVariantGroups: 0 },
          rollbackVerification: { checked: true, restoredVariants: 1 } });
        expect(await inspectImport('woocommerce', baselineBytes, result.updateBytes!)).toMatchObject({ verdict: 'PASS', matchedRows: 1 });
        expect(await inspectImport('woocommerce', baselineBytes, result.rollbackBytes!, result.updateBytes!))
          .toMatchObject({ verdict: 'PASS', rollback: { scope: 'paired-update', residualDiffs: 0 } });
        const matrix = originals.map(row => [...row]);
        for (const [restoring, payload] of [result.updateBytes!, result.rollbackBytes!].entries()) {
          const [header, ...data] = parseCsv(decodeCsv(payload).text).records;
          expect(header.cells).toEqual([...headers.slice(0, 5), 'Stock']);
          expect(data).toHaveLength(1);
          const [{ cells, parseError }] = data;
          expect(parseError).toBeUndefined();
          expect(cells.slice(0, 4)).toEqual(originals[1].slice(0, 4));
          header.cells.forEach((column, index) => { matrix[1][headers.indexOf(column)] = cells[index]; });
          const expected = originals.map(row => [...row]);
          if (!restoring) {
            expected[1][4] = regular;
            expected[1][6] = stock === 4 && mode !== 'backorder' ? '004' : String(stock);
          }
          expect(matrix).toEqual(expected);
        }
      },
    ), { seed: seed + 13, numRuns: 650 });
  }, 15_000);

  it('roundtrips 100 v5 tier recipes and strict portable workspace profiles', () => {
    checkFuzz(fc.property(
      fc.integer({ min: 1, max: 99_999 }), fc.constantFrom('shopify', 'woocommerce'), fc.boolean(),
      (cost, platform, withFx) => {
        const pricingRule = { mode: 'tiered-brackets', brackets: [
          { mode: 'multiplier', upTo: decimal(cost, 2), multiplier: '2.5' },
          { mode: 'percent-markup', upTo: null, markupPercent: '35', fixedFee: '0.01' },
        ] } satisfies PricingRule;
        const profile = createWorkspaceProfile({ version: 1, storeName: 'Store ' + cost, platform, storeCurrency: 'USD', pricingRule });
        if (!profile.ok) throw new Error('Expected valid profile');
        const json = serializeWorkspaceProfile(profile.value);
        expect(parseWorkspaceProfile(bytes(json))).toEqual(profile);
        expect(parseWorkspaceProfile(bytes(json.replace('"version": 1,', '"version": 2, "version": 1,'))).ok).toBe(false);
        const fx = withFx ? { sourceCurrency: 'EUR', storeCurrency: 'USD', fxRate: '1.23' } : undefined;
        const recipe = createSupplierRecipe('Vendor', ['SKU', 'Price'], {
          joinKey: 'sku', skuColumn: 0, priceColumn: 1, confirmed: true, pricingRule: { ...pricingRule, ...(fx ? { fx } : {}) },
        }, null);
        if (!recipe.ok) throw new Error('Expected valid recipe');
        expect(recipe.value.version).toBe(5);
        expect(parseSupplierRecipe(bytes(serializeSupplierRecipe(recipe.value)))).toEqual(recipe);
      },
    ), { seed: seed + 14, numRuns: 100 });
  });
});

describe('M9 deterministic fee, currency split and custody replay', () => {
  it('replays 1,200 exact signed fee reconciliations and blocked cent mutations across both layouts', () => {
    checkFuzz(fc.property(
      fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }), fc.bigInt({ min: -25_000n, max: 25_000n }),
      fc.constantFrom(-1n, 0n, 1n), fc.boolean(),
      (gross, fee, discrepancy, paypal) => {
        const computed = paypal ? gross + fee : gross - fee;
        const received = computed + discrepancy;
        const rawAmounts = [cents(gross), cents(fee), cents(received)];
        const headers = paypal ? ['Date', 'Name', 'Gross', 'Fee', 'Net', 'Currency', 'Transaction ID', 'Balance Impact'] :
          ['created_utc', 'description', 'gross', 'fee', 'net', 'currency', 'balance_transaction_id'];
        const input = csvBytes(headers, [['2026-11-24', 'Splits,\nunchanged', ...rawAmounts, 'USD', 'D1',
          ...(paypal ? [received < 0n ? 'Debit' : 'Credit'] : [])]]);
        for (const stripePayPalOutput of ['accounting', 'quickbooks-3col'] as const) {
          const result = repairCsv(input, 'ledger.csv', 'stripe-paypal', { stripePayPalOutput });
          const blocked = discrepancy !== 0n || (stripePayPalOutput === 'quickbooks-3col' && received === 0n);
          expect(result.canDownload).toBe(!blocked);
          expect(result.rows[0].before.slice(2, 5)).toEqual(rawAmounts);
          if (blocked) {
            expect(result.repairedCsv).toBe('');
            if (discrepancy !== 0n) {
              expect(result.issues).toContainEqual(expect.objectContaining({ code: 'reconciliation-mismatch', row: 2,
                reconciliation: { gross: rawAmounts[0], fee: rawAmounts[1], net: rawAmounts[2], expectedNet: cents(computed),
                  feeConvention: paypal ? 'signed-movement' : 'deduction' },
              }));
            }
            continue;
          }
          const exported = parseCsv(result.repairedCsv);
          expect(exported.records[1].cells).toEqual(stripePayPalOutput === 'accounting'
            ? ['2026-11-24', 'Splits,\nunchanged', ...rawAmounts, 'USD', 'D1'] : ['11/24/2026', 'Splits, unchanged', rawAmounts[2]]);
          expect(result.roundtripCheck).toEqual({ checked: true, autoFixableRemaining: 0, needsManualReviewCount: 0 });
        }
      },
    ), { seed: seed + 17, numRuns: 1200 });
  });

  it('replays 1,200 bank currency groupings through the exact physical lines of both QuickBooks layouts', () => {
    const currency = fc.constantFrom('USD', 'EUR', 'SAR', 'AED', 'GBP');
    checkFuzz(fc.property(
      fc.array(fc.tuple(currency, fc.boolean(), fc.integer({ min: 1, max: 100000 })), { minLength: 1, maxLength: 10 }),
      (transactions) => {
        let line = 2;
        const groups = new Map<string, number[]>();
        const rows = transactions.map(([code, multiline, value], index) => {
          const entry = [index % 2 ? cents(-BigInt(value)) : cents(BigInt(value)), code];
          groups.set(code, [...(groups.get(code) ?? []), line]);
          line += multiline ? 2 : 1;
          return ['2026-11-24', multiline ? 'First\nSecond' : 'One line', ...entry];
        });
        const input = csvBytes(['Date', 'Description', 'Amount', 'Currency'], rows);
        for (const qboLayout of ['3col', '4col'] as const) {
          const result = repairCsv(input, 'bank.csv', 'quickbooks-bank', { qboLayout });
          expect(result.rows.map(({ before }) => before)).toEqual(rows);
          if (groups.size > 1) {
            expect(result.canDownload).toBe(false);
            expect(result.repairedCsv).toBe('');
            expect(result.currencySplit).toEqual([...groups].map(([currency, lines]) => ({ currency, lines })));
            const expectedLines = [...groups.values()].slice(1).flat().sort((a, b) => a - b);
            expect(result.issues.filter(({ code }) => code === 'multi-currency').map(({ row }) => row)).toEqual(expectedLines);
            continue;
          }
          expect(result.canDownload).toBe(true);
          expect(result.currencySplit).toBeUndefined();
          const projected = parseCsv(result.repairedCsv).records.slice(1).map(({ cells }) => cells);
          expect(projected.map((cells) => cells[1])).toEqual(rows.map((row) => row[1].replace('\n', ' ')));
          expect(projected.map((cells) => qboLayout === '3col' ? cells[2] : cells[2] ? '-' + cells[2] : cells[3])).toEqual(rows.map((row) => row[2]));
        }
      },
    ), { seed: seed + 18, numRuns: 1200 });
  });

  it('matches 1,200 independent Node hashes over exact byte views and deterministic verified update and rollback pairs', async () => {
    const sha = (input: Uint8Array) => createHash('sha256').update(input).digest('hex');
    const details = await fc.check(fc.asyncProperty(
      fc.uint8Array({ maxLength: 128 }), fc.integer({ min: 1001, max: 2500 }), fc.boolean(),
      async (raw, supplierPrice, woo) => {
        const backed = Uint8Array.from([0xef, 0xbb, 0xbf, ...raw, 0, 0xff]);
        const view = backed.subarray(3, 3 + raw.byteLength);
        expect(await sha256(view)).toBe(sha(raw));
        expect(await sha256(backed)).toBe(sha(backed));
        const baselineBytes = woo ? csvBytes(['ID', 'Type', 'SKU', 'Parent', 'Regular price', 'Name'], [['1', 'simple', '001', '', '10.000', 'Original name']]) :
          csvBytes(['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Tags'],
            [['product', 'Original name', 'Title', 'Default Title', '001', '10.000', 'metadata']]);
        const baseline = woo ? parseWooCommerceBaseline(baselineBytes) : parseBaseline(baselineBytes);
        const supplier = parseSupplier(csvBytes(['SKU', 'Price'], [['001', cents(BigInt(supplierPrice))]]), 'supplier.csv');
        const compare = () => buildPriceDiff(baseline, supplier.sheets[0], { confirmed: true });
        const result = compare();
        expect(result.canDownload, JSON.stringify(result.issues)).toBe(true);
        expect(result.verification.nonTargetFieldsChanged).toBe(0);
        const platform = woo ? 'woocommerce' : 'shopify';
        expect(await inspectImport(platform, baselineBytes, result.updateBytes!)).toMatchObject({ verdict: 'PASS', changedSkus: 1 });
        expect(await inspectImport(platform, baselineBytes, result.rollbackBytes!, result.updateBytes!))
          .toMatchObject({ verdict: 'PASS', rollback: { scope: 'paired-update', residualDiffs: 0 } });
        for (const key of ['updateBytes', 'rollbackBytes'] as const) {
          const exported = result[key]!;
          expect(await sha256(exported)).toBe(sha(exported));
          expect(await sha256(compare()[key]!)).toBe(sha(exported));
        }
        const rollback = parseCsv(decodeCsv(result.rollbackBytes!).text).records;
        expect(rollback[1].cells[rollback[0].cells.indexOf(woo ? 'Regular price' : 'Variant Price')]).toBe('10.000');
      },
    ), { seed: seed + 19, numRuns: 1200 });
    recordFuzz(details, 1200);
  }, 45_000);
});

it('verifies 420 generated native pairs and rejects independently mutated import bytes', async () => {
  await checkAsyncFuzz(fc.asyncProperty(
    fc.constantFrom('shopify', 'woocommerce'), fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 3101, max: 5000 }),
    fc.integer({ min: 1, max: 1000 }), fc.boolean(),
    fc.constantFrom('forbidden', 'leading-zero', 'scientific', 'missing-sibling-or-parent', 'empty-record',
      'missing-coordinate', 'changed-lexical-value', 'missing-product', 'unsafe-paired-update'),
    async (platform, id, amount, stock, idRef, mutation) => {
      const woo = platform === 'woocommerce';
      const sku = '000' + id;
      const parentId = id * 4;
      const catalog = woo ? csvBytes(['ID', 'Type', 'SKU', 'Parent', 'Regular price', 'Sale price', 'Stock', 'Description'], [
        [String(parentId), 'variable', 'parent-' + id, '', '', '', '', 'Original parent'],
        [String(parentId + 1), 'variation', sku, idRef ? 'id:' + parentId : 'parent-' + id, '030.000', '20.000', "'-003", 'Original variation'],
        [String(parentId + 2), 'variation', 'sibling-' + id, 'parent-' + id, '35.000', '', '8', 'Unchanged sibling'],
        [String(parentId + 3), 'simple', 'other-' + id, '', '40.000', '10.000', '3', 'Original separate product'],
      ]) : csvBytes(['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Variant Compare At Price', 'Variant Inventory Qty', 'Tags'], [
        ['product-' + id, 'Exact Title, includes\nline break', 'Color', 'Red', sku, '030.000', '', '-003', 'Original product'],
        ['product-' + id, '', '', 'Blue', 'sibling-' + id, '30.000', '40.000', '', ''],
        ['separate-' + id, 'Separate product', 'Title', 'Default Title', 'other-' + id, '40.000', '60.000', '3', 'Preserved metadata'],
      ]);
      const baseline = woo ? parseWooCommerceBaseline(catalog) : parseBaseline(catalog);
      const offers = csvBytes(['SKU', 'Price', 'Sale or compare', 'Stock'], [
        [sku, (amount / 100).toFixed(2), woo ? '18.05' : '75.55', String(stock)],
        ['other-' + id, '45.00', woo ? '10.000' : '60.000', '3'],
      ]);
      const supplier = parseSupplier(offers, 'offers.csv').sheets[0];
      const { canDownload, issues, updateBytes, rollbackBytes } = buildPriceDiff(baseline, supplier,
        { confirmed: true, skuColumn: 0, priceColumn: 1, compareAtColumn: 2, inventoryColumn: 3 });
      expect(canDownload, JSON.stringify(issues)).toBe(true);
      expect(await inspectImport(platform, catalog, updateBytes!)).toMatchObject({ verdict: 'PASS', changedSkus: 2, nonTargetMutations: 0, brokenGroups: 0 });
      expect(await inspectImport(platform, catalog, rollbackBytes!, updateBytes!)).toMatchObject({
        verdict: 'PASS', rollback: { scope: 'paired-update', residualDiffs: 0, restored: true },
      });

      const pairMutation = ['missing-coordinate', 'changed-lexical-value', 'missing-product', 'unsafe-paired-update'].includes(mutation);
      const original = pairMutation && mutation !== 'unsafe-paired-update' ? rollbackBytes! : updateBytes!;
      const [header, ...body] = parseCsv(decodeCsv(original).text).records.map(({ cells }) => cells);
      const skuOffset = header.indexOf(woo ? 'SKU' : 'Variant SKU');
      if (mutation === 'forbidden' || mutation === 'unsafe-paired-update') {
        header.push(woo ? 'Meta:danger' : 'Body (HTML)');
        body.forEach((row) => row.push(''));
      } else if (mutation === 'leading-zero') {
        body[0][skuOffset] = String(id);
      } else if (mutation === 'scientific') {
        body[0][skuOffset] = '1.23E+9';
      } else if (mutation === 'missing-sibling-or-parent') {
        if (woo) body[0][header.indexOf('Parent')] = 'id:999999';
        else body.splice(1, 1);
      } else if (mutation === 'empty-record') {
        body.push(header.map(() => ''));
      } else if (mutation === 'missing-coordinate') {
        const offset = header.indexOf(woo ? 'Stock' : 'Variant Inventory Qty');
        header.splice(offset, 1);
        body.forEach((row) => row.splice(offset, 1));
      } else if (mutation === 'changed-lexical-value') {
        body[0][header.indexOf(woo ? 'Regular price' : 'Variant Price')] = '30';
      } else {
        body.pop();
      }
      const tampered = csvBytes(header, body);
      const result = mutation === 'unsafe-paired-update' ? await inspectImport(platform, catalog, rollbackBytes!, tampered) :
        await inspectImport(platform, catalog, tampered, pairMutation ? updateBytes! : undefined);
      expect(result.verdict, JSON.stringify(result.issues)).toBe('FAIL_UNSAFE');
      expect(result.rollback.restored).toBe(false);
      if (pairMutation && mutation !== 'unsafe-paired-update') expect(result.rollback.residualDiffs).toBe(1);
    },
  ), { seed: seed + 20, numRuns: 420 });
}, 45_000);

it('replays 760 Shopify Markets pairs on the selected price list and rejects cross-market and unsafe compare-at files', async () => {
  await checkAsyncFuzz(fc.asyncProperty(
    fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 30, max: 70 }), fc.integer({ min: 1, max: 20 }),
    fc.constantFrom('UAE', 'European Union', 'Émirats arabes unis', 'United Kingdom'), fc.boolean(), fc.boolean(),
    async (id, amount, increase, market, mapCompare, inheritSibling) => {
      const sku = '000' + id;
      const target = 'Price / ' + market;
      const compare = 'Compare At Price / ' + market;
      const headers = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price',
        target, compare, 'Price / Secondary', 'Compare At Price / Secondary', 'Included / ' + market, 'Body (HTML)', 'Tags', 'Image Src', 'Variant Inventory Qty'];
      const originals = [
        ['product-' + id, 'Exact title,\nwith newline', 'Color', 'Red', sku, '052.000', '0' + amount + '.000', String(amount + 22),
          '099.500', '115.000', 'true', '<p>Original</p>', 'Keep, exact', '', '12'],
        ['product-' + id, '', '', 'Blue', 'sibling-' + id, '053.000', inheritSibling ? '' : '034.000', inheritSibling ? '' : '45.50',
          '098.500', '115.100', 'true', '', '', '', '15'],
        ['other-' + id, 'Other', 'Title', 'Default Title', 'other-' + id, '54.000', '035.000', '45.50',
          '097.500', '115.200', 'false', '', '', 'https://example.test/photo.png', '16'],
      ];
      const originalBytes = csvBytes(headers, originals);
      const inputs = parseSupplier(csvBytes(['SKU', 'Price', 'Compare At Price'], [[sku, String(amount + increase), String(amount + 30)]]), 'offers.csv').sheets[0];
      const result = buildPriceDiff(parseBaseline(originalBytes), inputs, { confirmed: true, market, compareAtColumn: mapCompare ? 2 : null });
      expect(result.canDownload, JSON.stringify(result.issues)).toBe(true);
      expect(result.rollbackVerification).toEqual({ checked: true, restoredVariants: 2 });
      const update = result.updateBytes!;
      expect(await inspectImport('shopify', originalBytes, update)).toMatchObject({ verdict: 'PASS', changedSkus: 1, nonTargetMutations: 0, brokenGroups: 0 });
      expect(await inspectImport('shopify', originalBytes, result.rollbackBytes!, update)).toMatchObject({ verdict: 'PASS', rollback: { residualDiffs: 0 } });
      const matrix = originals.map(row => [...row]);
      for (const [restoring, payload] of [update, result.rollbackBytes!].entries()) {
        const [columns, ...rows] = parseCsv(decodeCsv(payload).text).records.map(({ cells }) => cells);
        expect(columns).toEqual([...headers.slice(0, 5), target, ...(mapCompare ? [compare] : [])]);
        expect(rows).toHaveLength(2);
        for (const [index, row] of rows.entries()) {
          expect(row.slice(0, 5)).toEqual(originals[index].slice(0, 5));
          for (const [offset, column] of columns.entries()) matrix[index][headers.indexOf(column)] = row[offset];
        }
        const expected = originals.map(row => [...row]);
        if (!restoring) {
          expected[0][6] = String(amount + increase);
          if (mapCompare) expected[0][7] = String(amount + 30);
        }
        expect(matrix).toEqual(expected);
      }
      const [columns, ...data] = parseCsv(decodeCsv(update).text).records.map(({ cells }) => cells);
      if (id % 2 === 0) {
        columns.push('Price / Secondary');
        for (const row of data) row.push('77.50');
      } else {
        data[0][columns.indexOf(target)] = mapCompare ? String(amount + 30) : String(amount + 22);
      }
      expect(await inspectImport('shopify', originalBytes, csvBytes(columns, data))).toMatchObject({ verdict: 'FAIL_UNSAFE' });
    },
  ), { seed: seed + 21, numRuns: 760 });
}, 45_000);

it('replays 760 BigCommerce pairs through Product and SKU identities, and rejects unsafe read-only prices and blank stock restoration', async () => {
  await checkAsyncFuzz(fc.asyncProperty(
    fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 30, max: 70 }), fc.integer({ min: 1, max: 59 }),
    fc.integer({ min: 0, max: 999 }), fc.boolean(), fc.boolean(),
    async (id, price, increase, stock, mapSale, useAlias) => {
      const sku = '001' + id;
      const child = '002' + id;
      const stockHeader = useAlias ? 'Current Stock Level' : 'Stock Level';
      const headers = ['Item Type', 'Product ID', 'Product Name', 'Product Code/SKU', 'Price', 'Sale Price', stockHeader,
        'Track Inventory', 'Product Description', 'Category', 'Product Image File - 1', 'Meta Keywords'];
      const originals = [
        ['Product', String(id * 5), 'Simple, "original"', sku, '0' + price + '.000', String(price - 5), '0' + stock,
          'by product', '<p>Keep</p>', 'Category', 'sample.jpg', 'Metadata'],
        ['Product', String(id * 5 + 1), 'Grouped product', 'group-' + id, '040.000', '', '', 'by option', 'Keep', 'Category', 'group.jpg', 'Keep'],
        ['SKU', '00' + (id * 5 + 2), '[RB]Color=Red,[S]Size=Small', child, '040.000', '', '0' + stock, '', '', '', '', ''],
        ['SKU', '00' + (id * 5 + 3), '[RB]Color=Blue,[S]Size=Small', 'sibling-' + id, '', '', '5', '', '', '', '', ''],
        ['Product', String(id * 5 + 4), 'Separate product', 'other-' + id, '50.000', '40', '8', 'by product', 'Keep', 'Other', 'other.jpg', 'Keep'],
      ];
      const originalBytes = csvBytes(headers, originals);
      const sheet = parseSupplier(csvBytes(['SKU', 'Price', 'Sale Price', 'Stock'], [[sku, String(price + increase), String(price - 4), String(stock + 1)],
        [child, '', '', String(stock + 2)]]), 'offers.csv').sheets[0];
      const result = buildPriceDiff(parseBigCommerceBaseline(originalBytes), sheet, { confirmed: true, compareAtColumn: mapSale ? 2 : null, inventoryColumn: 3 });
      expect(result.canDownload, JSON.stringify(result.issues)).toBe(true);
      const update = result.updateBytes!;
      const rollback = result.rollbackBytes!;
      expect(await inspectImport('bigcommerce', originalBytes, update)).toMatchObject({ verdict: 'PASS', changedSkus: 2, nonTargetMutations: 0, brokenGroups: 0 });
      expect(await inspectImport('bigcommerce', originalBytes, rollback, update)).toMatchObject({ verdict: 'PASS', rollback: { residualDiffs: 0 } });
      const matrix = originals.map(row => [...row]);
      for (const [restoring, payload] of [update, rollback].entries()) {
        const [columns, ...rows] = parseCsv(decodeCsv(payload).text).records.map(({ cells }) => cells);
        expect(columns).toEqual([...headers.slice(0, 5), ...(mapSale ? ['Sale Price'] : []), stockHeader]);
        expect(rows).toHaveLength(4);
        for (const [index, row] of rows.entries()) {
          expect(row.slice(0, 4)).toEqual(originals[index].slice(0, 4));
          for (const [offset, column] of columns.entries()) if (row[offset] !== '') matrix[index][headers.indexOf(column)] = row[offset];
        }
        const expected = originals.map(row => [...row]);
        if (!restoring) {
          expected[0][4] = String(price + increase);
          if (mapSale) expected[0][5] = String(price - 4);
          expected[0][6] = String(stock + 1);
          expected[2][6] = String(stock + 2);
        }
        expect(matrix).toEqual(expected);
      }
      if (id % 2 === 0) {
        const [columns, ...rows] = parseCsv(decodeCsv(update).text).records.map(({ cells }) => cells);
        rows[2][columns.indexOf('Price')] = '100.00';
        expect(await inspectImport('bigcommerce', originalBytes, csvBytes(columns, rows))).toMatchObject({ verdict: 'FAIL_UNSAFE', nonTargetMutations: 1 });
      } else {
        const [columns, ...rows] = parseCsv(decodeCsv(rollback).text).records.map(({ cells }) => cells);
        rows[2][columns.indexOf(stockHeader)] = '';
        expect(await inspectImport('bigcommerce', originalBytes, csvBytes(columns, rows), update))
          .toMatchObject({ verdict: 'FAIL_UNSAFE', rollback: { residualDiffs: 1 } });
      }
    },
  ), { seed: seed + 22, numRuns: 760 });
}, 45_000);

it.each(['shopify', 'woocommerce', 'bigcommerce'] as const)('replays 1,020 %s promo pairs and independently checks floor, scope and custody', async (platform) => {
  const shop = platform === 'shopify';
  const woo = platform === 'woocommerce';
  const big = platform === 'bigcommerce';
  await checkAsyncFuzz(fc.asyncProperty(
    fc.integer({ min: 1, max: 300_000 }), fc.integer({ min: 1_800, max: 450_000 }),
    fc.integer({ min: 10, max: 90 }), fc.integer({ min: 150, max: 900 }), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(),
    fc.constantFrom<PromoCampaignOptions['rule']['rounding']>('none', 'ending-99', 'ending-95', 'nearest-whole'),
    async (id, effectivePrice, percent, fixed, byPercent, hasOriginalSale, preserveHigher, useCurrent, rounding) => {
      const sku = '00' + id;
      const parent = String(id * 3 + 1);
      const handle = 'promo-' + id;
      const saleExists = !shop && (big || hasOriginalSale);
      const money = (value: number) => cents(BigInt(value));
      const original = (value: number) => '0' + money(value) + '0';
      const regular = original(effectivePrice + (saleExists ? 437 : 0));
      const oldSale = saleExists ? original(effectivePrice) : shop && hasOriginalSale ? original(effectivePrice + 741) : '';
      const shopIdentity = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU'];
      const sourceIdentity = useCurrent ? ['URL handle', 'Title', 'Option1 name', 'Option1 value', 'SKU'] : shopIdentity;
      const wooIdentity = ['ID', 'Type', 'SKU', 'Parent'];
      const bigIdentity = ['Item Type', 'Product ID', 'Product Name', useCurrent ? 'Product SKU' : 'Product Code/SKU'];
      const headers = shop ? [...sourceIdentity, useCurrent ? 'Price' : 'Variant Price', useCurrent ? 'Compare-at price' : 'Variant Compare At Price',
        'Tags', 'Description', 'Image Src', 'Price / UAE'] : woo ? [...wooIdentity, 'Regular price', 'Sale price', 'Description', 'Meta:example'] :
        [...bigIdentity, 'Price', 'Sale Price', 'Option Set', 'Product Description', 'Category'];
      const originals = shop ? [
        [handle, 'Exact title, "quoted"\r\nnext line', 'Color', 'Red', sku, regular, oldSale, 'Promo, Ramadan', '<p>Keep</p>', '', '89.00'],
        [handle, '', '', 'Blue', 'sibling-' + id, '070.088', '090.000', '', '', '', '090.0'],
        [handle, '', '', '', '', '', '', '', '', 'https://example.invalid/image.png', ''],
        ['unrelated-' + id, 'Other product', 'Title', 'Default Title', 'other-' + id, '087.000', '', 'Other', 'Keep', '', '093.00'],
      ] : woo ? [
        [parent, 'variable', 'parent-' + id, '', '', '', 'Parent,\n keep', '01'],
        [String(id * 3 + 2), 'variation', sku, useCurrent ? 'id:' + parent : 'parent-' + id, regular, oldSale, '<b>Keep</b>', '00002'],
        [String(id * 3 + 3), 'variation', 'sibling-' + id, 'id:' + parent, '070.088', '', 'Unchanged', '03'],
      ] : [
        ['Product', '00' + id, 'Exact "original", product', sku, regular, oldSale, '', 'Unchanged', 'Original category'],
        ['Product', '00' + (id + 1), 'Grouped product', 'group-' + id, '073.450', '043.000', 'Colors', 'Original product', 'Original category'],
        ['SKU', '00' + (id + 2), '[RB]Color=Red', 'other-' + id, '050.000', '', '', '', ''],
      ];
      const originalBytes = csvBytes(headers, originals);
      const baseline = Uint8Array.from([0, ...originalBytes, 0xff]).subarray(1, originalBytes.length + 1);
      const settings: PromoCampaignOptions['rule'] = {
        mode: byPercent ? 'percent-off' : 'fixed-amount-off', amount: byPercent ? String(percent) : money(fixed),
        rounding, minimumRetail: '0.01', preserveHigherCompareAt: preserveHigher,
      };
      const scope: PromoCampaignOptions['scope'] = shop ? { skus: [sku], handle, tag: 'Ramadan' } : { skuPrefix: sku };
      const pack = await buildPromoCampaign(platform, baseline, { rule: settings, scope, storeLabel: 'Exact Store' });
      expect(pack.canExport, JSON.stringify(pack.issues)).toBe(true);

      // Independent cent arithmetic with an exact denominator of 100.
      const subtotal = byPercent ? effectivePrice * (100 - percent) : (effectivePrice - fixed) * 100;
      const ending = rounding === 'ending-99' ? 99 : 95;
      const expectedCents = rounding === 'none' ? Math.floor((subtotal + 50) / 100) : rounding === 'nearest-whole' ?
        100 * Math.floor((subtotal + 5000) / 10000) : 100 * Math.ceil((subtotal - 100 * ending) / 10_000) + ending;
      const launch = bytes(pack.launchCsv!);
      const revert = bytes(pack.revertCsv!);
      const targetIndex = woo ? 1 : 0;
      const firstTarget = shop ? 5 : 4;
      const originalSaleColumn = shop ? 6 : 5;
      const targetColumns = shop ? ['Variant Price', 'Variant Compare At Price'] : [woo ? 'Sale price' : 'Sale Price'];
      const identity = shop ? shopIdentity : woo ? wooIdentity : bigIdentity;
      const catalog = originals.map(row => [...row]);
      const proposed = originals.map(row => [...row]);
      proposed[targetIndex][shop ? firstTarget : originalSaleColumn] = money(expectedCents);
      if (shop) proposed[targetIndex][originalSaleColumn] = preserveHigher && oldSale ? oldSale : regular;
      for (const [restoring, payload] of [launch, revert].entries()) {
        const [columns, ...rows] = parseCsv(decodeCsv(payload).text).records.map(({ cells }) => cells);
        expect(columns).toEqual([...identity, ...targetColumns]);
        expect(rows).toHaveLength(shop ? 2 : 1);
        for (const [offset, row] of rows.entries()) {
          const catalogIndex = targetIndex + offset;
          expect(row.slice(0, identity.length)).toEqual(originals[catalogIndex].slice(0, identity.length));
          if (shop) catalog[catalogIndex][firstTarget] = row[identity.length];
          const sale = row.at(-1)!;
          if (!big || sale !== '') catalog[catalogIndex][originalSaleColumn] = sale;
        }
        expect(catalog).toEqual(restoring ? originals : proposed);
      }
      const audit = JSON.parse(pack.auditJson);
      const independentSha = (input: Uint8Array) => createHash('sha256').update(input).digest('hex');
      expect(pack.custody).toEqual({ baselineSha256: independentSha(baseline), launchSha256: independentSha(launch), revertSha256: independentSha(revert) });
      expect(audit.custody).toEqual(pack.custody);
      expect(audit.verification).toMatchObject({ restored: true, residualDiffs: 0, nonTargetMutations: 0 });
      expect(pack.signoffHtml).toContain(pack.custody.launchSha256!);
      expect(pack.signoffHtml).toContain(pack.custody.revertSha256!);

      const minimumRetail = money(expectedCents) + '1';
      const blocked = await buildPromoCampaign(platform, baseline, { rule: { ...settings, minimumRetail }, scope });
      expect(blocked).toMatchObject({ canExport: false, launchCsv: null, revertCsv: null, signoffHtml: null,
        custody: { baselineSha256: independentSha(baseline), launchSha256: null, revertSha256: null } });
      expect(blocked.rows[targetIndex]).toMatchObject({ status: 'held', promoPrice: money(expectedCents), minimumRetail,
        issues: [{ code: 'minimum-retail-breach', severity: 'hold' }] });
    },
  ), { seed: seed + (shop ? 23 : woo ? 24 : 25), numRuns: 1020 });
}, 60_000);

it('replays 2,000 workbook selections with exact worksheet names, leading zeros and sparse lines', () => {
  const book = readFileSync(new URL('../../../fixtures/supplier-delta/synthetic-pricebook.xlsx', import.meta.url));
  const entries = unzipSync(book);
  const metaPath = 'xl/workbook.xml';
  const previousPath = 'xl/worksheets/sheet3.xml';
  const currentPath = 'xl/worksheets/sheet2.xml';
  const metadata = strFromU8(entries[metaPath]);
  const previous = strFromU8(entries[previousPath]);
  const current = strFromU8(entries[currentPath]);
  checkFuzz(fc.property(
    fc.integer({ min: 0, max: 999_999 }),
    fc.integer({ min: 11, max: 1_048_576 }),
    fc.record({ swapped: fc.boolean(), malformedOther: fc.boolean(), hideFirst: fc.boolean(), paddedName: fc.boolean() }),
    (suffix, line, variation) => {
      const exactName = variation.paddedName ? ' Q4 Prices ' : 'Q4 Prices';
      const exactSku = '00' + suffix + '-BLK';
      let sheetList = metadata.replace('Q4_Prices', exactName);
      if (variation.swapped) sheetList = sheetList.replace(/(<sheet name=" Q4 Prices "|<sheet name="Q4 Prices")([^>]+>)(<sheet name="Q3_Prices"[^>]+>)/,
        (_, start: string, end: string, earlier: string) => earlier + start + end);
      if (variation.hideFirst) sheetList = sheetList.replace('name="Instructions"', 'name="Instructions" state="hidden"');
      const bytes = zipSync({ ...entries, [metaPath]: strToU8(sheetList),
        [currentPath]: strToU8(current.replace('00123', exactSku).replace(/(r="[A-C]?)10"/g, (_, start: string) => start + line + '"')),
        [previousPath]: strToU8(variation.malformedOther ? '<worksheet>' : previous),
      }, { mtime: new Date(2026, 0, 1) });
      expect(listWorkbookSheets(bytes)).toEqual([...(variation.hideFirst ? [] : ['Instructions']),
        ...(variation.swapped ? ['Q3_Prices', exactName] : [exactName, 'Q3_Prices'])]);
      const selected = parseSupplier(bytes, 'book.xlsx', { sheetName: exactName });
      expect(selected.issues).toEqual([]);
      expect(selected.sheets[0].rows[0].cells[0]).toMatchObject({ value: exactSku, kind: 'text' });
      expect(selected.sheets[0].rows[3].line).toBe(line);
      expect(parseSupplier(bytes, 'book.xlsx', { sheetName: exactName.toLowerCase() }).issues[0].code).toBe('missing-worksheet');
    },
  ), { seed: seed + 26, numRuns: 2_000 });
}, 60_000);

it('replays 1,800 exact Supplier Delta cases with added, removed and blocked physical lines', async () => {
  const fromMills = (units: bigint): string => (units / 1000n).toString() + '.' + (units % 1000n).toString().padStart(3, '0');
  const source = (rows: string[][], filename: string) => ({ bytes: csvBytes(['SKU', 'Cost', 'Inventory', 'Description'], rows), filename });
  await checkAsyncFuzz(fc.asyncProperty(
    fc.bigInt({ min: 0n, max: 999_999_999_999_999_999n }),
    fc.bigInt({ min: 0n, max: 999_999_999_999_999_999n }),
    fc.integer({ min: 0, max: 999_999 }),
    fc.constantFrom('ready', 'duplicate-previous', 'duplicate-next', 'invalid-cost', 'same', 'zero'),
    async (first, second, suffix, mode) => {
      const sku = '00' + suffix;
      const oldMills = mode === 'zero' ? 0n : first;
      const newMills = mode === 'same' ? oldMills : second;
      const before = [sku, fromMills(oldMills), '50', 'quoted,\r\nphysical'];
      const after = [sku, mode === 'invalid-cost' ? '1e4' : fromMills(newMills), '51', 'quoted,\r\nphysical'];
      const previous = source([before, ['REMOVED-' + suffix, '1.000', '10', ''], ...(mode === 'duplicate-previous' ? [before] : [])], 'previous.csv');
      const next = source([after, ['ADDED-' + suffix, '0.000', '0', ''], ...(mode === 'duplicate-next' ? [after] : [])], 'next.csv');
      const report = await buildSupplierDelta(previous, next);
      expect(report.counts['added-sku']).toBe(1);
      expect(report.counts['removed-sku']).toBe(1);
      expect(report.rows[0].sku).toBe(sku);
      if (mode === 'duplicate-previous' || mode === 'duplicate-next' || mode === 'invalid-cost') {
        expect(report).toMatchObject({ status: 'blocked', deltaCsv: null, signOffHtml: null });
        expect(report.issues).toContainEqual(expect.objectContaining(mode === 'invalid-cost'
          ? { code: 'blocked-invalid-cost', side: 'next', rows: [2] }
          : { code: 'blocked-duplicate-sku', side: mode === 'duplicate-previous' ? 'previous' : 'next', rows: [2, 5] }));
        expect(Object.keys(report.custody)).toEqual(['previousSha256', 'newSha256']);
        return;
      }
      expect(report.status).toBe('ready');
      const difference = newMills - oldMills;
      const row = report.rows[0];
      expect(row.inventoryDelta).toBe('1');
      expect(row.status).toBe(difference === 0n ? 'unchanged' : difference > 0n ? 'cost-increased' : 'cost-decreased');
      const magnitude = difference < 0n ? -difference : difference;
      const fraction = (magnitude % 1000n).toString().padStart(3, '0').replace(/0$/, '');
      const sign = difference < 0n ? '-' : difference > 0n ? '+' : '';
      expect(row.delta).toBe(sign + (magnitude / 1000n).toString() + '.' + fraction);
      const rounded = oldMills === 0n ? null : (magnitude * 10_000n + oldMills / 2n) / oldMills;
      expect(row.deltaPercent).toBe(rounded === null ? newMills === 0n ? '0.00' : null :
        sign + (rounded / 100n).toString() + '.' + (rounded % 100n).toString().padStart(2, '0'));
      const csv = parseCsv(report.deltaCsv!);
      expect(csv.records.map((record) => record.cells[0])).toEqual(['SKU', sku, 'REMOVED-' + suffix, 'ADDED-' + suffix]);
      expect(report.custody.deltaCsvSha256).toBe(createHash('sha256').update(report.deltaCsv!).digest('hex'));
      expect(report.custody.signOffHtmlSha256).toBe(createHash('sha256').update(report.signOffHtml!).digest('hex'));
    },
  ), { seed: seed + 27, numRuns: 1_800 });
}, 60_000);

it('replays 1,200 version 1–6 recipe cases across exact worksheet mappings', () => {
  const workbook = readFileSync(new URL('../../../fixtures/supplier-delta/synthetic-pricebook.xlsx', import.meta.url));
  const selected = parseSupplier(workbook, 'book.xlsx', { sheetName: 'Q4_Prices' });
  const headers = selected.sheets[0].headers;
  checkFuzz(fc.property(
    fc.integer({ min: 1, max: 6 }),
    fc.integer({ min: 1, max: 999_999 }),
    fc.integer({ min: 0, max: 100 }),
    (version, label, threshold) => {
      const fx = { sourceCurrency: 'USD', storeCurrency: 'CAD', fxRate: '1.25' };
      let pricingRule: PricingRule | undefined;
      if (version === 2) pricingRule = { mode: 'multiplier', multiplier: '2' };
      if (version === 3 || version === 4) pricingRule = { mode: 'direct', fx };
      if (version === 5 || version === 6) pricingRule = {
        mode: 'tiered-brackets', fx, brackets: [{ mode: 'multiplier', multiplier: '3', upTo: '33.5' },
          { mode: 'multiplier', multiplier: '2', upTo: null }],
      };
      const created = createSupplierRecipe('Synthetic ' + label, headers, {
        confirmed: true, joinKey: 'sku', skuColumn: 0, priceColumn: 1, pricingRule, dropThresholdPercent: threshold,
        ...(version >= 4 ? { inventoryColumn: 2, inventoryDropThresholdPercent: threshold } : {}),
      }, 'Q4_Prices', undefined, version === 6 ? { selectedSheet: 'Q4_Prices' } : undefined);
      if (!created.ok) throw new Error(JSON.stringify(created));
      expect(created.value.version).toBe(version);
      const read = parseSupplierRecipe(bytes(serializeSupplierRecipe(created.value)));
      expect(read).toEqual(created);
      expect(applySupplierRecipe(created.value, selected, 0)).toMatchObject({ ok: true, value: { sheetIndex: 0, selection: {
        confirmed: false, skuColumn: 0, priceColumn: 1, dropThresholdPercent: threshold,
        ...(version >= 4 ? { inventoryColumn: 2 } : {}),
      } } });
    },
  ), { seed: seed + 28, numRuns: 1_200 });
}, 60_000);

const catalogPlatforms: CatalogPlatform[] = ['shopify', 'woocommerce', 'bigcommerce'];
const catalogDirections = catalogPlatforms.flatMap(source => catalogPlatforms.filter(target => source !== target).map(target => [source, target] as const));
const catalogParsers = { shopify: readShopify, woocommerce: readWooCommerceCatalog, bigcommerce: readBigCommerce };
const catalogDamage = ['corrupt-price', 'inverted-price', 'duplicate-sku', 'formula-sku', 'orphan'] as const;
type CatalogDamage = typeof catalogDamage[number];

function generatedCatalog(platform: CatalogPlatform, suffix: number, regular: string, sale: string, secondPrice: string, quantity: string,
  color: string, damage?: CatalogDamage): Uint8Array {
  const slug = 'canvas-' + suffix;
  const title = 'Canvas, limited "' + suffix + '"';
  const sku = '00' + suffix + '-A';
  const alternate = damage === 'duplicate-sku' ? sku.toLowerCase() : damage === 'formula-sku' ? ' =2+2' : '00' + suffix + '-B';
  const first = damage === 'corrupt-price' ? '1e2' : regular;
  const discount = damage === 'inverted-price' ? regular : sale;
  if (platform === 'shopify') {
    return csvBytes(['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Variant SKU', 'Variant Price',
      'Variant Compare At Price', 'Variant Inventory Tracker', 'Variant Inventory Qty', 'Variant Requires Shipping', 'Published', 'Status', 'Memo'], [
      [slug, title, 'Color', color, 'Size', 'Small', sku, discount || first, first, 'shopify', quantity, 'FALSE', 'TRUE', 'active', 'Line one\nline two'],
      [damage === 'orphan' ? 'unknown' : slug, '', '', 'Natural', '', 'Small', alternate, secondPrice, '', 'shopify', '0', 'FALSE', '', '', ''],
    ]);
  }
  if (platform === 'woocommerce') {
    return csvBytes(['ID', 'SKU', 'Name', 'Type', 'Parent', 'Regular price', 'Sale price', 'Stock', 'Attribute 1 name', 'Attribute 1 value(s)',
      'Attribute 2 name', 'Attribute 2 value(s)', 'Published', 'Visibility in catalog', 'Memo'], [
      ['51', slug, title, 'variable', '', '', '', '', 'Color', color.replace(/,/g, '\\,') + ', Natural', 'Size', 'Small', '1', 'visible', 'Line one\nline two'],
      ['52', sku, title, 'variation, virtual', 'id:51', first, discount, quantity, 'Color', color.replace(/,/g, '\\,'), 'Size', 'Small', '1', '', ''],
      ['53', alternate, title, 'variation, virtual', damage === 'orphan' ? 'id:99' : slug, secondPrice, '', '0', 'Color', 'Natural', 'Size', 'Small', '1', '', ''],
    ]);
  }
  const base = ['Product', '100', 'digital', title, slug, '', regular, '', '', 'variant', 'true', '/' + slug + '/', 'Line one\nline two'];
  const variants = [
    ['Variant', '101', '', '', sku, 'Type=Dropdown|Name=Color|Value=' + color + '\nType=Dropdown|Name=Size|Value=Small', first, discount, quantity, '', '', '', ''],
    ['Variant', '102', '', '', alternate, 'Type=Dropdown|Name=Color|Value=Natural\nType=Dropdown|Name=Size|Value=Small', secondPrice, '', '0', '', '', '', ''],
  ];
  return csvBytes(['Item', 'ID', 'Type', 'Name', 'SKU', 'Options', 'Price', 'Sale Price', 'Current Stock', 'Inventory Tracking', 'Is Visible',
    'Product URL', 'Memo'], damage === 'orphan' ? [variants[0], base, variants[1]] : [base, ...variants]);
}

const catalogIdentity = (platform: CatalogPlatform, input: Uint8Array) =>
  catalogParsers[platform](input, 'fuzz.csv').products.map(product => ({
    title: product.title, grouped: product.grouped, variants: product.variants.map(variant => ({
      sku: variant.sku, price: variant.prices, stock: variant.stock, shipping: variant.shipping,
      options: variant.options.map(({ name, value }) => [name, value]),
    })),
  }));

describe('M14 catalog migration', () => {
  const baseCents = fc.bigInt({ min: 200n, max: 99_999_999n });
  const discountedCents = fc.bigInt({ min: 0n, max: 199n });
  const labels = fc.constantFrom('Indigo', 'Ink, storm', '青色', 'أزرق', 'Gris "Pierre"');
  const suffixes = fc.nat({ max: 1_000_000_000 });
  for (const [index, [source, target]] of catalogDirections.entries()) {
    it('replays 350 exact ' + source + ' → ' + target + ' → ' + source + ' catalogs', async () => {
      await checkAsyncFuzz(fc.asyncProperty(suffixes, baseCents, discountedCents, baseCents, fc.nat({ max: 9_999 }), labels,
        async (suffix, base, discounted, second, qty, color) => {
          const original = generatedCatalog(source, suffix, cents(base), cents(discounted), cents(second), String(qty).padStart(5, '0'), color);
          const first = await buildCatalogMigration(source, target, original);
          const output = first.artifacts.targetCsv?.bytes;
          expect(first.issues.filter(issue => issue.level === 'blocked')).toEqual([]);
          expect(first.unmappedColumns).toContain('Memo');
          expect(first.summary).toEqual({ sourceProducts: 1, sourceVariants: 2, targetProducts: 1, targetVariants: 2, variantParity: true });
          const expected = catalogIdentity(source, original);
          expect(catalogIdentity(target, output!)).toEqual(expected);
          const returned = await buildCatalogMigration(target, source, output!);
          expect(returned.issues.filter(issue => issue.level === 'blocked')).toEqual([]);
          expect(catalogIdentity(source, returned.artifacts.targetCsv!.bytes)).toEqual(expected);
        }), { seed: seed + 29 + index, numRuns: 350 });
    }, 60_000);

    it('holds 70 adversarial ' + source + ' → ' + target + ' catalogs without issuing a target hash', async () => {
      await checkAsyncFuzz(fc.asyncProperty(suffixes, baseCents, discountedCents, labels, fc.constantFrom(...catalogDamage),
        async (suffix, base, discounted, color, damage) => {
          const original = generatedCatalog(source, suffix, cents(base), cents(discounted), '23.47', '7', color, damage);
          const result = await buildCatalogMigration(source, target, original);
          expect(result.preview).toBeNull();
          expect(result.artifacts.targetCsv).toBeNull();
          expect(result.custody.targetSha256).toBeUndefined();
          expect(result.custody.sourceSha256).toBe(createHash('sha256').update(original).digest('hex'));
          const priceLine = source === 'shopify' ? 2 : 4;
          const secondLine = source === 'shopify' ? 4 : source === 'woocommerce' ? 5 : 6;
          const expectedIssue = damage === 'corrupt-price' ? { code: 'invalid-price', line: priceLine } :
            damage === 'inverted-price' ? { code: 'inverted-price', line: priceLine } :
              damage === 'duplicate-sku' ? { code: 'duplicate-sku', line: secondLine } :
                damage === 'formula-sku' ? { code: 'unsafe-sku', line: secondLine } :
                  source === 'shopify' ? { code: 'unsafe-title', line: secondLine } :
                    source === 'woocommerce' ? { code: 'orphan-variation', line: secondLine } : { code: 'orphan-catalog-row', line: 2 };
          expect(result.issues).toContainEqual(expect.objectContaining({ ...expectedIssue, level: 'blocked' }));
        }), { seed: seed + 35 + index, numRuns: 70 });
    }, 60_000);
  }
});

describe('M15 exact bank and expense repair', () => {
  const movement = fc.bigInt({ min: -999_999n, max: 999_999n }).map((value) => value === 0n ? 1n : value);
  const openingValue = fc.bigInt({ min: -(10n ** 26n), max: 10n ** 26n });

  it('replays 900 Xero sign, chronology, missing movement and cent-tamper cases', () => {
    checkFuzz(fc.property(
      openingValue, fc.array(movement, { minLength: 3, maxLength: 7 }), fc.boolean(),
      fc.constantFrom('valid', 'penny', 'missing', 'date', 'symbols', 'precision'),
      (opening, amounts, descending, mode) => {
        let balance = opening;
        const chronological = amounts.map((amount, index) => {
          balance += amount;
          const sourceAmount = amount < 0n ? index % 2 === 0 ? `(${cents(-amount)})` : `${cents(-amount)}-` : cents(amount);
          return [`2026-05-0${index + 1}`, sourceAmount, index === 0 ? '=display\ncontinued' : 'Record ' + index, cents(balance), `0000${index}`];
        });
        const last = chronological.at(-1)!;
        let affected: string[] | undefined;
        let delta = 0n;
        if (mode === 'penny') {
          last[3] = cents(balance - 1n);
          affected = last;
          delta = -1n;
        } else if (mode === 'missing') {
          chronological.splice(1, 1);
          affected = chronological[1];
          delta = amounts[1];
        } else if (mode === 'date') last[0] = '04/05/2026';
        else if (mode === 'symbols') {
          last[1] = amounts.at(-1)! < 0n ? `(£${cents(-amounts.at(-1)!)})` : '£' + cents(amounts.at(-1)!);
          last[3] = balance < 0n ? '-$' + cents(-balance) : '$' + cents(balance);
        } else if (mode === 'precision') last[3] += '1';

        const ordered = descending ? chronological.slice().reverse() : chronological;
        const source = serializeCsv(['Date', 'Amount', 'Payee', 'Running Balance', 'Reference'], ordered, 'xero-bank');
        const result = repairCsv(bytes(source), 'xero.csv', 'xero-bank', { formulaGuard: false });
        expect(result.balanceChain?.totalLinks).toBe(ordered.length - 1);
        expect(result.balanceChain?.currency).toBeNull();
        if (mode === 'valid') {
          expect(result.canDownload).toBe(true);
          expect(result.balanceChain).toMatchObject({
            status: 'VERIFIED', direction: descending ? 'descending' : 'ascending', openingBalance: cents(opening),
            netMovement: cents(balance - opening), closingBalance: cents(balance), verifiedLinks: ordered.length - 1, breaks: [],
          });
          const output = parseCsv(result.repairedCsv).records;
          expect(output[0].cells).toEqual(['*Date', '*Amount', 'Payee', 'Reference']);
          expect(output.slice(1).map(({ cells }) => cells[1])).toEqual((descending ? amounts.slice().reverse() : amounts).map(cents));
          expect(output.slice(1).map(({ cells }) => cells[3])).toEqual(ordered.map((row) => row[4]));
          expect(output.some(({ cells }) => cells[2] === "'=display\ncontinued")).toBe(true);
        } else {
          expect(result.canDownload).toBe(false);
          expect(result.repairedCsv).toBe('');
          if (affected) {
            const affectedLine = parseCsv(source).records[ordered.indexOf(affected) + 1].line;
            expect(result.balanceChain).toMatchObject({
              status: 'FAIL_BALANCE_BREAK', verifiedLinks: ordered.length - 2,
              breaks: [{ row: affectedLine, delta: cents(delta) }],
            });
          } else {
            expect(result.balanceChain?.status).toBe('UNVERIFIABLE');
            if (mode === 'date') expect(result.issues.some(({ code }) => code === 'date-order-ambiguous')).toBe(true);
            if (mode === 'symbols') expect(result.issues.some(({ code }) => code === 'multi-currency')).toBe(true);
          }
        }
      },
    ), { seed: seed + 41, numRuns: 900 });
  }, 60_000);

  it('replays 850 QuickBooks signed and split cases in both chronological directions', () => {
    checkFuzz(fc.property(
      openingValue, movement, movement, movement, fc.boolean(), fc.boolean(),
      fc.constantFrom('signed', 'bank', 'intuit'), fc.constantFrom('valid', 'flipped', 'duplicate', 'invalid-date', 'invalid-balance', 'mixed'),
      (opening, first, second, third, descending, targetFour, layout, mode) => {
        let balance = opening;
        const canonical = [first, second, third].map((amount, index) => {
          balance += amount;
          return [`2026-05-0${index + 1}`, index === 0 ? 'first\nrecord' : 'line ' + index, cents(amount), cents(balance), 'USD'];
        });
        const affected = canonical[1];
        if (mode === 'flipped') affected[2] = cents(-second);
        if (mode === 'duplicate') canonical.splice(1, 0, affected.slice());
        if (mode === 'invalid-date') affected[0] = '2026-02-30';
        if (mode === 'invalid-balance') affected[3] = '1e30';
        if (mode === 'mixed') affected[4] = 'EUR';
        if (descending) canonical.reverse();
        const isSplit = layout !== 'signed';
        const rows = isSplit ? canonical.map(([date, description, amount, after, currency]) => {
          const negative = amount.startsWith('-');
          const spent = negative ? amount.slice(1) : '';
          const received = negative ? '' : amount;
          return [date, description, ...(layout === 'bank' ? [received, spent] : [spent, received]), after, currency];
        }) : canonical;
        const source = serializeCsv(['Date', 'Description', ...(isSplit ? ['Credit', 'Debit'] : ['Amount']), 'Balance', 'Currency'], rows, 'quickbooks-bank');
        const result = repairCsv(bytes(source), 'bank.csv', 'quickbooks-bank', {
          qboLayout: targetFour ? '4col' : '3col', qboCreditDebit: isSplit ? layout : 'auto',
        });
        expect(result.balanceChain?.totalLinks).toBe(rows.length - 1);
        if (mode === 'valid') {
          expect(result.canDownload).toBe(true);
          expect(result.balanceChain).toMatchObject({
            status: 'VERIFIED', direction: descending ? 'descending' : 'ascending', currency: 'USD',
            openingBalance: cents(opening), netMovement: cents(first + second + third), closingBalance: cents(balance), verifiedLinks: 2,
          });
          const [header, ...output] = parseCsv(result.repairedCsv).records;
          expect(header.cells).toEqual(targetFour ? ['Date', 'Description', 'Credit', 'Debit'] : ['Date', 'Description', 'Amount']);
          expect(output.map(({ cells }) => targetFour ? cells[2] ? '-' + cells[2] : cells[3] : cells[2])).toEqual(canonical.map((row) => row[2]));
        } else {
          expect(result.canDownload).toBe(false);
          expect(result.repairedCsv).toBe('');
          if (mode === 'flipped') {
            const expectedLine = parseCsv(source).records[canonical.indexOf(affected) + 1].line;
            expect(result.balanceChain).toMatchObject({ status: 'FAIL_BALANCE_BREAK', breaks: [{ row: expectedLine, delta: cents(2n * second) }] });
          } else if (mode === 'duplicate') {
            expect(result.balanceChain).toMatchObject({ status: 'FAIL_BALANCE_BREAK', breaks: [{ delta: cents(-second) }] });
            expect(result.balanceChain?.reasons.some(({ message }) => message.includes('duplicates source line'))).toBe(true);
          } else {
            expect(result.balanceChain?.status).toBe('UNVERIFIABLE');
            if (mode === 'mixed') expect(result.balanceChain?.currency).toBeNull();
          }
        }
      },
    ), { seed: seed + 42, numRuns: 850 });
  }, 60_000);

  it('replays 850 FreshBooks exact signed, explicit currency and date-order cases', () => {
    checkFuzz(fc.property(
      movement, movement, fc.boolean(), fc.boolean(), fc.constantFrom('USD', 'GBP', 'AED', 'CAD', 'EUR'),
      fc.constantFrom('valid', 'mixed-sign', 'mixed-currency', 'unknown-currency', 'missing-currency', 'date', 'subcent'),
      (first, second, negative, guard, currency, mode) => {
        const absolute = (amount: bigint) => amount < 0n ? -amount : amount;
        const sign = negative ? -1n : 1n;
        const firstAmount = absolute(first) * sign;
        const secondAmount = absolute(second) * (mode === 'mixed-sign' ? -sign : sign);
        const secondValue = cents(secondAmount) + (mode === 'subcent' ? '1' : '');
        const secondCurrency = mode === 'mixed-currency' ? currency === 'EUR' ? 'USD' : 'EUR' :
          mode === 'unknown-currency' ? 'ZZZ' : mode === 'missing-currency' ? '' : currency;
        const source = csvBytes(['Date', 'Merchant', 'Category', 'Description', 'Amount', 'Tax Name', 'Tax Amount', 'Currency'], [
          ['2026-05-01', '=vendor', 'Supplies', 'with\nnewline', cents(firstAmount), 'Tax', '2.50', currency.toLowerCase()],
          [mode === 'date' ? '04/05/2026' : '2026-05-03', 'Other', 'Supplies', 'Second', secondValue, 'Tax', '3.50', secondCurrency],
        ]);
        const result = repairCsv(source, 'expenses.csv', 'freshbooks-expenses', { formulaGuard: guard });
        expect(result.balanceChain).toBeUndefined();
        expect(result.freshBooksTaxes).toEqual([{ row: 2, name: 'Tax', amount: '2.50' }, { row: 4, name: 'Tax', amount: '3.50' }]);
        if (mode === 'valid') {
          expect(result.canDownload).toBe(true);
          const cells = parseCsv(result.repairedCsv).records.map(({ cells: row }) => row);
          expect(cells[1]).toEqual(['2026-05-01', guard ? "'=vendor" : '=vendor', 'Supplies', 'with\nnewline', cents(firstAmount), 'Tax', '2.50', currency]);
          expect(cells[2][4]).toBe(cents(secondAmount));
          expect(cells[2][7]).toBe(currency);
        } else {
          const issue = {
            'mixed-sign': 'freshbooks-mixed-sign', 'mixed-currency': 'multi-currency', 'unknown-currency': 'invalid-currency',
            'missing-currency': 'invalid-currency', date: 'date-order-ambiguous', subcent: 'freshbooks-amount-scale',
          }[mode];
          expect(result.canDownload).toBe(false);
          expect(result.repairedCsv).toBe('');
          expect(result.issues).toContainEqual(expect.objectContaining({ code: issue, row: 4 }));
        }
      },
    ), { seed: seed + 43, numRuns: 850 });
  }, 60_000);
});

describe('M16 agency branding and native price replay', () => {
  const attacks = fc.tuple(fc.string({ maxLength: 8 }), fc.array(fc.constantFrom(
    '<script>alert(1)</script>', '</aside><img src="https://evil.invalid/a" onerror="run()">',
    '" onfocus=\'evil\' autofocus="', '&lt;svg/onload=run()&gt;', '"><style>@import "https://evil.invalid"</style>',
    '<meta http-equiv="refresh" content="0;url=//evil.invalid">', 'url(data:text/html,<svg/onload=foo>)',
    'أهلاً & "Client\'" 🎁', 'a$b$&c$$d', 'mailto:agency@example.invalid',
  ), { minLength: 1, maxLength: 1 }), fc.string({ maxLength: 8 })).map(([prefix, [value], suffix]) => prefix + ' ' + value + ' ' + suffix);
  const accents = Object.keys(SIGNOFF_ACCENTS) as SignoffBrand['accentKey'][];
  const brand = fc.record({ agencyName: attacks, preparedFor: attacks, contactNote: attacks, accentKey: fc.constantFrom(...accents) });
  const decoder = new TextDecoder();
  const baseColumns = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Variant Compare At Price'];
  const baseRows = [['bag', 'Bag', 'Color', 'Red', '0088', '50.00', '60.00']];

  it('escapes 850 sets of hostile branding text in all five offline report paths', async () => {
    const baselineBytes = csvBytes(baseColumns, baseRows);
    const baseline = parseBaseline(baselineBytes, 'agency-shop.csv');
    const sheet = parseSupplier(bytes('SKU,Cost\n0088,60.00'), 'offers.csv').sheets[0];
    const diff = buildPriceDiff(baseline, sheet, { confirmed: true });
    const repair = repairCsv(bytes('Date,Description,Amount\n2026-09-15,Client,10.25'), 'agency-bank.csv', 'quickbooks-bank');
    const generatedAt = new Date('2026-11-27T00:00:00.000Z');
    const campaign = await buildPromoCampaign('shopify', baselineBytes, { rule: {
      mode: 'percent-off', amount: '20', rounding: 'none', minimumRetail: '1',
    } });
    const delta = await buildSupplierDelta({ bytes: bytes('SKU,Cost\n0088,10'), filename: 'catalog-a.csv' },
      { bytes: bytes('SKU,Cost\n0088,15'), filename: 'catalog-b.csv' });
    const migration = await buildCatalogMigration('shopify', 'woocommerce',
      new Uint8Array(readFileSync(new URL('../../../fixtures/catalog-migrator/shopify-canvas.csv', import.meta.url))));
    expect(campaign.canExport).toBe(true);
    expect(delta.status).toBe('ready');
    expect(migration.artifacts.targetCsv).not.toBeNull();
    const originals = [createSignoffHtml(baseline, diff), createBookkeeperSignoffHtml(repair, { generatedAt }), campaign.signoffHtml!,
      delta.signOffHtml!, decoder.decode(migration.artifacts.signOffHtml.bytes)];
    await checkAsyncFuzz(fc.asyncProperty(brand, async (branding) => {
      const [deltaReports, migrationReports] = await Promise.all([
        brandSupplierDeltaReports(delta, branding), brandCatalogMigrationReports(migration, branding),
      ]);
      const reports = [createSignoffHtml(baseline, diff, undefined, undefined, undefined, branding),
        createBookkeeperSignoffHtml(repair, { generatedAt, branding }), brandSignoffHtml(campaign.signoffHtml!, branding),
        deltaReports.signOffHtml!, decoder.decode(migrationReports.signOffHtml.bytes)];
      for (const [index, report] of reports.entries()) {
        const header = /<aside class="signoff-brand"[\s\S]+?<\/aside>/.exec(report)![0];
        expect(report.replace(header, '')).toBe(originals[index]);
        expect(report).toContain(offlineReportCsp);
        for (const value of [branding.agencyName, branding.preparedFor, branding.contactNote]) expect(header).toContain(escapeReportText(value));
        expect(header).toContain('background:' + SIGNOFF_ACCENTS[branding.accentKey].background + ';color:#ffffff');
        expect(header).not.toMatch(/<(?:script|style|img|svg|iframe|meta|object|link)\b|https?:\/\/|\b(?:href|src|onerror|onfocus)=["']/i);
      }
      const deltaSha = createHash('sha256').update(deltaReports.signOffHtml!).digest('hex');
      expect(deltaReports.signOffHtmlSha256).toBe(deltaSha);
      expect(JSON.parse(deltaReports.auditJson)).toEqual({ ...JSON.parse(delta.auditJson), custody: { ...delta.custody, signOffHtmlSha256: deltaSha } });
      const migrationSha = createHash('sha256').update(migrationReports.signOffHtml.bytes).digest('hex');
      expect(migrationReports.signOffSha256).toBe(migrationSha);
      expect(JSON.parse(decoder.decode(migrationReports.auditJson.bytes))).toEqual({
        ...JSON.parse(decoder.decode(migration.artifacts.auditJson.bytes)), custody: { ...migration.custody, signOffSha256: migrationSha },
      });
    }), { seed: seed + 44, numRuns: 850 });
  }, 60_000);

  it('replays 750 old and branded profile round-trips with invalid palette and duplicate-key mutations', () => {
    checkFuzz(fc.property(brand, fc.constantFrom('shopify', 'woocommerce', 'bigcommerce'),
      fc.constantFrom('USD', 'AED', 'EUR'), (branding, platform, storeCurrency) => {
        const v1 = { version: 1, storeName: 'Agency Sandbox', platform, storeCurrency, dropThresholdPercent: 10 } as const;
        expect(parseWorkspaceProfile(bytes(serializeWorkspaceProfile(v1)))).toEqual({ ok: true, value: v1 });
        const branded = { ...v1, branding };
        const serialized = serializeWorkspaceProfile(branded);
        expect(parseWorkspaceProfile(bytes(serialized))).toEqual({ ok: true, value: branded });
        expect(parseWorkspaceProfile(bytes(serialized.replace('"accentKey":', '"accentKey": "navy", "accentKey":')))).toMatchObject({
          ok: false, diagnostics: [{ code: 'duplicate-workspace-profile-property' }],
        });
        expect(createWorkspaceProfile({ ...v1, branding: { ...branding, accentKey: 'navy; color:' + branding.contactNote } })).toMatchObject({ ok: false });
        expect(createWorkspaceProfile({ ...v1, branding: { ...branding, contactNote: branding.contactNote + '\u202e' } })).toMatchObject({ ok: false });
        expect(createWorkspaceProfile({ ...v1, branding: { ...branding, background: 'navy' } })).toMatchObject({ ok: false });
      }), { seed: seed + 45, numRuns: 750 });
  });

  it('matches applied update and rollback CSV cents across 900 combinations of pricing, market scope and review', () => {
    checkFuzz(fc.property(fc.integer({ min: 100, max: 999 }), fc.bigInt({ min: 1900n, max: 3300n }), fc.bigInt({ min: 1800n, max: 3700n }),
      fc.integer({ min: -15, max: 45 }), fc.integer({ min: -5, max: 8 }), fc.boolean(),
      fc.constantFrom('normal', 'override', 'skip', 'invalid', 'unconfirmed-fx', 'supplier-conflict'),
      fc.constantFrom('markup', 'buffer', 'ending', 'combined'), (id, costA, costB, markup, fxBuffer, market, state, mode) => {
        const sku = '00' + id;
        const sibling = String(id);
        const targetColumn = market ? 'Price / EU' : 'Variant Price';
        const original = { [sku]: '50.00', [sibling]: '48.00' };
        const source = csvBytes([...baseColumns, 'Price / EU', 'Price / UAE'], [
          ['bag', 'Bag', 'Color', 'Red', sku, market ? '333.00' : original[sku], '', original[sku], '555.00'],
          ['bag', '', 'Color', 'Blue', sibling, market ? '444.00' : original[sibling], '', original[sibling], '666.00'],
        ]);
        const baseline = parseBaseline(source);
        const sheet = parseSupplier(bytes('SKU,Cost,Currency\n' + sku + ',' + cents(costA) + ',USD\n' + sibling + ',' +
          (state === 'invalid' ? 'unparseable' : cents(costB)) + ',USD'), 'pricebook.csv').sheets[0];
        const selection = { confirmed: true, skuColumn: 0, priceColumn: 1, fxRateConfirmed: state !== 'unconfirmed-fx',
          ...(market ? { market: 'EU' } : {}), pricingRule: { mode: 'multiplier', multiplier: '2', fixedFee: '.11',
            fx: { sourceCurrency: 'USD', storeCurrency: 'EUR', fxRate: '1.25' } } } as const;
        const resolutions: Readonly<Record<number, RowResolution>> = state === 'skip' ? { 3: { skip: true } } :
          state === 'override' ? { 3: { price: '59.25' } } : {};
        const supplier = { supplierId: 'agency', filename: 'pricebook.csv', sheet, selection, resolutions };
        const other = { ...supplier, supplierId: 'alternate', sheet: parseSupplier(bytes('SKU,Cost,Currency\n' +
          sku + ',30.25,USD'), 'second.csv').sheets[0] };
        const comparison: PriceComparison = state === 'supplier-conflict'
          ? { kind: 'batch', suppliers: [supplier, other], options: { ...(market ? { market: 'EU' } : {}), conflictPolicy: 'prefer-last' } }
          : { kind: 'single', supplier };
        const scenario: WhatIfScenario = { id: mode,
          ...(mode === 'markup' || mode === 'combined' ? { markupPercent: String(markup) } : {}),
          ...(mode === 'buffer' || mode === 'combined' ? { fxBufferPercent: String(fxBuffer) } : {}),
          ...(mode === 'ending' || mode === 'combined' ? { rounding: 'ending-95' } : {}),
          ...(mode === 'combined' ? { minimumRetail: '25.125' } : {}),
        };
        const current = runPriceComparison(baseline, comparison);
        const [plan] = simulatePriceScenarios(baseline, comparison, [scenario], current);
        const apply = (entry: typeof supplier | typeof other) => ({
          ...entry, selection: { ...entry.selection, pricingRule: plan.suppliers.find(({ supplierId }) => entry.supplierId === supplierId)!.pricingRule },
        });
        const exported = runPriceComparison(baseline, comparison.kind === 'batch'
          ? { ...comparison, suppliers: [apply(supplier), apply(other)] } : { kind: 'single', supplier: apply(supplier) });
        expect(plan.status).toBe(exported.status);
        if (state === 'invalid' || state === 'unconfirmed-fx' || state === 'supplier-conflict') {
          expect(plan).toMatchObject({ canApply: false, status: 'review', averageMarginPercent: null, totalRetailDeltaCents: null });
          expect(exported.updateBytes).toBeNull();
          return;
        }
        if (!exported.updateBytes || !exported.rollbackBytes) {
          expect(plan).toMatchObject({ canApply: false });
          return;
        }
        expect(exported.canDownload).toBe(true);
        const [header, ...rows] = parseCsv(decoder.decode(exported.updateBytes)).records;
        expect(header.cells.at(-1)).toBe(targetColumn);
        const [rollbackHeader, ...restored] = parseCsv(decoder.decode(exported.rollbackBytes)).records;
        expect(rollbackHeader.cells).toEqual(header.cells);
        const key = header.cells.indexOf('Variant SKU');
        const price = header.cells.indexOf(targetColumn);
        let total = 0n;
        let changes = 0;
        for (const [index, { cells }] of rows.entries()) {
          const previous = original[cells[key]];
          expect(restored[index].cells[key]).toBe(cells[key]);
          expect(restored[index].cells[price]).toBe(previous);
          if (cells[price] !== previous) changes++;
          total += BigInt(cells[price].replace('.', '')) - BigInt(previous.replace('.', ''));
          if (cells[key] === sibling && state === 'skip') expect(cells[price]).toBe(previous);
          if (cells[key] === sibling && state === 'override') expect(cells[price]).toBe('59.25');
        }
        expect(plan.totalRetailDeltaCents).toBe(total.toString());
        expect(plan.changedSkuCount).toBe(changes);
        expect(plan.unknownRetailSkuCount).toBe(0);
      }), { seed: seed + 46, numRuns: 900 });
  }, 60_000);
});

describe('M17 bundle DAG, cycle, orphan and native byte replay', () => {
  const bomBytes = (entries: string[][]) => bytes(serializeCsv(['Bundle SKU', 'Component SKU', 'Quantity', 'Assembly Cost'], entries, 'price-audit'));
  const bomRead = (entries: string[][]) => parseBom(bomBytes(entries), 'bundles.csv');
  const priced = (value: bigint): BomCost => ({ cents: value, source: { kind: 'baseline', filename: 'store.csv', line: 2, column: 'Cost' } });
  const qty = fc.integer({ min: 1, max: 9 });

  it('conserves every nested cost across 900 independent five-level DAGs', () => {
    checkFuzz(fc.property(
      fc.array(fc.tuple(fc.bigInt({ min: 0n, max: 2n ** 60n }), fc.bigInt({ min: 0n, max: 500n }), qty, qty, fc.nat(99)), { minLength: 1, maxLength: 5 }),
      (inputs) => {
        const expected = new Map<string, bigint>();
        const depths = new Map<string, number>();
        const leaves = new Map<string, BomCost>();
        const entries: string[][] = [];
        for (const [index, [leafUnits, assembly, leafCount, bundleCount, prior]] of inputs.entries()) {
          const sku = 'B-' + index;
          const leaf = '00123' + index;
          leaves.set(leaf, priced(leafUnits));
          entries.push([sku, leaf, String(leafCount), cents(assembly)]);
          let sum = assembly + leafUnits * BigInt(leafCount);
          let depth = 1;
          if (index > 0) {
            const parent = 'B-' + prior % index;
            entries.push([sku, parent, String(bundleCount), cents(assembly)]);
            sum += BigInt(bundleCount) * expected.get(parent)!;
            depth = depths.get(parent)! + 1;
          }
          expected.set(sku, sum);
          depths.set(sku, depth);
        }
        const result = rollupBom(bomRead(entries.reverse()), (sku) => ({ current: leaves.get(sku) ?? null, previous: leaves.get(sku) ?? null }));
        expect(result.issues).toEqual([]);
        expect(result.kits).toHaveLength(inputs.length);
        for (const kit of result.kits) {
          expect(kit).toMatchObject({ newCost: cents(expected.get(kit.sku)!), oldCost: cents(expected.get(kit.sku)!),
            oldCostSource: 'recomputed', depth: depths.get(kit.sku) });
        }
      },
    ), { seed: seed + 47, numRuns: 900 });
  });

  it('reports 350 exact cycle paths and physical source lines', () => {
    checkFuzz(fc.property(
      fc.integer({ min: 1, max: 12 }), fc.integer({ min: 0, max: 8 }), qty,
      (length, blank, count) => {
        const chain = Array.from({ length }, (_, index) => 'KIT-' + index);
        const source = chain.map((sku, index) => sku + ',' + chain[(index + 1) % length] + ',' + count).join('\n');
        const parsed = parseBom(bytes('Bundle SKU,Component SKU,Quantity\n' + '\n'.repeat(blank) + source), 'cycle.csv');
        const result = rollupBom(parsed, () => ({ current: null, previous: null }));
        expect(result.issues).toMatchObject([{ code: 'bom-cycle', bomPath: [...chain, chain[0]],
          rows: chain.map((_, index) => blank + index + 2) }]);
        expect(result.kits.every(({ newCost }) => newCost === null)).toBe(true);
      },
    ), { seed: seed + 48, numRuns: 350 });
  });

  it('holds 350 orphan and unknown-price cases without replacing them with explicit zero', () => {
    checkFuzz(fc.property(
      fc.bigInt({ min: 0n, max: 50_000n }), qty, qty, fc.nat(1_000_000),
      (baselineCost, count, kitCount, suffix) => {
        const orphan = '00-' + suffix;
        const result = rollupBom(bomRead([['B-2', 'B-1', String(kitCount), '0.10'],
          ['B-1', '0000', String(count), '0.00'], ['B-1', orphan, '1', '0.000']]),
        (sku) => ({ current: sku === '0000' ? priced(baselineCost) : null, previous: null }));
        expect(result.issues).toMatchObject([{ code: 'orphan-component', row: 4, value: orphan }]);
        expect(result.kits).toMatchObject([{ newCost: null }, { newCost: null, components: [{ unitCost: cents(baselineCost) }, { unitCost: null }] }]);
      },
    ), { seed: seed + 49, numRuns: 350 });
  });

  for (const [index, platform] of (['shopify', 'woocommerce', 'bigcommerce'] as const).entries()) {
    it('replays 300 matching ' + platform + ' native update and rollback byte pairs', async () => {
      await checkAsyncFuzz(fc.asyncProperty(
        fc.bigInt({ min: 500n, max: 50000n }), fc.bigInt({ min: 1n, max: 250n }), fc.bigInt({ min: 0n, max: 10000n }),
        fc.bigInt({ min: 0n, max: 1000n }), qty, qty, qty,
        async (beforeLeaf, increase, fallback, assembly, leafCount, kitCount, fallbackCount) => {
          const first = (leaf: bigint) => BigInt(leafCount) * leaf + assembly;
          const second = (leaf: bigint) => BigInt(kitCount) * first(leaf) + BigInt(fallbackCount) * fallback + assembly;
          const baselineLeaf = cents(beforeLeaf * 2n) + '0';
          const baselineFirst = cents(first(beforeLeaf) * 2n) + '00';
          const baselineSecond = cents(second(beforeLeaf) * 2n) + '000';
          const { baseline, data } = syntheticBomBaseline(platform, [
            ['00123', baselineLeaf, cents(beforeLeaf)], ['00004', '200.000', cents(fallback)],
            ['KIT-A', baselineFirst, ''], ['KIT-B', baselineSecond, ''],
          ]);
          const after = beforeLeaf + increase;
          const [supplier] = parseSupplier(bytes('SKU,Cost\n00123,' + cents(after)), 'offer.csv').sheets;
          const sheet = bomRead([['KIT-B', 'KIT-A', String(kitCount), cents(assembly)],
            ['KIT-B', '00004', String(fallbackCount), ''], ['KIT-A', '00123', String(leafCount), cents(assembly)]]);
          const result = buildPriceDiff(baseline, supplier, { confirmed: true, pricingRule: { mode: 'multiplier', multiplier: '2' } },
            {}, undefined, undefined, undefined, { sheet });
          expect(result.issues).toEqual([]);
          expect(result.bom?.kits).toMatchObject([
            { sku: 'KIT-B', newCost: cents(second(after)), oldCost: cents(second(beforeLeaf)), grossMarginPercent: '50.00' },
            { sku: 'KIT-A', newCost: cents(first(after)), oldCost: cents(first(beforeLeaf)), grossMarginPercent: '50.00' },
          ]);
          expect(result.canDownload).toBe(true);
          const { updateBytes, rollbackBytes } = result;
          expect(parseCsv(decodeCsv(updateBytes!).text).records.slice(1).map(({ cells }) => cells.at(-1)))
            .toEqual([cents(after * 2n), cents(first(after) * 2n), cents(second(after) * 2n)]);
          expect(parseCsv(decodeCsv(rollbackBytes!).text).records.slice(1).map(({ cells }) => cells.at(-1)))
            .toEqual([baselineLeaf, baselineFirst, baselineSecond]);
          const inspected = await inspectImport(platform, data, rollbackBytes!, updateBytes!);
          expect(inspected).toMatchObject({ verdict: 'PASS', nonTargetMutations: 0, brokenGroups: 0,
            rollback: { scope: 'paired-update', residualDiffs: 0, restored: true } });
        },
      ), { seed: seed + 50 + index, numRuns: 300 });
    });
  }
});

describe('M18 CLI engine parity and custody', () => {
  const catalog = (sku: string, price: string) => csvBytes(
    ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Variant Compare At Price'],
    [['part', 'Spare Part', 'Title', 'Default Title', sku, price, '']],
  );
  const amount = fc.integer({ min: 1_000, max: 50_000 });
  const sku = fc.integer({ min: 1, max: 900_000 }).map(value => '00' + value);
  const artifact = (run: CliResult, role: string) => run.artifacts.find(file => file.role === role)?.bytes;
  const guarded = (run: CliResult, unsafe: boolean) => {
    expect(run.exitCode).toBe(unsafe ? 2 : 0);
    if (unsafe) expect(run.artifacts.every(file => !file.filename.endsWith('.csv'))).toBe(true);
  };

  it('checks 450 CLI repairs for exact native bytes or an explicit hold with a receipt', async () => {
    await checkAsyncFuzz(fc.asyncProperty(sku, amount, fc.boolean(), async (key, price, unsafe) => {
      const source = { filename: 'products.csv', bytes: catalog(key, unsafe ? 'Call for price' : cents(BigInt(price))) };
      const generatedAt = new Date('2026-01-01T12:00:00.000Z');
      const expected = repairCsvWithBytes(source.bytes, source.filename, 'shopify-products', {}, []);
      const run = await dispatchCli({ mode: 'repair', platform: 'shopify-products', source, options: {}, generatedAt });
      guarded(run, unsafe);
      if (!unsafe) expect(artifact(run, 'repaired')).toEqual(expected.verifiedBytes);
      else expect(expected.result.needsManualReviewCount).toBeGreaterThan(0);
      const manifest = JSON.parse(await createCustodyManifest('repair', run.exitCode, [{ role: 'source', ...source }], run.artifacts));
      const digest = ({ bytes: content }: { bytes: Uint8Array }) => createHash('sha256').update(content).digest('hex');
      expect(manifest.inputs[0]).toEqual({ role: 'source', filename: source.filename, byteLength: source.bytes.byteLength, sha256: digest(source) });
      expect(manifest.outputs.map((file: { sha256: string }) => file.sha256)).toEqual(run.artifacts.map(digest));
    }), { seed: seed + 53, numRuns: 450 });
  }, 30_000);

  it('checks 500 price comparisons against both exact core CSVs and withholds unsafe pairs', async () => {
    await checkAsyncFuzz(fc.asyncProperty(sku, amount, fc.boolean(), async (key, price, unsafe) => {
      const baseline = { filename: 'store.csv', bytes: catalog(key, cents(BigInt(price))) };
      const file = { filename: 'offer.csv', bytes: csvBytes(['SKU', 'Price'], [[key, unsafe ? 'Invalid' : cents(BigInt(price + 100))]]) };
      const directBase = parseBaseline(baseline.bytes, baseline.filename);
      const expected = buildPriceDiff(directBase, parseSupplier(file.bytes, file.filename).sheets[0]);
      const run = await dispatchCli({ mode: 'price-diff', platform: 'shopify', baseline, suppliers: [{ file }], options: {} });
      guarded(run, unsafe);
      expect(artifact(run, 'update') ?? null).toEqual(expected.updateBytes);
      expect(artifact(run, 'rollback') ?? null).toEqual(expected.rollbackBytes);
      expect(JSON.parse(decodeCsv(artifact(run, 'audit')!).text).status).toBe(expected.status);
    }), { seed: seed + 54, numRuns: 500 });
  }, 30_000);

  it('checks 450 standalone verification reports against the direct inspector', async () => {
    await checkAsyncFuzz(fc.asyncProperty(sku, amount, fc.boolean(), async (key, price, unsafe) => {
      const baseline = { filename: 'store.csv', bytes: catalog(key, cents(BigInt(price))) };
      const candidate = { filename: 'candidate.csv', bytes: catalog(unsafe ? key + '0' : key, cents(BigInt(price + 100))) };
      const direct = await inspectImport('shopify', baseline.bytes, candidate.bytes);
      const run = await dispatchCli({ mode: 'verify', platform: 'shopify', baseline, candidate });
      guarded(run, unsafe);
      expect(run.status).toBe(unsafe ? 'FAIL_UNSAFE' : 'PASS');
      expect(artifact(run, 'report')).toEqual(bytes(JSON.stringify(direct, null, 2) + '\n'));
    }), { seed: seed + 55, numRuns: 450 });
  }, 30_000);

  it('checks 600 promotion, supplier delta and migration cases against their direct downloadable artifacts', async () => {
    await checkAsyncFuzz(fc.asyncProperty(sku, amount, fc.boolean(), fc.constantFrom('promo', 'supplier-delta', 'migrate'),
      async (key, price, unsafe, mode) => {
        const baseline = { filename: 'store.csv', bytes: catalog(key, cents(BigInt(price))) };
        if (mode === 'promo') {
          const options: PromoCampaignOptions = { rule: { mode: 'percent-off', amount: unsafe ? '101' : '15', rounding: 'none', minimumRetail: '1' } };
          const direct = await buildPromoCampaign('shopify', baseline.bytes, options);
          const run = await dispatchCli({ mode, baseline, platform: 'shopify', options });
          guarded(run, unsafe);
          expect(artifact(run, 'audit')).toEqual(bytes(direct.auditJson));
          expect(artifact(run, 'launch')).toEqual(direct.launchCsv === null ? undefined : bytes(direct.launchCsv));
          expect(artifact(run, 'revert')).toEqual(direct.revertCsv === null ? undefined : bytes(direct.revertCsv));
        } else if (mode === 'supplier-delta') {
          const previous = { filename: 'previous.csv', bytes: csvBytes(['SKU', 'Cost'], [[key, cents(BigInt(price))]]) };
          const next = { filename: 'next.csv', bytes: csvBytes(['SKU', 'Cost'], [[key, unsafe ? 'Invalid' : cents(BigInt(price + 100))]]) };
          const direct = await buildSupplierDelta(previous, next);
          const run = await dispatchCli({ mode, previous, next });
          guarded(run, unsafe);
          expect(artifact(run, 'audit')).toEqual(bytes(direct.auditJson));
          expect(artifact(run, 'delta')).toEqual(direct.deltaCsv === null ? undefined : bytes(direct.deltaCsv));
        } else {
          const source = unsafe ? { ...baseline, bytes: catalog(key, 'Invalid') } : baseline;
          const direct = await buildCatalogMigration('shopify', 'woocommerce', source.bytes, source.filename);
          const run = await dispatchCli({ mode, source, sourcePlatform: 'shopify', targetPlatform: 'woocommerce' });
          guarded(run, unsafe);
          expect(artifact(run, 'target')).toEqual(direct.artifacts.targetCsv?.bytes);
          expect(artifact(run, 'audit')).toEqual(direct.artifacts.auditJson.bytes);
        }
      }), { seed: seed + 56, numRuns: 600 });
  }, 30_000);

  it('checks 500 safe local path pairs and rejects unsafe components in both path syntaxes', () => {
    const bad = fc.constantFrom('..', 'x.', 'report ', 'con', 'PrN.csv', 'NUL .csv', 'com1.json', 'LPT².xlsx', 'CONOUT$',
      'name:stream', 'file\u0001', 'name\u202e.csv', 'name*', 'name?', 'name|', '<name>');
    checkFuzz(fc.property(fc.integer({ min: 1, max: 999_999 }), bad, fc.constantFrom('D', 'z'), (id, component, drive) => {
      const name = `دفتر-${id}.csv`;
      expect(isSafeFileName(name)).toBe(true);
      expect(isSafeFileName(component)).toBe(false);
      expect(isSafeLocalPath(`${drive}:\\Données\\${name}`)).toBe(true);
      expect(isSafeLocalPath(`/données/${name}`)).toBe(true);
      expect(isSafeLocalPath(`./données/${name}`)).toBe(true);
      expect(isSafeLocalPath(`${drive}:\\Données\\${component}\\${name}`)).toBe(false);
      expect(isSafeLocalPath(`/données/${component}/${name}`)).toBe(false);
      expect(isSafeLocalPath(`//server/share/${name}`)).toBe(false);
      expect(isSafeLocalPath(`\\\\?\\${drive}:\\${name}`)).toBe(false);
      expect(isSafeLocalPath(`${drive}:${name}`)).toBe(false);
    }), { seed: seed + 57, numRuns: 500 });
  });
});

describe('M19 Shopify stock conservation and safety boundaries', () => {
  const mapping = { skuColumn: 0, quantityColumn: 1 };
  const file = (filename: string, value: string) => ({ filename, bytes: bytes(value) });
  const baselineHeaders = ['Handle', 'Title', 'Option 1 Value', 'SKU', 'Location', 'Available', 'On hand (new)', 'On hand (current)'];
  const whole = fc.nat({ max: 20_000 });
  const costed = (sku: string, stock: string) => ({ filename: 'offer.csv', bytes: csvBytes(['SKU', 'Qty'], [[sku, stock]]), mapping });
  const reserve = { reserveUnits: 0, zeroOutThreshold: 0 };

  it('replays 1,200 selected-location pairs and conserves original raw rows, padding and independent location bytes', async () => {
    await checkAsyncFuzz(fc.asyncProperty(
      fc.integer({ min: -20_000, max: 20_000 }), whole, whole, whole, fc.option(whole, { nil: undefined }),
      fc.nat({ max: 900_000 }), fc.constantFrom('\r\n', '\r', '\n'), fc.constantFrom('é漢', 'رمل', '"Quoted, title"'),
      async (original, supplier, reserveUnits, zeroOutThreshold, maxCap, suffix, ending, text) => {
        const sku = '00' + suffix;
        const current = (original < 0 ? '-' : '') + '00' + Math.abs(original);
        const other = '00' + (suffix + 1);
        const onHand = Math.min(maxCap ?? Number.MAX_SAFE_INTEGER,
          supplier > zeroOutThreshold ? Math.max(0, supplier - reserveUnits) : 0);
        const header = baselineHeaders.join(',');
        const unique = [text, 'first\nsecond', 'third\r\nfourth'];
        const sourceRows = [['Warehouse A', current], ['Warehouse B', other], ['Warehouse C', 'Not stocked']] as const;
        const rawRows = sourceRows.map(([location, rawValue], i) => {
          const withQty = serializeCsv(baselineHeaders, [['part', unique[i], 'Special, "Sand"', sku,
            location, String(suffix + i), String(suffix + i + 100), rawValue]], 'shopify-products').slice(header.length + 1);
          return { location, raw: withQty, stock: rawValue };
        });
        const baseline = file('store.csv', [header, ...rawRows.map(({ raw }) => raw)].join(ending));
        const result = await buildInventorySync(baseline, [costed(sku, String(supplier))],
          { targetLocation: 'Warehouse A', reserveUnits, zeroOutThreshold, maxCap, approveLargeDrop: true });
        expect(result.issues).toEqual([]);
        expect(result.rows).toMatchObject([{ sku, currentRaw: current, currentQty: original, proposedQty: onHand, bufferWithheld: supplier - onHand }]);
        if (onHand === original) {
          expect(result).toMatchObject({ status: 'no-changes', updateCsv: null, rollbackCsv: null });
          return;
        }
        const replay = (native: Uint8Array) => {
          const [head, ...rows] = parseCsv(decodeCsv(native).text).records;
          expect(rows).toHaveLength(1);
          expect(head.cells).toEqual(['Handle', 'Title', 'Option 1 Value', 'SKU', 'Location', 'On hand (current)', 'On hand (new)']);
          for (const { cells } of rows) {
            const [handle, title, option, key, location, expected, desired] = cells;
            expect([handle, title, option, key, location]).toEqual(['part', text, 'Special, "Sand"', sku, 'Warehouse A']);
            const state = rawRows.find(row => row.location === location)!;
            expect(state.stock).toBe(expected);
            state.raw = state.raw.slice(0, -state.stock.length) + desired;
            state.stock = desired;
          }
        };
        const preserved = rawRows.slice(1).map(({ raw }) => bytes(raw));
        replay(result.updateCsv!);
        expect(rawRows[0].stock).toBe(String(onHand));
        expect(rawRows.slice(1).map(({ raw }) => bytes(raw))).toEqual(preserved);
        replay(result.rollbackCsv!);
        expect(bytes([header, ...rawRows.map(({ raw }) => raw)].join(ending))).toEqual(baseline.bytes);
        expect(result.verification).toEqual({ checked: true, restoredRows: 1, otherLocationRowsUntouched: 2 });
      },
    ), { seed: seed + 58, numRuns: 1200 });
  }, 30_000);

  it('agrees with an exact rational 80% oracle on 750 whole-number proposals up to the safe integer boundary', async () => {
    await checkAsyncFuzz(fc.asyncProperty(
      fc.bigInt({ min: 1n, max: BigInt(Number.MAX_SAFE_INTEGER) }), fc.integer({ min: -3, max: 3 }), fc.boolean(),
      async (original, offset, approved) => {
        const projected = original / 5n + BigInt(offset);
        const after = projected < 0n ? 0n : projected;
        const requiresApproval = (original - after) * 100n > original * 80n;
        const sku = '00001';
        const baseline = { filename: 'shop.csv', bytes: csvBytes(baselineHeaders,
          [['part', 'Original', 'Default Title', sku, 'Shelf', '0', '923', String(original)]]) };
        const result = await buildInventorySync(baseline, [costed(sku, String(after))], { ...reserve, approveLargeDrop: approved });
        expect(result.status).toBe(requiresApproval && !approved ? 'blocked' : after === original ? 'no-changes' : 'ready');
        expect(result.issues.map(issue => issue.code)).toEqual(requiresApproval && !approved ? ['large-stock-drop'] : []);
        if (result.status === 'ready') {
          expect(parseCsv(decodeCsv(result.updateCsv!).text).records[1].cells.slice(-2)).toEqual([String(original), String(after)]);
          expect(parseCsv(decodeCsv(result.rollbackCsv!).text).records[1].cells.slice(-2)).toEqual([String(after), String(original)]);
        } else expect([result.updateCsv, result.rollbackCsv]).toEqual([null, null]);
      },
    ), { seed: seed + 59, numRuns: 750 });
  }, 30_000);

  it('holds 550 invalid stock inputs after multiline rows on their actual physical CSV start line', async () => {
    const invalid = fc.constantFrom('-0', '-1', ' +1', '+2', '4.2', '1e2', 'NA', 'Infinity', '7,000', '9007199254740992', '');
    await checkAsyncFuzz(fc.asyncProperty(
      invalid, whole, fc.nat({ max: 10 }), fc.constantFrom('\r\n', '\r', '\n'), fc.boolean(),
      async (value, before, blanks, ending, approveLargeDrop) => {
        const sku = '00001';
        const baseline = { filename: 'shop.csv', bytes: csvBytes(baselineHeaders,
          [['part', 'Original', 'Default Title', sku, 'Shelf', '0', '923', String(before)]]) };
        const feed = file('offer.csv', ['SKU,Qty,Note', `00001,${before},"one\r\ntwo\nthree"`,
          ...Array.from({ length: blanks }, () => ''), `unmatched,"${value}",invalid`].join(ending));
        const result = await buildInventorySync(baseline, [{ ...feed, mapping }], { ...reserve, approveLargeDrop });
        expect(result).toMatchObject({ status: 'blocked', updateCsv: null, rollbackCsv: null, issues: [
          { code: 'invalid-supplier-quantity', source: 'supplier', supplierIndex: 0, line: 5 + blanks, sku: 'unmatched', value },
        ] });
        expect(result.custody).not.toHaveProperty('updateCsvSha256');
        expect(result.custody).not.toHaveProperty('rollbackCsvSha256');
      },
    ), { seed: seed + 60, numRuns: 550 });
  }, 30_000);
});

it('accounts for all 35,220 seeded executions without skips', () => {
  expect(fuzzExecutions).toEqual({ accepted: 35_220, discarded: 0, properties: 61 });
  console.info(`Deterministic fuzz: ${fuzzExecutions.accepted} accepted, ${fuzzExecutions.discarded} discarded across ${fuzzExecutions.properties} properties.`);
});
