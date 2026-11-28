import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repairCsvWithBytes } from '../../../src/core';
import { parseCsv } from '../../../src/core/csv';
import { createSupplierRecipe, serializeSupplierRecipe } from '../../../src/core/shopify-price-diff/recipe';
import { serializeWorkspaceProfile } from '../../../src/core/shopify-price-diff/workspace-profile';
import { listWorkbookSheets } from '../../../src/core/xlsx';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = 'scripts/repair-cli.ts';
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const instant = '2026-01-02T10:20:30.000Z';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const fixture = (file: string) => resolve(root, 'fixtures', file);
const readyRepair = fixture('freshbooks-expenses/expenses-verified.csv');
const reviewRepair = fixture('shopify/invalid-variant-price.csv');
// Cold tsx startup competes with the other Vitest workers on Windows.
const costCreepSpawnTimeout = 40_000;
const costCreepTestTimeout = 100_000;
const m21SpawnTimeout = 40_000;
const m21TestTimeout = 100_000;
const poSpawnTimeout = 40_000;
const poTestTimeout = 100_000;
const categorizeSpawnTimeout = 40_000;
const categorizeTestTimeout = 160_000;
const hygieneSpawnTimeout = 40_000;
const hygieneTestTimeout = 100_000;
let scratch: string;

beforeAll(() => {
  const directory = process.env.IMPORT_MEDIC_CLI_TEST_DIR ?? resolve(root, 'test-results', 'cli-automation');
  mkdirSync(directory, { recursive: true });
  scratch = mkdtempSync(resolve(directory, 'run-'));
});
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

function content(name: string, value: string | Uint8Array): string {
  const filename = resolve(scratch, name);
  writeFileSync(filename, value);
  return filename;
}

function cli(args: string[], cwd = root, timeout = 15_000) {
  const run = spawnSync(process.execPath, ['--import', tsx, resolve(root, script), ...args], {
    cwd, windowsHide: true, timeout, env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch },
  });
  if (run.error) throw run.error;
  return { ...run, stdout: run.stdout.toString('utf8'), stderr: run.stderr.toString('utf8') };
}

function verifyReceipt(mode: string, code: 0 | 2, status: string, directory: string,
  args: string[], inputs: Record<string, string>, outputFiles: string[], cwd?: string, timeout = mode === 'cost-creep' ? costCreepSpawnTimeout : undefined) {
  const run = cli(['--mode', mode, ...args, '--out-dir', directory], cwd, timeout);
  const outputPath = resolve(cwd ?? root, directory);
  const diagnostic = run.status === 2 && code !== 2
    ? readdirSync(outputPath).filter(name => /(?:-audit|-report)\.json$/.test(name)).map(name => readFileSync(resolve(outputPath, name), 'utf8')).join('\n')
    : run.stderr;
  expect(run.status, diagnostic).toBe(code);
  expect(run.stderr).toBe('');
  const summary = JSON.parse(run.stdout);
  const filenames = [...outputFiles, 'custody-manifest.json'].sort();
  expect(summary).toMatchObject({ mode, status, exitCode: code });
  expect(summary.outputs.sort()).toEqual(filenames);
  expect(readdirSync(outputPath).sort()).toEqual(filenames);
  const manifest = JSON.parse(readFileSync(resolve(outputPath, 'custody-manifest.json'), 'utf8'));
  const fingerprint = (role: string, path: string) => {
    const bytes = readFileSync(path);
    return { role, filename: basename(path), byteLength: bytes.length, sha256: digest(bytes) };
  };
  expect(manifest).toMatchObject({ version: 1, mode, exitCode: code });
  expect(manifest.inputs).toEqual(Object.entries(inputs).map(([role, path]) => fingerprint(role, path)));
  expect(manifest.outputs.map((file: { filename: string }) => file.filename).sort()).toEqual([...outputFiles].sort());
  const roles = new Set(manifest.outputs.map(({ role }: { role: string }) => role));
  expect(roles.size).toBe(outputFiles.length);
  for (const { role, filename } of manifest.outputs) expect(manifest.outputs.find((file: { role: string }) => file.role === role))
    .toEqual(fingerprint(role, resolve(outputPath, filename)));
  if (code === 2) expect(outputFiles.filter(file => file.endsWith('.csv')))
    .toEqual(mode === 'catalog-hygiene' ? ['catalog-hygiene-issues.csv'] : []);
  return run;
}

const pricingHeaders = 'Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price,Variant Compare At Price,Cost per item\n';
const catalog = (price: string) => pricingHeaders + `part,Spare Part,Title,Default Title,0001,${price},,5.00\nkit,Bundle,Title,Default Title,KIT,20.00,,10.00\n`;

