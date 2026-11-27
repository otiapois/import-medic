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

function cli(args: string[], cwd = root) {
  const run = spawnSync(process.execPath, ['--import', tsx, resolve(root, script), ...args], {
    cwd, windowsHide: true, timeout: 15_000, env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch },
  });
  if (run.error) throw run.error;
  return { ...run, stdout: run.stdout.toString('utf8'), stderr: run.stderr.toString('utf8') };
}

function verifyReceipt(mode: string, code: 0 | 2, status: string, directory: string,
  args: string[], inputs: Record<string, string>, outputFiles: string[], cwd?: string) {
  const run = cli(['--mode', mode, ...args, '--out-dir', directory], cwd);
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
  if (code === 2) expect(outputFiles.every(file => !file.endsWith('.csv'))).toBe(true);
  return run;
}

const pricingHeaders = 'Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price,Variant Compare At Price,Cost per item\n';
const catalog = (price: string) => pricingHeaders + `part,Spare Part,Title,Default Title,0001,${price},,5.00\nkit,Bundle,Title,Default Title,KIT,20.00,,10.00\n`;

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
