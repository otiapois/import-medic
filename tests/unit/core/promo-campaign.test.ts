import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCsv, serializeCsv } from '../../../src/core/csv';
import { buildPromoCampaign, type PromoCampaignOptions } from '../../../src/core/promo-campaign/engine';
import { inspectImport } from '../../../src/core/verify-import/inspector';

const bytes = (value: string) => new TextEncoder().encode(value);
const csv = (columns: string[], rows: string[][]) => bytes(serializeCsv(columns, rows, 'shopify-products'));
const rule: PromoCampaignOptions['rule'] = { mode: 'percent-off', amount: '20', rounding: 'ending-99', minimumRetail: '12.00' };

describe('sale campaign native packs', () => {
  it('holds a low Shopify price until skipped, includes siblings, and replays exact original cells', async () => {
    const baseline = readFileSync(new URL('../../../fixtures/promo-campaign/shopify.csv', import.meta.url));
    const options = { rule: { ...rule, preserveHigherCompareAt: true }, scope: { tag: 'Ramadan' }, storeLabel: '<script>alert(1)</script>' };
    const blocked = await buildPromoCampaign('shopify', baseline, options);
    expect(blocked).toMatchObject({ canExport: false, launchCsv: null, revertCsv: null, custody: { launchSha256: null, revertSha256: null } });
    expect(blocked.rows[1]).toMatchObject({ sku: '0002', promoPrice: '8.99', status: 'held', issues: [{ code: 'minimum-retail-breach' }] });

    const pack = await buildPromoCampaign('shopify', baseline, { ...options, skipLineNumbers: [3] });
    expect(pack.issues).toMatchObject([{ code: 'minimum-retail-breach', severity: 'warning', line: 3 }]);
    expect(pack.canExport).toBe(true);
    expect(pack.summary).toMatchObject({ changedRows: 2, skippedRows: 1, warningRows: 1, averageDiscountPercent: '16.37', totalPriceReduction: '8.02' });
    const original = parseCsv(baseline.toString('utf8')).records.map(({ cells }) => cells);
    const launch = parseCsv(pack.launchCsv!).records.map(({ cells }) => cells);
    const revert = parseCsv(pack.revertCsv!).records.map(({ cells }) => cells);
    expect(launch[0]).toEqual(['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Variant Compare At Price']);
    expect(launch).toEqual([launch[0], [...original[1].slice(0, 5), '19.99', '024.000'], original[2].slice(0, 7), [...original[3].slice(0, 5), '20.99', '040.000']]);
    expect(revert).toEqual([launch[0], ...original.slice(1, 4).map((row) => row.slice(0, 7))]);
    expect(await inspectImport('shopify', baseline, bytes(pack.revertCsv!), bytes(pack.launchCsv!))).toMatchObject({
      verdict: 'PASS', rollback: { residualDiffs: 0, restored: true }, nonTargetMutations: 0,
    });
    expect(pack.signoffHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(pack.signoffHtml).not.toContain('<script>');
    expect(pack.signoffHtml).toContain('Promo 8.99 is below the minimum retail floor 12.00.');
  });

  it('limits WooCommerce files to Sale price and preserves exact parent refs and blank rollback', async () => {
    const baseline = csv(['ID', 'Type', 'SKU', 'Parent', 'Regular price', 'Sale price', 'Description'], [
      ['1', 'variable', 'parent', '', '', '', 'Parent description'],
      ['2', 'variation', '0001', 'id:1', '030.000', '', 'Original variation'],
      ['3', 'variation', '0002', 'parent', '030.000', '019.000', 'Original sale'],
    ]);
    const pack = await buildPromoCampaign('woocommerce', baseline, { rule });
    expect(pack.issues).toEqual([]);
    expect(pack.canExport).toBe(true);
    expect(parseCsv(pack.launchCsv!).records.map(({ cells }) => cells)).toEqual([
      ['ID', 'Type', 'SKU', 'Parent', 'Sale price'], ['2', 'variation', '0001', 'id:1', '24.99'], ['3', 'variation', '0002', 'parent', '15.99'],
    ]);
    expect(parseCsv(pack.revertCsv!).records.map(({ cells }) => cells)).toEqual([
      ['ID', 'Type', 'SKU', 'Parent', 'Sale price'], ['2', 'variation', '0001', 'id:1', ''], ['3', 'variation', '0002', 'parent', '019.000'],
    ]);
    expect(await inspectImport('woocommerce', baseline, bytes(pack.revertCsv!), bytes(pack.launchCsv!))).toMatchObject({ verdict: 'PASS', rollback: { residualDiffs: 0 } });
  });

  it('holds an unrestorable blank BigCommerce Sale Price and emits only eligible standalone sales after skip', async () => {
    const baseline = csv(['Item Type', 'Product ID', 'Product Name', 'Product SKU', 'Price', 'Sale Price', 'Option Set'], [
      ['Product', '01', 'Simple', '0001', '030.000', '019.000', ''],
      ['Product', '02', 'Simple blank', '0002', '030.000', '', ''],
      ['Product', '03', 'Grouped', '0003', '030.000', '019.000', 'Colors'],
      ['SKU', '04', '[RB]Color=Red', '0004', '050.000', '039.000', ''],
    ]);
    const blocked = await buildPromoCampaign('bigcommerce', baseline, { rule });
    expect(blocked).toMatchObject({ canExport: false, launchCsv: null, revertCsv: null });
    expect(blocked.rows[1]).toMatchObject({ status: 'held', issues: [{ code: 'bigcommerce-unrestorable-value' }] });
    const pack = await buildPromoCampaign('bigcommerce', baseline, { rule, skipLineNumbers: [3] });
    expect(pack.issues).toMatchObject([{ code: 'bigcommerce-unrestorable-value', severity: 'warning', line: 3 }]);
    expect(pack.canExport).toBe(true);
    expect(parseCsv(pack.launchCsv!).records.map(({ cells }) => cells)).toEqual([
      ['Item Type', 'Product ID', 'Product Name', 'Product SKU', 'Sale Price'], ['Product', '01', 'Simple', '0001', '15.99'],
    ]);
    expect(parseCsv(pack.revertCsv!).records[1].cells).toEqual(['Product', '01', 'Simple', '0001', '019.000']);
    expect(await inspectImport('bigcommerce', baseline, bytes(pack.revertCsv!), bytes(pack.launchCsv!))).toMatchObject({ verdict: 'PASS', rollback: { residualDiffs: 0 } });
  });

  it('rejects nonpositive amounts, outcomes and a rounded sale price that raises the effective WooCommerce price', async () => {
    const baseline = csv(['ID', 'Type', 'SKU', 'Parent', 'Regular price', 'Sale price'], [
      ['1', 'simple', 'zero', '', '20.00', '0.00'],
      ['2', 'simple', 'higher', '', '20.00', '10.11'],
      ['3', 'simple', 'subcent', '', '0.10', ''],
    ]);
    const settings = { ...rule, mode: 'fixed-amount-off', amount: '0.10', minimumRetail: '0.01' } as const;
    const held = await buildPromoCampaign('woocommerce', baseline, { rule: settings });
    expect(held.rows.map(({ issues }) => issues.map(({ code }) => code))).toEqual([
      ['nonpositive-original-price'], ['promo-does-not-discount'], ['nonpositive-promo-price'],
    ]);
    expect(held.rows[1]).toMatchObject({ beforePrice: '10.11', promoPrice: '10.99', revertPrice: '10.11', regularPrice: '20.00' });
    expect(held).toMatchObject({ canExport: false, custody: { launchSha256: null, revertSha256: null } });
    for (const settingsInvalid of [
      { ...settings, minimumRetail: '0' }, { ...settings, amount: '0.001' }, { ...settings, amount: '0' },
      { ...rule, amount: '90.0001' }, { ...rule, amount: '0.99' },
    ]) expect((await buildPromoCampaign('woocommerce', baseline, { rule: settingsInvalid })).canExport).toBe(false);
  });

  it('rejects ambiguous or unmatched exact scope and missing native sale columns', async () => {
    const baseline = csv(['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Variant Compare At Price', 'Tags'], [
      ['group', 'Original', 'Color', 'Red', '001', '30.00', '', 'Sale'],
      ['group', '', '', 'Blue', '002', '30.00', '', 'Sale, Other'],
    ]);
    const withTag = await buildPromoCampaign('shopify', baseline, { rule, scope: { tag: 'Sale' } });
    expect(withTag.rows.map(row => row.status)).toEqual(['held', 'held']);
    expect(withTag.issues.map(({ code }) => code)).toEqual(['ambiguous-product-tags', 'ambiguous-product-tags']);
    const wrongSku = await buildPromoCampaign('shopify', baseline, { rule, scope: { skus: ['001', '2'] } });
    expect(wrongSku.issues).toMatchObject([{ code: 'campaign-sku-not-found' }]);
    expect(wrongSku).toMatchObject({ launchCsv: null, revertCsv: null });
    const invalid = await buildPromoCampaign('shopify', baseline, { rule, scope: { skuPrefix: '00', skus: ['001'] } });
    expect(invalid.issues).toMatchObject([{ code: 'invalid-campaign-scope' }]);

    const woo = csv(['ID', 'Type', 'SKU', 'Parent', 'Regular price'], [['1', 'simple', '001', '', '31.00']]);
    expect((await buildPromoCampaign('woocommerce', woo, { rule })).issues).toMatchObject([{ code: 'missing-original-sale-column', column: 'Sale price' }]);
    expect((await buildPromoCampaign('woocommerce', woo, { rule, scope: { handle: '1' } })).issues).toMatchObject([
      { code: 'missing-original-sale-column' }, { code: 'unsupported-campaign-scope' },
    ]);
  });

  it('keeps a WooCommerce campaign out of a preexisting sale schedule', async () => {
    const baseline = csv(['ID', 'Type', 'SKU', 'Parent', 'Regular price', 'Sale price', 'Date sale price starts', 'Date sale price ends'], [
      ['1', 'simple', '001', '', '31.00', '26.00', '2026-11-30 00:00:00', ''],
      ['2', 'simple', '002', '', '32.00', '', '', ''],
    ]);
    const held = await buildPromoCampaign('woocommerce', baseline, { rule });
    expect(held.issues).toMatchObject([{ code: 'scheduled-woo-sale', severity: 'hold', line: 2 }]);
    expect(held.canExport).toBe(false);
    const pack = await buildPromoCampaign('woocommerce', baseline, { rule, skipLineNumbers: [2] });
    expect(pack.canExport).toBe(true);
    expect(pack.issues).toMatchObject([{ code: 'scheduled-woo-sale', severity: 'warning', line: 2 }]);
    expect(pack.launchCsv).not.toContain('2026-11-30');
  });

  it('checks the floor and fixed discounts exactly beyond integer-safe Number precision', async () => {
    const baseline = csv(['ID', 'Type', 'SKU', 'Parent', 'Regular price', 'Sale price'], [['1', 'simple', '001', '', '09007199254740993.005', '']]);
    const exact = { ...rule, mode: 'fixed-amount-off', amount: '0.01', rounding: 'none', minimumRetail: '9007199254740993.00' } as const;
    const pack = await buildPromoCampaign('woocommerce', baseline, { rule: exact });
    expect(pack).toMatchObject({ canExport: true, summary: { totalPriceReduction: '0.005' } });
    expect(pack.rows[0]).toMatchObject({ beforePrice: '09007199254740993.005', promoPrice: '9007199254740993.00' });
    const blocked = await buildPromoCampaign('woocommerce', baseline, { rule: { ...exact, minimumRetail: '9007199254740993.0001' } });
    expect(blocked).toMatchObject({ canExport: false, issues: [{ code: 'minimum-retail-breach' }] });
  });

  it('records exact cost overrides and warnings without mutating any source cost columns', async () => {
    const baseline = csv(['ID', 'Type', 'SKU', 'Parent', 'Regular price', 'Sale price', 'Cost per item'], [
      ['1', 'simple', '001', '', '24.00', '', '005.000'],
      ['2', 'simple', '002', '', '26.00', '', '22.00'],
      ['3', 'simple', '003', '', '28.00', '', ''],
    ]);
    const costSheet = csv(['SKU', 'Cost'], [['001', '030.125'], ['2', '0']]);
    const pack = await buildPromoCampaign('woocommerce', baseline, { rule, costCheck: true, costSheet });
    expect(pack.canExport).toBe(true);
    expect(pack.rows).toMatchObject([
      { sku: '001', cost: '030.125', costMargin: '-10.135', costSource: { kind: 'cost-sheet', line: 2, column: 'Cost' } },
      { sku: '002', cost: '22.00', costMargin: '-1.01', costSource: { kind: 'baseline', line: 3, column: 'Cost per item' } },
      { sku: '003', cost: '', costMargin: null, costSource: { kind: 'baseline', line: 4, column: 'Cost per item' } },
    ]);
    expect(pack.issues.map(({ code }) => code)).toEqual(['promo-below-cost', 'promo-below-cost', 'unknown-promo-cost']);
    expect(pack.launchCsv).not.toContain('Cost');
    expect(pack.revertCsv).not.toContain('Cost');
    expect(pack.signoffHtml).toContain('Promo 19.99 is below cost 030.125.');
    expect(pack.custody.costSheetSha256).toMatch(/^[a-f0-9]{64}$/);
    const duplicate = await buildPromoCampaign('woocommerce', baseline, { rule, costSheet: csv(['SKU', 'Cost'], [['001', '1'], ['001', '2']]) });
    expect(duplicate).toMatchObject({ canExport: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'duplicate-cost-sku' })]) });
  });

  it('limits the offline HTML detail while retaining all audit rows', async () => {
    const source = Array.from({ length: 102 }, (_, index) => ['group-' + index, '<svg>' + '&'.repeat(300), 'Title', 'Default Title', '<svg>' + '&'.repeat(300) + index, '30.000', '']);
    const baseline = csv(['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Variant Compare At Price'], source);
    const pack = await buildPromoCampaign('shopify', baseline, { rule, storeLabel: '<svg onload=alert(1)>' });
    expect(pack.canExport).toBe(true);
    expect(pack.signoffHtml!.match(/<tr>/g)).toHaveLength(101);
    expect(pack.signoffHtml!.length).toBeLessThan(100_000);
    expect(pack.signoffHtml).toContain('Content-Security-Policy');
    expect(pack.signoffHtml).toContain("connect-src 'none'");
    expect(pack.signoffHtml).not.toMatch(/<svg|href=/);
    expect(JSON.parse(pack.auditJson).rows).toHaveLength(102);
  });
});