describe('M25 catalog-hygiene CLI subprocess', () => {
  const reports = ['catalog-hygiene-issues.csv', 'catalog-hygiene-audit.json', 'catalog-hygiene-report.html'];
  const readAudit = (directory: string) => JSON.parse(readFileSync(resolve(directory, reports[1]), 'utf8'));
  it('publishes independent verified pairs and hashes the exact workspace profile', () => {
    const source = fixture('m25/shopify-ready.csv');
    const second = content('second-shop.csv', 'Handle,Title,SKU,Price,Barcode\nsecond,Second Store,SECOND-1,1.99,96385074\n');
    const profile = content('hygiene-brand.json', serializeWorkspaceProfile({ version: 1, storeName: 'Northstar Supply', platform: 'shopify', storeCurrency: 'USD',
      branding: { agencyName: 'Northstar Studio', preparedFor: 'Harbor Shops', contactNote: '', accentKey: 'forest' } }));
    const output = resolve(scratch, 'hygiene-ready');
    const pairs = [1, 2].flatMap(index => ['cleaned', 'rollback'].map(kind => 'catalog-hygiene-source-' + index + '-' + kind + '.csv'));
    verifyReceipt('catalog-hygiene', 0, 'ready', output, ['--platform', 'shopify', '--source', source, '--second', second,
      '--trim-skus', '--strip-zero-width', '--workspace-profile', profile], { source, second, 'workspace-profile': profile },
    [...reports, ...pairs], undefined, hygieneSpawnTimeout);
    const file = (filename: string) => readFileSync(resolve(output, filename));
    expect(file(pairs[1])).toEqual(readFileSync(source));
    expect(file(pairs[3])).toEqual(readFileSync(second));
    const row = parseCsv(file(pairs[0]).toString('utf8')).records.find(({ line }) => line === 2);
    expect(row?.cells.slice(2, 5)).toEqual(['AURORA-01', '18.50', '012345678905']);
    expect(file(reports[2]).toString('utf8')).toContain('Northstar Studio');
    const audit = readAudit(output);
    expect(audit.status).toBe('READY');
    expect(audit.custody.workspaceProfile).toMatchObject({ filename: basename(profile), sha256: digest(readFileSync(profile)) });
    expect(audit.custody.outputs).toEqual([reports[0], reports[2], ...pairs].map(filename => {
      const bytes = file(filename);
      return { filename, byteLength: bytes.length, sha256: digest(bytes) };
    }));
  }, hygieneTestTimeout);

  it('exits 2 and publishes only diagnostic artifacts on a bad EAN or a cross-platform SKU collision', () => {
    const source = fixture('m25/shopify-hold.csv');
    const hold = resolve(scratch, 'hygiene-held');
    verifyReceipt('catalog-hygiene', 2, 'blocked', hold, ['--platform', 'shopify', '--source', source], { source }, reports, undefined, hygieneSpawnTimeout);
    const audit = readAudit(hold);
    expect(audit.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid-gtin-check-digit', line: 2, suppliedCheckDigit: '2', expectedCheckDigit: '1' }),
      expect.objectContaining({ code: 'duplicate-sku-case', line: 2, related: [{ sourceIndex: 1, line: 5 }] }),
    ]));
    expect(audit.custody.outputs.map(({ filename }: { filename: string }) => filename)).toEqual([reports[0], reports[2]]);

    const primary = fixture('m25/shopify-ready.csv');
    const second = fixture('m25/woocommerce-second.csv');
    const cross = resolve(scratch, 'hygiene-cross-held');
    verifyReceipt('catalog-hygiene', 2, 'blocked', cross, ['--platform', 'shopify', '--source', primary,
      '--second', second, '--second-platform', 'woocommerce', '--trim-skus', '--strip-zero-width'], { source: primary, second },
    reports, undefined, hygieneSpawnTimeout);
    expect(readAudit(cross).issues).toContainEqual(expect.objectContaining({
      code: 'duplicate-sku-cleanup', sourceIndex: 1, line: 2, related: [{ sourceIndex: 2, line: 2 }],
    }));
  }, hygieneTestTimeout);
});

describe('M24 wholesale-sheet CLI subprocess', () => {
  const baseline = fixture('m24/wholesale-shopify.csv');
  const options = fixture('m24/wholesale-options.json');
  const workbook = fixture('m24/wholesale-costs.xlsx');
  const unsafe = fixture('m24/wholesale-map-hold.csv');
  const auditName = 'wholesale-margin-audit.json';
  const defaults = ['--platform', 'shopify', '--baseline', baseline, '--options', options];
  const files = [auditName, 'northstar-supply-wholesale-buyer-sheet.csv', 'northstar-supply-shopify-b2b-catalog.csv',
    'northstar-supply-wholesale-line-sheet.html', 'northstar-supply-wholesale-margin-matrix.csv'];

  it('publishes a branded ready 3-tier pack with verified receipts for the workbook, options and every artifact', () => {
    const output = resolve(scratch, 'wholesale-ready');
    const profile = content('wholesale-brand.json', serializeWorkspaceProfile({ version: 1, storeName: 'Northstar Supply',
      platform: 'shopify', storeCurrency: 'USD',
      branding: { agencyName: 'Example Design', preparedFor: '', contactNote: '', accentKey: 'navy' } }));
    verifyReceipt('wholesale-sheet', 0, 'ready', output, [...defaults, '--cost-sheet', workbook, '--cost-sheet-tab', 'Wholesale Costs',
      '--workspace-profile', profile], { baseline, options, 'cost-sheet': workbook, 'workspace-profile': profile }, files, undefined, 40_000);
    const [auditRaw, buyer, shopify, html, merchant] = files.map(name => readFileSync(resolve(output, name), 'utf8'));
    const audit = JSON.parse(auditRaw);
    expect(audit.selectedWorksheet).toBe('Wholesale Costs');
    expect(audit.custody).toMatchObject({ baselineSha256: digest(readFileSync(baseline)), costSheetSha256: digest(readFileSync(workbook)),
      buyerSha256: digest(Buffer.from(buyer)), shopifySha256: digest(Buffer.from(shopify)), lineSheetSha256: digest(Buffer.from(html)),
      internalSha256: digest(Buffer.from(merchant)) });
    expect(parseCsv(buyer).records[1].cells.slice(0, 4)).toEqual(['00007', 'Travel Mug\n12 oz', '6', '12']);
    expect(parseCsv(shopify).records[1].cells).toEqual(['Northstar Wholesale Silver', '00007', '', '', '34.97', '6', '54']);
    expect(html).toContain('Example Design');
    expect(merchant).toContain('17.31');
    for (const output of [buyer, shopify, html]) expect(output).not.toMatch(/17\.31|Landed Cost|Gross Margin|SHA-256/);
  }, 120_000);

  it('publishes only the diagnostic audit and manifest on MAP and margin holds', () => {
    const mapPath = resolve(scratch, 'wholesale-map-hold');
    verifyReceipt('wholesale-sheet', 2, 'blocked', mapPath, [...defaults, '--cost-sheet', unsafe],
      { baseline, options, 'cost-sheet': unsafe }, [auditName], undefined, 40_000);
    const mapAudit = JSON.parse(readFileSync(resolve(mapPath, auditName), 'utf8'));
    expect(mapAudit.issues[0]).toMatchObject({ code: 'below-map', tierName: 'Silver', sku: '00007', line: 2, baselineLine: 2, costLine: 2 });
    expect(mapAudit.custody).toEqual({ baselineSha256: digest(readFileSync(baseline)), costSheetSha256: digest(readFileSync(unsafe)),
      buyerSha256: null, shopifySha256: null, lineSheetSha256: null, internalSha256: null });
    const marginPath = resolve(scratch, 'wholesale-margin-hold');
    const marginOptions = content('wholesale-margin-options.json', JSON.stringify({ ...JSON.parse(readFileSync(options, 'utf8')),
      minimumMarginPercent: '80' }));
    const safe = fixture('m24/wholesale-costs.csv');
    verifyReceipt('wholesale-sheet', 2, 'blocked', marginPath,
      ['--platform', 'shopify', '--baseline', baseline, '--options', marginOptions, '--cost-sheet', safe],
      { baseline, options: marginOptions, 'cost-sheet': safe }, [auditName], undefined, 40_000);
    const marginAudit = JSON.parse(readFileSync(resolve(marginPath, auditName), 'utf8'));
    expect(marginAudit.issues[0]).toMatchObject({ code: 'below-minimum-margin', sku: '00007', tierName: 'Bronze' });
  }, 120_000);
});

describe('M23 categorization CLI subprocess', () => {
  const source = fixture('m23/transactions.csv');
  const rules = fixture('m23/rules.json');
  const conflictRules = fixture('m23/conflict-rules.json');
  const categorized = 'categorized-transactions.csv';
  const summary = 'account-summary.csv';
  const auditName = 'categorization-audit.json';
  const signoff = 'bookkeeper-categorization-sign-off.html';

  it('publishes only verified artifacts and preserves an existing batch on a held rerun', () => {
    const profile = content('categorization-profile.json', JSON.stringify({ version: 1, storeName: 'Example Client', platform: 'shopify', storeCurrency: 'GBP', branding: {
      agencyName: 'Ledger team', preparedFor: 'Example Client', contactNote: 'Markup <strong> //office.invalid', accentKey: 'navy',
    } }));
    const ready = resolve(scratch, 'categorization-ready');
    verifyReceipt('categorize', 0, 'ready', ready, [source, '--rules', rules, '--workspace-profile', profile],
      { source, rules, 'workspace-profile': profile }, [categorized, summary, auditName, signoff], undefined, categorizeSpawnTimeout);
    const readReady = (name: string) => readFileSync(resolve(ready, name));
    const audit = JSON.parse(readReady(auditName).toString('utf8'));
    expect(audit.metrics).toEqual({ totalRows: 5, categorizedRows: 4, uncategorizedRows: 1, ambiguousConflicts: 0 });
    expect(audit.custody.outputs.map(({ sha256 }: { sha256: string }) => sha256)).toEqual([categorized, summary, signoff].map(name => digest(readReady(name))));
    expect(audit.custody.workspaceProfile.sha256).toBe(digest(readFileSync(profile)));
    expect(readReady(signoff).toString('utf8')).toContain('Prepared by <strong>Ledger team</strong>');
    expect(readReady(signoff).toString('utf8')).not.toContain('//office.invalid');
    const transactions = parseCsv(readReady(categorized).toString('utf8')).records;
    expect(transactions[1].cells.slice(5)).toEqual(['6100', 'Cloud services', 'UK-VAT20', '-100.00', '-20.00', 'aws-uk']);
    expect(transactions[2].cells.slice(5)).toEqual(['6100', 'Cloud services', 'UAE-VAT5', '-100.00', '-5.00', 'aws-uae']);

    const held = resolve(scratch, 'categorization-held');
    verifyReceipt('categorize', 2, 'blocked', held, [source, '--rules', conflictRules], { source, rules: conflictRules },
      [auditName], undefined, categorizeSpawnTimeout);
    const diagnostic = JSON.parse(readFileSync(resolve(held, auditName), 'utf8'));
    expect(diagnostic.issues).toMatchObject([{ code: 'ambiguous-rule-match', line: 2, matchingRuleIds: ['aws-uk', 'aws-overlap'] }]);
    expect(diagnostic.custody).not.toHaveProperty('outputs');

    const existing = cli(['--mode', 'categorize', source, '--rules', conflictRules, '--out-dir', ready], root, categorizeSpawnTimeout);
    expect(existing.status).toBe(1);
    expect(existing.stderr).toContain('Existing artifacts were preserved.');
    expect(digest(readReady(categorized))).toBe(audit.custody.outputs[0].sha256);
  }, categorizeTestTimeout);
});

describe('M22 purchase order CLI subprocess', () => {
  const baseline = fixture('purchase-order/store-inventory.csv');
  const harbor = fixture('purchase-order/harbor-supply.csv');
  const metro = fixture('purchase-order/metro-wholesale.csv');

  it('publishes a branded split order and matches both custody manifests against actual bytes', () => {
    const profile = content('agency-brand.json', JSON.stringify({ version: 1, storeName: 'Shop', platform: 'shopify', storeCurrency: 'USD',
      branding: { agencyName: 'CLI <Warehouse>', preparedFor: 'Shop', contactNote: 'https://example.invalid/warehouse', accentKey: 'forest' } }));
    const destination = resolve(scratch, 'po-ready');
    const orders = ['po-harbor-supply.csv', 'po-metro-wholesale.csv', 'po-consolidated-summary.csv', 'purchase-order-pack.html'];
    verifyReceipt('purchase-order', 0, 'ready', destination, ['--baseline', baseline, '--supplier', harbor, '--supplier-label', 'Harbor Supply',
      '--supplier', metro, '--supplier-label-b64', b64('Metro Wholesale'), '--target-location-b64', b64('East'), '--po-reference', 'PO-017',
      '--workspace-profile', profile], { baseline, 'supplier-1': harbor, 'supplier-2': metro, 'workspace-profile': profile },
    ['po-audit.json', ...orders], root, poSpawnTimeout);
    const audit = JSON.parse(readFileSync(resolve(destination, 'po-audit.json'), 'utf8'));
    expect(audit).toMatchObject({ targetLocation: 'East', summary: { totalCents: 5000, totalSpend: '50.00', supplierCount: 2, unitsOrdered: 20 },
      custody: { inventory: { sha256: digest(readFileSync(baseline)) }, suppliers: [harbor, metro].map(path => ({ sha256: digest(readFileSync(path)) })),
        workspaceProfile: { sha256: digest(readFileSync(profile)) },
        outputs: orders.map(filename => {
          const bytes = readFileSync(resolve(destination, filename));
          return { filename, byteLength: bytes.byteLength, sha256: digest(bytes) };
        }),
      },
    });
    const summaryCsv = parseCsv(readFileSync(resolve(destination, orders[2]), 'utf8'));
    expect(summaryCsv.records.slice(1).map(({ cells }) => cells)).toEqual([
      ['00123', '3', '3', '12', 'Harbor Supply', '2.00', '24.00'], ['00007', '2', '4', '8', 'Metro Wholesale', '3.25', '26.00'],
    ]);
    const html = readFileSync(resolve(destination, orders[3]), 'utf8');
    expect(html).toContain('CLI &lt;Warehouse&gt;');
    expect(html).toContain('PO-017');
    expect(html).toContain(digest(readFileSync(profile)));
    expect(html).not.toMatch(/<script|\b(?:href|src)=|https?:|\/\//i);
  }, poTestTimeout);

  it('publishes only source-backed diagnostics for an exact cost tie and invalid pack', () => {
    const tie = content('tied-offers.csv', 'SKU,Unit Cost,MOQ,Case Pack\n00123,1.20,20,4\n00007,3.25,6,4');
    const invalid = fixture('purchase-order/invalid-offers.csv');
    for (const [name, supplier, policy, issue] of [
      ['po-tie', tie, 'block-ties', { code: 'supplier-cost-tie', sku: '00123', line: 2,
        offers: [{ supplierIndex: 0, line: 2 }, { supplierIndex: 1, line: 2 }] }],
      ['po-invalid-pack', invalid, 'prefer-first', { code: 'invalid-case-pack', sku: '00123', line: 2, supplierIndex: 1, value: '0' }],
    ] as const) {
      const destination = resolve(scratch, name);
      verifyReceipt('purchase-order', 2, 'blocked', destination, ['--baseline', baseline, '--supplier', harbor,
        '--supplier', supplier, '--target-location', 'East', '--supplier-policy', policy],
      { baseline, 'supplier-1': harbor, 'supplier-2': supplier }, ['po-audit.json'], root, poSpawnTimeout);
      const audit = JSON.parse(readFileSync(resolve(destination, 'po-audit.json'), 'utf8'));
      expect(audit.issues).toMatchObject([issue]);
      expect(audit.custody.suppliers[1].sha256).toBe(digest(readFileSync(supplier)));
      expect(audit.custody).not.toHaveProperty('outputs');
    }
  }, poTestTimeout);
});

describe('M21 native CLI subprocess', () => {
  it('writes Amazon text files and independently verifies the matched rollback', () => {
    const baseline = content('amazon-base.txt', readFileSync(fixture('amazon/price-quantity.tsv')));
    const supplier = fixture('amazon/proposed.csv');
    const built = resolve(scratch, 'amazon-built');
    const update = resolve(built, 'amazon-update.txt');
    const rollback = resolve(built, 'amazon-rollback.txt');
    verifyReceipt('price-diff', 0, 'ready', built, ['--platform', 'amazon', '--baseline', baseline, '--supplier', supplier],
      { baseline, supplier }, ['amazon-update.txt', 'amazon-rollback.txt', 'price-audit.json'], root, m21SpawnTimeout);
    expect(readFileSync(update, 'utf8')).toBe('sku\tprice\tquantity\r\n00007\t11.25\t0\r\n00008\t19.99\t');
    expect(readFileSync(rollback, 'utf8')).toBe('sku\tprice\tquantity\r\n00007\t010.00\t007\r\n00008\t20.00\t');
    const verified = resolve(scratch, 'amazon-verified');
    verifyReceipt('verify', 0, 'PASS', verified,
      ['--platform', 'amazon', '--baseline', baseline, '--candidate', rollback, '--matched-update', update],
      { baseline, candidate: rollback, 'matched-update': update }, ['verify-report.json'], root, m21SpawnTimeout);
    expect(JSON.parse(readFileSync(resolve(verified, 'verify-report.json'), 'utf8'))).toMatchObject({ verdict: 'PASS', nonTargetMutations: 0,
      rollback: { restored: true, residualDiffs: 0, pairedUpdateSha256: digest(readFileSync(update)) } });
  }, m21TestTimeout);

  it('holds out-of-corridor Amazon files in build and standalone verify', () => {
    const baseline = fixture('amazon/price-quantity.tsv');
    const supplier = fixture('amazon/outside-corridor.tsv');
    const built = resolve(scratch, 'amazon-held');
    verifyReceipt('price-diff', 2, 'blocked', built, ['--platform', 'amazon', '--baseline', baseline, '--supplier', supplier],
      { baseline, supplier }, ['price-audit.json'], root, m21SpawnTimeout);
    const audit = JSON.parse(readFileSync(resolve(built, 'price-audit.json'), 'utf8'));
    expect(audit).toMatchObject({ issues: [{ code: 'amazon-price-outside-corridor', baselineLine: 2, candidateLine: 4 }] });
    expect(audit.custody).not.toHaveProperty('updateSha256');
    const verified = resolve(scratch, 'amazon-unsafe');
    verifyReceipt('verify', 2, 'FAIL_UNSAFE', verified,
      ['--platform', 'amazon', '--baseline', baseline, '--candidate', supplier],
      { baseline, candidate: supplier }, ['verify-report.json'], root, m21SpawnTimeout);
    expect(JSON.parse(readFileSync(resolve(verified, 'verify-report.json'), 'utf8'))).toMatchObject({ verdict: 'FAIL_UNSAFE',
      issues: [{ code: 'amazon-price-outside-corridor', baselineLine: 2, candidateLine: 4 }] });
  }, m21TestTimeout);

  it('holds the same tax mismatch and duplicates in explicit and legacy repair', () => {
    const source = fixture('accounting/tax-duplicate.csv');
    const held = resolve(scratch, 'accounting-held');
    verifyReceipt('repair', 2, 'blocked', held, ['--platform', 'quickbooks-bank', source, '--generated-at', instant],
      { source }, ['repair-audit.json', 'bookkeeper-sign-off.html'], root, m21SpawnTimeout);
    const audit = JSON.parse(readFileSync(resolve(held, 'repair-audit.json'), 'utf8'));
    expect(audit).toMatchObject({ retainedRowCount: 3, canDownload: false,
      taxReconciliation: { mismatchCount: 1, mismatches: [{ row: 4, delta: '0.01' }] },
      duplicateTransactions: { groupCount: 1, affectedRows: 2, groups: [{ lines: [2, 4] }] } });
    expect(audit.custody).not.toHaveProperty('repairedCsvSha256');
    expect(readFileSync(resolve(held, 'bookkeeper-sign-off.html'), 'utf8')).toContain('<td>2, 4</td>');
    const legacy = resolve(scratch, 'accounting-legacy-audit.json');
    const run = cli(['--platform', 'quickbooks-bank', source, '--audit', legacy], root, m21SpawnTimeout);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(JSON.parse(readFileSync(legacy, 'utf8'))).toMatchObject({
      taxReconciliation: audit.taxReconciliation, duplicateTransactions: audit.duplicateTransactions });
  }, m21TestTimeout);
});

describe('M20 real cost-creep CLI subprocess', () => {
  it('writes exact branded reports or holds every analysis artifact on ambiguous data', () => {
    const q1 = fixture('cost-creep/q1.csv');
    const q2 = fixture('cost-creep/q2.csv');
    const q3 = fixture('cost-creep/q3.csv');
    const q4 = fixture('cost-creep/q4.csv');
    const baseline = fixture('cost-creep/store-retail.csv');
    const profile = content('agency.json', JSON.stringify({ version: 1, platform: 'shopify', storeName: 'Studio', storeCurrency: 'USD',
      branding: { agencyName: 'Sand & Sea', preparedFor: 'Buyer', contactNote: 'Offline review', accentKey: 'navy' } }));
    const periodArgs = ['--period', q1, '--period-label-b64', b64('Q1 · Prior'), '--period-cost-column-b64', b64('Cost USD'),
      '--period', q2, '--period-label', 'Q2', '--period', q3, '--period-label', 'Q3'];
    const ready = resolve(scratch, 'cost-creep-quarterly');
    verifyReceipt('cost-creep', 0, 'ready', ready, [...periodArgs, '--period', q4, '--period-label', 'Q4',
      '--baseline', baseline, '--baseline-retail-column', 'Retail Price USD', '--workspace-profile', profile, '--creep-threshold-percent', '10.000'],
    { 'period-1': q1, 'period-2': q2, 'period-3': q3, 'period-4': q4, baseline, 'workspace-profile': profile },
    ['supplier-cost-creep.csv', 'supplier-cost-creep-audit.json', 'vendor-negotiation-brief.html']);
    const report = readFileSync(resolve(ready, 'vendor-negotiation-brief.html'));
    const history = readFileSync(resolve(ready, 'supplier-cost-creep.csv'));
    const audit = JSON.parse(readFileSync(resolve(ready, 'supplier-cost-creep-audit.json'), 'utf8'));
    expect(report.toString()).toContain('Prepared by <strong>Sand &amp; Sea</strong>');
    expect(audit.custody).toMatchObject({ historyCsvSha256: digest(history), briefHtmlSha256: digest(report),
      periods: [{ label: 'Q1 · Prior' }, { label: 'Q2' }, { label: 'Q3' }, { label: 'Q4' }] });
    expect(parseCsv(history.toString()).records[1].cells[0]).toBe('00098');

    const conflicted = fixture('cost-creep/conflicting-offers.csv');
    const held = resolve(scratch, 'cost-creep-held');
    verifyReceipt('cost-creep', 2, 'blocked', held, [...periodArgs, '--period', conflicted, '--period-label', 'Q4'],
      { 'period-1': q1, 'period-2': q2, 'period-3': q3, 'period-4': conflicted }, ['supplier-cost-creep-audit.json']);
    const heldAudit = JSON.parse(readFileSync(resolve(held, 'supplier-cost-creep-audit.json'), 'utf8'));
    expect(heldAudit.custody).not.toHaveProperty('briefHtmlSha256');
    expect(heldAudit.custody).not.toHaveProperty('historyCsvSha256');
    expect(heldAudit.issues).toMatchObject([{ code: 'conflicting-duplicate-sku', periodLabel: 'Q4', rows: [2, 4] }]);
  }, costCreepTestTimeout);

  it('resolves named visible sheets and literal digit headers, and rejects worksheet options on CSV', () => {
    const before = content('digit-header.csv', 'SKU,1\n00042,8.00\n');
    const sheet = fixture('shopify-price-diff/supplier-agency.xlsx');
    const names = listWorkbookSheets(readFileSync(sheet));
    const label = 'Earlier';
    const ready = resolve(scratch, 'cost-creep-named-sheet');
    verifyReceipt('cost-creep', 0, 'ready', ready, ['--period', before, '--period-label', label, '--period-cost-column', '1',
      '--period', sheet, '--period-label', 'Later', '--period-sheet-b64', b64(names[0]), '--period-sku-column', 'SKU',
      '--period-cost-column', 'New Price'],
    { 'period-1': before, 'period-2': sheet },
    ['supplier-cost-creep.csv', 'supplier-cost-creep-audit.json', 'vendor-negotiation-brief.html']);
    const audit = JSON.parse(readFileSync(resolve(ready, 'supplier-cost-creep-audit.json'), 'utf8'));
    expect(audit.custody.periods[1].selectedSheet).toBe(names[0]);

    const held = resolve(scratch, 'cost-creep-csv-worksheet');
    verifyReceipt('cost-creep', 2, 'blocked', held, ['--period', before, '--period-label', label, '--period-cost-column', '1',
      '--period-sheet', 'Unexpected', '--period', before, '--period-label', 'Later', '--period-cost-column', '1'],
    { 'period-1': before, 'period-2': before }, ['supplier-cost-creep-audit.json']);
    const heldAudit = JSON.parse(readFileSync(resolve(held, 'supplier-cost-creep-audit.json'), 'utf8'));
    expect(heldAudit.issues).toMatchObject([{ code: 'unexpected-worksheet', periodLabel: label, value: 'Unexpected' }]);
  }, costCreepTestTimeout);
});

describe('M19 real CLI subprocess', () => {
  it('publishes exact scoped CAS bytes and holds the same inputs without a location', () => {
    const baseline = fixture('inventory-sync/synthetic-shopify-baseline.csv');
    const supplier = fixture('inventory-sync/synthetic-supplier.csv');
    const second = content('another-supplier.csv', 'Stock,SKU\n00011,00042\n');
    const baseArgs = ['--baseline', baseline, '--supplier', supplier, '--sku-column-b64', b64('Supplier SKU'),
      '--quantity-column', '2', '--supplier', second, '--sku-column', 'SKU', '--quantity-column', 'Stock',
      '--reserve-units', '2', '--zero-out-threshold', '2'];
    const inputs = { baseline, 'supplier-1': supplier, 'supplier-2': second };
    const good = resolve(scratch, 'inventory-good');
    const reportFiles = ['inventory-audit.json', 'inventory-sign-off.html'];
    verifyReceipt('inventory-sync', 0, 'ready', good, [...baseArgs, '--target-location-b64', b64('Warehouse A')], inputs,
      [...reportFiles, 'inventory-update.csv', 'inventory-rollback.csv']);
    const update = readFileSync(resolve(good, 'inventory-update.csv'));
    const rollback = readFileSync(resolve(good, 'inventory-rollback.csv'));
    const qty = (file: Buffer) => parseCsv(file.toString('utf8')).records.slice(1).map(({ cells }) => cells.slice(-4));
    expect(qty(update)).toEqual([['00042', 'Warehouse A', '0007', '9'], ['00087', 'Warehouse A', '0002', '6']]);
    expect(qty(rollback)).toEqual([['00042', 'Warehouse A', '9', '0007'], ['00087', 'Warehouse A', '6', '0002']]);
    const audit = JSON.parse(readFileSync(resolve(good, 'inventory-audit.json'), 'utf8'));
    expect(audit).toMatchObject({ status: 'ready', targetLocation: 'Warehouse A',
      custody: { updateCsvSha256: digest(update), rollbackCsvSha256: digest(rollback) } });
    const html = readFileSync(resolve(good, 'inventory-sign-off.html'), 'utf8');
    for (const data of [readFileSync(baseline), readFileSync(supplier), readFileSync(second), update, rollback]) expect(html).toContain(digest(data));

    const held = resolve(scratch, 'inventory-held');
    verifyReceipt('inventory-sync', 2, 'blocked', held, baseArgs, inputs, reportFiles);
    const heldAudit = JSON.parse(readFileSync(resolve(held, 'inventory-audit.json'), 'utf8'));
    expect(heldAudit.issues).toMatchObject([{ code: 'target-location-required' }]);
    expect(heldAudit.custody.updateCsvSha256).toBeUndefined();
    expect(heldAudit.custody.rollbackCsvSha256).toBeUndefined();
  }, 45_000);
});

describe('M18 real CLI subprocess', () => {
  it('preserves the original help, audit, CSV streams and reviewable exit 2', () => {
    expect(cli(['--help']).stdout).toBe('Usage: npm run repair-cli -- --platform <shopify-products|quickbooks-bank|stripe-paypal|xero-bank|freshbooks-expenses> <input.csv>\n' +
      '  --output <repaired.csv>              Write CSV to a new file (default: stdout)\n' +
      '  --audit <audit.json>                 Write JSON audit to a new file\n' +
      '  --date-order <auto|MDY|DMY>           Source date order\n' +
      '  --qbo-layout <3col|4col>               QuickBooks output layout\n' +
      '  --qbo-credit-debit <auto|bank|intuit>  Source Credit/Debit convention\n' +
      '  --stripe-paypal-output <accounting|quickbooks-3col>\n' +
      '  --stripe-paypal-fee-convention <auto|deduction|signed-movement>\n' +
      '  --exclude-paypal-memo                 Exclude PayPal rows without balance impact\n');
    const auditPath = resolve(scratch, 'legacy-audit.json');
    const reviewed = cli(['--platform', 'shopify-products', reviewRepair, '--audit', auditPath]);
    const source = readFileSync(reviewRepair);
    const { result, verifiedBytes } = repairCsvWithBytes(source, basename(reviewRepair), 'shopify-products', {}, []);
    expect(reviewed.status).toBe(2);
    expect(verifiedBytes).not.toBeNull();
    expect(reviewed.stdout).toBe(Buffer.from(verifiedBytes!).toString('utf8'));
    expect(reviewed.stderr).toBe(`${result.rows.length} data rows, ${result.removedRows.length} removed, ${result.needsManualReviewCount} review items. CSV export validated.\n`);
    const { repairedCsv, rows, ...audit } = result;
    expect(readFileSync(auditPath, 'utf8')).toBe(JSON.stringify({ ...audit, rowCount: rows.length,
      custody: { sourceSha256: digest(source), repairedCsvSha256: digest(verifiedBytes!) } }, null, 2) + '\n');
    content('--mode', readFileSync(readyRepair));
    expect(cli(['--platform', 'freshbooks-expenses', '--', '--mode'], scratch).status).toBe(0);
    expect(cli(['--platform', 'freshbooks-expenses']).stderr).toBe('Provide exactly one CSV input path. Run with --help for available options.\n');
  }, 45_000);

  it('issues repair artifacts only for fully cleared source rows', () => {
    const safeDir = resolve(scratch, 'repair-good');
    mkdirSync(safeDir);
    const flags = ['--platform', 'freshbooks-expenses', '--generated-at', instant, '--formula-guard', readyRepair];
    const ready = ['repaired.csv', 'repair-audit.json', 'bookkeeper-sign-off.html'];
    verifyReceipt('repair', 0, 'ready', safeDir, flags, { source: readyRepair }, ready);
    const again = resolve(scratch, 'repair-repeat');
    verifyReceipt('repair', 0, 'ready', again, flags, { source: readyRepair }, ready);
    expect(readFileSync(resolve(again, 'custody-manifest.json'))).toEqual(readFileSync(resolve(safeDir, 'custody-manifest.json')));
    expect(readFileSync(resolve(safeDir, 'bookkeeper-sign-off.html'), 'utf8')).toContain(instant);
    const blocked = resolve(scratch, 'repair-held');
    verifyReceipt('repair', 2, 'blocked', blocked, ['--platform', 'shopify-products', reviewRepair],
      { source: reviewRepair }, ['repair-audit.json', 'bookkeeper-sign-off.html']);
    const audit = JSON.parse(readFileSync(resolve(blocked, 'repair-audit.json'), 'utf8'));
    expect(audit).toMatchObject({ canDownload: false, needsManualReviewCount: 1, custody: { sourceSha256: digest(readFileSync(reviewRepair)) } });
    expect(audit.custody.repairedCsvSha256).toBeUndefined();
    expect(readFileSync(resolve(blocked, 'bookkeeper-sign-off.html'), 'utf8')).toContain('<strong>Repaired CSV</strong> Blocked');
  }, 45_000);

  it('uses the original recipe and BOM bytes and verifies the exact native update pair', () => {
    const baseline = content('store.csv', catalog('10.00'));
    const supplier = content('pricebook.csv', 'SKU,Cost\n0001,6.00\n');
    const recipe = createSupplierRecipe('Vendor', ['SKU', 'Cost'], { joinKey: 'sku', skuColumn: 0, priceColumn: 1,
      confirmed: true, pricingRule: { mode: 'multiplier', multiplier: '2' } }, null);
    if (!recipe.ok) throw new Error('Expected the fixture to be a valid recipe.');
    const recipePath = content('rules.json', serializeSupplierRecipe(recipe.value));
    const bom = content('parts.csv', 'Bundle SKU,Component SKU,Quantity\nKIT,0001,2\n');
    const outDir = resolve(scratch, 'price-good');
    const args = ['--platform', 'shopify', '--baseline', baseline, '--supplier', supplier, '--recipe', recipePath,
      '--confirm-mapping', '--bom', bom, '--store-label-b64', b64('Client $(literal) <script>')];
    verifyReceipt('price-diff', 0, 'ready', outDir, args, { baseline, 'supplier-1': supplier, 'recipe-1': recipePath, bom },
      ['price-update.csv', 'price-rollback.csv', 'price-audit.json', 'client-sign-off.html']);
    expect(readFileSync(resolve(outDir, 'client-sign-off.html'), 'utf8')).toContain('Client $(literal) &lt;script&gt;');
    const update = resolve(outDir, 'price-update.csv');
    const rollback = resolve(outDir, 'price-rollback.csv');
    const corrupt = content('corrupt.json', '{"version":1,"version":1}');
    verifyReceipt('price-diff', 2, 'blocked', resolve(scratch, 'price-held'),
      ['--platform', 'shopify', '--baseline', baseline, '--supplier', supplier, '--recipe', corrupt, '--bom', bom],
      { baseline, 'supplier-1': supplier, 'recipe-1': corrupt, bom }, ['price-audit.json']);
    verifyReceipt('verify', 0, 'PASS', resolve(scratch, 'verify-good'),
      ['--platform', 'shopify', '--baseline', baseline, '--candidate', rollback, '--matched-update', update],
      { baseline, candidate: rollback, 'matched-update': update }, ['verify-report.json']);
    const tampered = content('tampered.csv', readFileSync(update, 'utf8').replace('Spare Part', 'Changed Title'));
    verifyReceipt('verify', 2, 'FAIL_UNSAFE', resolve(scratch, 'verify-held'),
      ['--platform', 'shopify', '--baseline', baseline, '--candidate', tampered], { baseline, candidate: tampered }, ['verify-report.json']);
    const noGuess = resolve(scratch, 'price-ambiguous');
    verifyReceipt('price-diff', 2, 'blocked', noGuess, ['--platform', 'shopify', '--baseline', baseline, '--supplier', supplier, '--confirm-mapping'],
      { baseline, 'supplier-1': supplier }, ['price-audit.json']);
    expect(readFileSync(resolve(noGuess, 'price-audit.json'), 'utf8')).toContain('ambiguous-cli-mapping');
  }, 60_000);

  it('uses native promo names and suppresses both CSVs when the discount is unsafe', () => {
    const baseline = content('sale.csv', catalog('10.00'));
    const args = ['--platform', 'shopify', '--baseline', baseline, '--discount-mode', 'percent-off', '--minimum-retail', '1.00',
      '--sku-b64', b64('0001'), '--store-label', 'Spring Sale'];
    verifyReceipt('promo', 0, 'ready', resolve(scratch, 'promo-good'), [...args, '--discount-amount', '15'], { baseline },
      ['spring-sale-promo-launch.csv', 'spring-sale-promo-revert.csv', 'spring-sale-promo-audit.json', 'spring-sale-promo-sign-off.html']);
    verifyReceipt('promo', 2, 'blocked', resolve(scratch, 'promo-held'), [...args, '--discount-amount', '101'], { baseline }, ['spring-sale-promo-audit.json']);
    const costSheet = fixture('supplier-delta/synthetic-pricebook.xlsx');
    const badCost = resolve(scratch, 'promo-ambiguous-cost');
    verifyReceipt('promo', 2, 'blocked', badCost, [...args, '--discount-amount', '15', '--cost-sheet', costSheet],
      { baseline, 'cost-sheet': costSheet }, ['spring-sale-promo-audit.json']);
    expect(readFileSync(resolve(badCost, 'spring-sale-promo-audit.json'), 'utf8')).toContain('multiple-cost-worksheets');
  }, 45_000);

  it('holds unconfirmed supplier conflicts and associates review choices with supplier physical rows', () => {
    const baseline = content('batch-store.csv', catalog('10.00'));
    const first = content('batch-first.csv', 'SKU,Price\n0001,12.00\n');
    const second = content('batch-second.csv', 'SKU,Price\n0001,13.00\n');
    const files = { baseline, 'supplier-1': first, 'supplier-2': second };
    const args = ['--platform', 'shopify', '--baseline', baseline, '--supplier', first, '--label', 'First', '--supplier', second,
      '--label-b64', b64('Second $(literal)'), '--conflict-policy', 'prefer-last'];
    verifyReceipt('price-diff', 2, 'blocked', resolve(scratch, 'batch-held'), args, files, ['price-audit.json', 'client-sign-off.html']);
    const outDir = resolve(scratch, 'batch-good');
    const goodFiles = ['price-update.csv', 'price-rollback.csv', 'price-audit.json', 'client-sign-off.html'];
    verifyReceipt('price-diff', 0, 'ready', outDir, [...args, '--confirm-conflict-policy'], files, goodFiles);
    expect(readFileSync(resolve(outDir, 'price-update.csv'), 'utf8')).toContain('13.00');
    const choices = b64(JSON.stringify({ 2: { 2: { skip: true } } }));
    const reviewed = resolve(scratch, 'batch-reviewed');
    verifyReceipt('price-diff', 0, 'ready', reviewed, [...args, '--resolutions-b64', choices], files, goodFiles);
    expect(readFileSync(resolve(reviewed, 'price-update.csv'), 'utf8')).toContain('12.00');
  }, 45_000);

  it('requires the exact visible XLSX name and accepts explicit delta mappings', () => {
    const fixtureBytes = readFileSync(fixture('supplier-delta/synthetic-pricebook.xlsx'));
    const archive = unzipSync(fixtureBytes);
    const workbookPath = 'xl/workbook.xml';
    const sheetName = 'دفتر $(echo inert)';
    archive[workbookPath] = strToU8(strFromU8(archive[workbookPath]).replace('name="Q4_Prices"', `name="${sheetName}"`));
    expect(listWorkbookSheets(zipSync(archive))).toContain(sheetName);
    const previous = content('earlier.xlsx', zipSync(archive));
    const next = content('current.xlsx', zipSync(archive));
    const args = ['--previous', previous, '--next', next, '--next-sheet-b64', b64(sheetName)];
    const options = ['--previous-inventory-column', 'none', '--next-inventory-column', 'none'];
    verifyReceipt('supplier-delta', 0, 'ready', resolve(scratch, 'delta-good'), [...args, ...options, '--previous-sheet-b64', b64(sheetName)],
      { previous, next }, ['supplier-delta-audit.json', 'supplier-delta-report.csv', 'supplier-delta-sign-off.html']);
    verifyReceipt('supplier-delta', 2, 'blocked', resolve(scratch, 'delta-held'), [...args, '--previous-sheet', 'Absent'],
      { previous, next }, ['supplier-delta-audit.json']);
    const exactPrevious = content('exact-prior.csv', 'SKU,Cost,none,Inventory,Stock\n0001,1.00,2,3,4\n');
    const exactNext = content('exact-next.csv', 'SKU,Cost,none,Inventory,Stock\n0001,2.00,4,5,6\n');
    verifyReceipt('supplier-delta', 0, 'ready', resolve(scratch, 'delta-columns'), ['--previous', exactPrevious, '--next', exactNext,
      '--previous-sku-column', '1', '--previous-cost-column-b64', b64('Cost'), '--previous-inventory-column-b64', b64('none'),
      '--next-inventory-column', 'none'], { previous: exactPrevious, next: exactNext },
    ['supplier-delta-audit.json', 'supplier-delta-report.csv', 'supplier-delta-sign-off.html']);
  }, 45_000);

  it('keeps migration diagnostics when the native target is held', () => {
    const source = content('catalog café.csv', catalog('10.00'));
    const corrupt = content('broken-catalog.csv', catalog('Call for price'));
    const flags = ['--source-platform', 'shopify', '--target-platform', 'woocommerce'];
    verifyReceipt('migrate', 0, 'ready', './migration dir/good', [...flags, './' + basename(source)], { source },
      ['migration-audit.json', 'migration-sign-off.html', 'migrated-shopify-to-woocommerce.csv'], scratch);
    verifyReceipt('migrate', 2, 'blocked', resolve(scratch, 'migration-held'), [...flags, corrupt], { source: corrupt },
      ['migration-audit.json', 'migration-sign-off.html']);
  }, 45_000);

  it('rejects invalid mode switches, unsafe paths, symbolic links and pre-existing artifacts', () => {
    const args = ['--mode', 'repair', '--platform', 'freshbooks-expenses', readyRepair];
    for (const unsafe of ['../escape', 'NUL.txt', 'C:relative', '//host/share/file', 'folder/file:ads']) {
      expect(cli([...args, '--out-dir', unsafe], scratch).status).toBe(1);
    }
    const output = resolve(scratch, 'write-safety');
    expect(cli([...args, '--out-dir', output, '--recipe', 'unused.json']).status).toBe(1);
    expect(cli(['--mode', 'repair', '--platform', 'freshbooks-expenses', 'missing.csv', '--out-dir', output]).status).toBe(1);
    mkdirSync(output);
    const original = resolve(output, 'repaired.csv');
    writeFileSync(original, 'existing-artifact');
    const collision = cli([...args, '--out-dir', output]);
    expect(collision.status).toBe(1);
    expect(readdirSync(output)).toEqual(['repaired.csv']);
    expect(readFileSync(original, 'utf8')).toBe('existing-artifact');
    const real = resolve(scratch, 'real-dir');
    const linked = resolve(scratch, 'linked-dir');
    mkdirSync(real);
    symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(cli([...args, '--out-dir', resolve(linked, 'nested')]).status).toBe(1);
    expect(readdirSync(real)).toEqual([]);
    const linkedFile = resolve(scratch, 'linked-file.csv');
    writeFileSync(resolve(real, 'normal.csv'), readFileSync(readyRepair));
    const wrongSource = cli(['--mode', 'repair', '--platform', 'freshbooks-expenses', resolve(linked, 'normal.csv'), '--out-dir', linkedFile]);
    expect(wrongSource.status).toBe(1);
    expect(readdirSync(real)).toEqual(['normal.csv']);
  }, 60_000);
});
