import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { amazonFileExtension } from '../src/core/amazon-price-diff';
import { sha256, type RepairCustody } from '../src/core/audit/custody';
import { cliModes, createCustodyManifest, dispatchCli, importPlatforms, storePlatforms, type CliArtifact, type CliInventorySupplier, type CliRequest, type DeltaSource, type PriceSupplier } from '../src/core/cli/dispatch';
import { isSafeFileName, isSafeLocalPath } from '../src/core/cli/paths';
import { PLATFORM_IDS, repairCsvWithBytes } from '../src/core/index';
import { hasDuplicateKeys, profileText } from '../src/core/shopify-price-diff/settings-validation';
import { conflictPolicies } from '../src/core/shopify-price-diff/types';
import { parseWorkspaceProfile } from '../src/core/shopify-price-diff/workspace-profile';

const usage = `Usage: npm run repair-cli -- --platform <${PLATFORM_IDS.join('|')}> <input.csv>
  --output <repaired.csv>              Write CSV to a new file (default: stdout)
  --audit <audit.json>                 Write JSON audit to a new file
  --date-order <auto|MDY|DMY>           Source date order
  --qbo-layout <3col|4col>               QuickBooks output layout
  --qbo-credit-debit <auto|bank|intuit>  Source Credit/Debit convention
  --stripe-paypal-output <accounting|quickbooks-3col>
  --stripe-paypal-fee-convention <auto|deduction|signed-movement>
  --exclude-paypal-memo                 Exclude PayPal rows without balance impact`;

const cliOptions = z.object({
  platform: z.enum(PLATFORM_IDS),
  dateOrder: z.enum(['auto', 'MDY', 'DMY']).optional(),
  qboLayout: z.enum(['3col', '4col']).optional(),
  qboCreditDebit: z.enum(['auto', 'bank', 'intuit']).optional(),
  stripePayPalOutput: z.enum(['accounting', 'quickbooks-3col']).optional(),
  stripePayPalFeeConvention: z.enum(['auto', 'deduction', 'signed-movement']).optional(),
  excludePayPalMemo: z.boolean().optional(),
});

async function legacyMain() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      platform: { type: 'string' },
      output: { type: 'string' },
      audit: { type: 'string' },
      'date-order': { type: 'string' },
      'qbo-layout': { type: 'string' },
      'qbo-credit-debit': { type: 'string' },
      'stripe-paypal-output': { type: 'string' },
      'stripe-paypal-fee-convention': { type: 'string' },
      'exclude-paypal-memo': { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (positionals.length !== 1) throw new Error('Provide exactly one CSV input path. Run with --help for available options.');

  const { platform, ...options } = cliOptions.parse({
    platform: values.platform,
    dateOrder: values['date-order'],
    qboLayout: values['qbo-layout'],
    qboCreditDebit: values['qbo-credit-debit'],
    stripePayPalOutput: values['stripe-paypal-output'],
    stripePayPalFeeConvention: values['stripe-paypal-fee-convention'],
    excludePayPalMemo: values['exclude-paypal-memo'],
  });
  const input = positionals[0];
  const sourceBytes = readFileSync(input);
  const { result, verifiedBytes } = repairCsvWithBytes(sourceBytes, basename(input), platform, options, []);
  if (values.audit) {
    const [sourceSha256, repairedCsvSha256] = await Promise.all([
      sha256(sourceBytes),
      verifiedBytes ? sha256(verifiedBytes) : undefined,
    ]);
    const custody: RepairCustody = { sourceSha256, repairedCsvSha256 };
    const { repairedCsv, rows, ...audit } = result;
    writeFileSync(values.audit, `${JSON.stringify({ ...audit, rowCount: rows.length, custody }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  if (verifiedBytes) {
    if (values.output) writeFileSync(values.output, verifiedBytes, { flag: 'wx' });
    else process.stdout.write(verifiedBytes);
  }
  process.stderr.write(`${result.rows.length} data rows, ${result.removedRows.length} removed, ${result.needsManualReviewCount} review items. ${result.canDownload ? 'CSV export validated.' : 'CSV export blocked.'}\n`);
  if (result.needsManualReviewCount > 0) process.exitCode = 2;
}

const repairFlags = ['date-order', 'qbo-layout', 'qbo-credit-debit', 'stripe-paypal-output', 'stripe-paypal-fee-convention', 'exclude-paypal-memo', 'formula-guard'];
const supplierFlags = ['supplier', 'sheet', 'sheet-b64', 'recipe', 'label', 'label-b64'];
const inventorySupplierFlags = ['supplier', 'sheet', 'sheet-b64', 'sku-column', 'sku-column-b64', 'quantity-column', 'quantity-column-b64'];
const periodFlags = ['period', ...['period-label', 'period-sheet', 'period-sku-column', 'period-cost-column']
  .flatMap((name) => [name, name + '-b64'])];
const checks = ['mapping', 'currency', 'fx'] as const;
const deltaSides = ['previous', 'next'] as const;
const deltaFields = { skuColumn: 'sku', costColumn: 'cost', inventoryColumn: 'inventory' } as const;
const deltaFlags = deltaSides.flatMap(side => [side, `${side}-sheet`, `${side}-sheet-b64`,
  ...Object.values(deltaFields).flatMap(field => [`${side}-${field}-column`, `${side}-${field}-column-b64`])]);
const scopeFlags = ['sku-prefix', 'sku', 'handle', 'tag'];
const modeFlags = {
  repair: ['platform', 'generated-at', ...repairFlags],
  'price-diff': ['platform', 'baseline', ...supplierFlags, 'bom', 'bom-pricing-supplier', 'market', 'market-b64',
    'store-label', 'store-label-b64', ...checks.flatMap(check => [`confirm-${check}`, `confirm-${check}-supplier`]),
    'conflict-policy', 'confirm-conflict-policy', 'resolutions-b64'],
  verify: ['platform', 'baseline', 'candidate', 'matched-update'],
  promo: ['platform', 'baseline', 'discount-mode', 'discount-amount', 'minimum-retail', 'rounding', 'preserve-higher-compare-at',
    ...scopeFlags.flatMap(flag => [flag, `${flag}-b64`]), 'skip-line', 'cost-check', 'cost-sheet', 'store-label', 'store-label-b64'],
  'supplier-delta': deltaFlags,
  'inventory-sync': ['baseline', ...inventorySupplierFlags, 'target-location', 'target-location-b64', 'reserve-units',
    'zero-out-threshold', 'max-cap', 'approve-large-drop'],
  'cost-creep': [...periodFlags, 'creep-threshold-percent', 'currency', 'baseline', 'baseline-currency',
    'baseline-sku-column', 'baseline-sku-column-b64', 'baseline-retail-column', 'baseline-retail-column-b64', 'workspace-profile'],
  migrate: ['source-platform', 'target-platform'],
};
const booleanFlags = new Set(['help', 'exclude-paypal-memo', 'formula-guard', ...checks.map(check => `confirm-${check}`),
  'confirm-conflict-policy', 'preserve-higher-compare-at', 'cost-check', 'approve-large-drop']);
const sharedFlags = ['mode', 'help', 'out-dir'];
const repeatable = new Set([...supplierFlags, ...inventorySupplierFlags, ...periodFlags,
  ...checks.map(check => `confirm-${check}-supplier`), 'sku', 'sku-b64', 'skip-line']);
const allOptions = Object.fromEntries([...new Set([...sharedFlags, ...Object.values(modeFlags).flat()])].map(name =>
  [name, { type: booleanFlags.has(name) ? 'boolean' as const : 'string' as const, ...(name === 'help' ? { short: 'h' } : {}) }]));

const modeUsage = {
  repair: '--platform <repair-platform> <input.csv>',
  'price-diff': '--platform <store|amazon> --baseline <csv> --supplier <csv|xlsx> [--sheet <name>] [--recipe <json>] … (Amazon takes one proposal; each file may be csv|tsv|txt)',
  verify: '--platform <store|amazon> --baseline <csv> --candidate <csv> [--matched-update <csv>] (Amazon also accepts tsv|txt)',
  promo: '--platform <store> --baseline <csv> --discount-mode <percent-off|fixed-amount-off> --discount-amount <decimal> --minimum-retail <decimal> [--cost-sheet <csv|xlsx>]',
  'supplier-delta': '--previous <csv|xlsx> --next <csv|xlsx> [--previous-sheet <name>] [--next-sheet <name>]',
  'inventory-sync': '--baseline <csv> --supplier <csv|xlsx> [--sheet <name>] --sku-column <header|1-based position> --quantity-column <header|1-based position> … [--target-location <name>]',
  'cost-creep': '--period <csv|xlsx> --period-label <label> [--period-sheet <name>] [--period-sku-column <header>] [--period-cost-column <header>] … [--baseline <csv>]',
  migrate: '--source-platform <store> --target-platform <store> <input.csv>',
};

function localPath(value: string): string {
  const resolved = resolve(value);
  if (!isSafeLocalPath(value) || !isSafeLocalPath(resolved) || (sep === '/' && /\\|^[a-z]:/i.test(value))) {
    throw new Error('Use a safe local file or directory path.');
  }
  return resolved;
}

function pathEntries(path: string): string[] {
  const { root } = parse(path);
  let current = root;
  return path.slice(root.length).split(sep).map(part => current = join(current, part));
}

function readLocal(path: string): Uint8Array {
  const entries = pathEntries(path);
  for (const [index, entry] of entries.entries()) {
    const details = lstatSync(entry);
    const regular = index === entries.length - 1 ? details.isFile() : details.isDirectory();
    if (details.isSymbolicLink() || !regular) throw new Error('Use regular local input files with no symbolic links in the path.');
  }
  return readFileSync(path);
}

function publish(dir: string, artifacts: readonly CliArtifact[], manifest: string) {
  const names = artifacts.map(({ filename }) => filename.toLowerCase());
  if (names.includes('custody-manifest.json') || new Set(names).size !== names.length || artifacts.some(({ filename }) => !isSafeFileName(filename))) {
    throw new Error('Generated artifact names are unsafe or duplicated.');
  }
  const parentDir = dirname(dir);
  const parents = pathEntries(parentDir);
  const created: string[] = [];
  let staging: string | undefined;
  let removedEmpty = false;
  const verifyDestination = () => {
    const target = lstatSync(dir, { throwIfNoEntry: false });
    if (target && (target.isSymbolicLink() || !target.isDirectory() || readdirSync(dir).length > 0)) {
      throw new Error('Choose a new or empty output directory without symbolic links. Existing artifacts were preserved.');
    }
    return target;
  };
  try {
    for (const parent of parents) {
      const details = lstatSync(parent, { throwIfNoEntry: false });
      if (details) {
        if (details.isSymbolicLink() || !details.isDirectory()) throw new Error('Use an output directory with no symbolic links in its path.');
      } else {
        mkdirSync(parent);
        created.push(parent);
      }
    }
    verifyDestination();
    staging = mkdtempSync(join(parentDir, '.importmedic-'));
    for (const { filename, bytes } of artifacts) writeFileSync(join(staging, filename), bytes, { flag: 'wx' });
    writeFileSync(join(staging, 'custody-manifest.json'), manifest, { flag: 'wx' });
    // Windows refuses to move a directory over an existing empty directory.
    if (verifyDestination() && process.platform === 'win32') {
      rmdirSync(dir);
      removedEmpty = true;
    }
    renameSync(staging, dir);
  } catch (error) {
    if (staging) {
      for (const name of readdirSync(staging)) unlinkSync(join(staging, name));
      rmdirSync(staging);
    }
    if (removedEmpty && !lstatSync(dir, { throwIfNoEntry: false })) mkdirSync(dir);
    for (const path of created.reverse()) {
      if (readdirSync(path).length === 0) rmdirSync(path);
    }
    throw error;
  }
}

function decodeName(value: string): string {
  if (!/^[\w-]+$/.test(value) || value.length > 87_382) throw new Error('Use unpadded UTF-8 base64url for an encoded option.');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error('Use canonical unpadded UTF-8 base64url for an encoded option.');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

const rowNumber = z.string().regex(/^[1-9]\d{0,8}$/);
const rowResolutions = z.partialRecord(z.enum(['1', '2', '3']), z.record(rowNumber, z.strictObject({
  skip: z.boolean().optional(), confirm: z.boolean().optional(), price: z.string().max(160).optional(),
  compareAtPrice: z.string().max(160).optional(), inventoryQty: z.string().max(160).optional(),
})));

async function explicitMain(args: string[]) {
  const { values, positionals, tokens } = parseArgs({ args, options: allOptions, allowPositionals: true, tokens: true });
  const mode = z.enum(cliModes).parse(values.mode);
  const allowed = new Set([...sharedFlags, ...modeFlags[mode]]);
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    const { name } = token;
    if (!allowed.has(name)) throw new Error(`Option --${name} does not apply to ${mode}.`);
    if (seen.has(name) && !repeatable.has(name)) throw new Error(`Use --${name} once.`);
    seen.add(name);
  }
  if (values.help) {
    process.stdout.write(`Usage: npm run repair-cli -- --mode ${mode} ${modeUsage[mode]} --out-dir <dir>\nOptions: ${modeFlags[mode].map(name => '--' + name).join(', ')}\n`);
    return;
  }
  const expectInput = mode === 'repair' || mode === 'migrate';
  if (positionals.length !== (expectInput ? 1 : 0)) throw new Error(expectInput ? 'Provide exactly one CSV input path.' : `Use named input paths for ${mode}.`);

  const option = (name: string) => values[name] as string | undefined;
  const flag = (name: string) => values[name] === true;
  const required = (name: string): string => {
    const value = option(name);
    if (!value) throw new Error(`Provide --${name}.`);
    return value;
  };
  const named = (name: string) => {
    const raw = option(name);
    const encoded = option(name + '-b64');
    if (raw !== undefined && encoded !== undefined) throw new Error(`Use either --${name} or --${name}-b64 for one value.`);
    return encoded === undefined ? raw : decodeName(encoded);
  };
  const repeated = (name: string) => tokens.flatMap(token => token.kind === 'option' && token.name === name ? [token.value!] : []);
  const groupedInputs = (fileFlag: 'supplier' | 'period', flags: string[]) => {
    const [minimum, maximum] = fileFlag === 'period' ? [2, 6] : [1, 3];
    const groups: Array<Record<string, { value: string; encoded: boolean }>> = [];
    for (const token of tokens) {
      if (token.kind !== 'option' || !flags.includes(token.name)) continue;
      const { name, value } = token;
      if (name === fileFlag) { groups.push({ [fileFlag]: { value: value!, encoded: false } }); continue; }
      const group = groups.at(-1);
      const field = name.replace(/-b64$/, '');
      if (!group || group[field] !== undefined) throw new Error(`Place one --${field} after the relevant --${fileFlag}.`);
      const encoded = name.endsWith('-b64');
      group[field] = { value: encoded ? decodeName(value!) : value!, encoded };
    }
    if (groups.length < minimum || groups.length > maximum) {
      throw new Error(fileFlag === 'period' ? 'Provide two to six --period inputs.' : 'Provide one to three --supplier inputs.');
    }
    return groups;
  };
  const outDir = localPath(required('out-dir'));
  const inputs: CliArtifact[] = [];
  const read = (role: string, filename: string | undefined, extension?: RegExp) => {
    if (filename === undefined) throw new Error(`Provide --${role}.`);
    const path = localPath(filename);
    const name = basename(path);
    if (extension && !extension.test(name)) throw new Error(`The ${role} filename has the wrong extension.`);
    const file = { role, filename: name, bytes: readLocal(path) };
    inputs.push(file);
    return file;
  };
  const csv = /\.csv$/i;
  const source = (name: string) => read(name, option(name), csv);
  const optional = (name: string) => option(name) === undefined ? undefined : source(name);
  const store = (name: string) => z.enum(storePlatforms).parse(required(name));
  const text = (value: string | undefined) => profileText(240).optional().parse(value);
  const number = (value: string) => Number(rowNumber.parse(value));
  let request: CliRequest;
  switch (mode) {
    case 'repair': {
      const { platform, ...options } = cliOptions.parse({ platform: option('platform'), dateOrder: option('date-order'),
        qboLayout: option('qbo-layout'), qboCreditDebit: option('qbo-credit-debit'), stripePayPalOutput: option('stripe-paypal-output'),
        stripePayPalFeeConvention: option('stripe-paypal-fee-convention'), excludePayPalMemo: values['exclude-paypal-memo'] });
      const instant = option('generated-at');
      const generatedAt = instant === undefined ? new Date() : new Date(z.union([z.iso.datetime({ precision: 0 }), z.iso.datetime({ precision: 3 })]).parse(instant));
      request = { mode, platform, source: read('source', positionals[0], csv), generatedAt, options: { ...options, formulaGuard: values['formula-guard'] === true || undefined } };
      break;
    }
    case 'price-diff': {
      const platform = z.enum(importPlatforms).parse(required('platform'));
      if (platform === 'amazon') {
        const amazonFlags = new Set([...sharedFlags, 'platform', 'baseline', 'supplier']);
        for (const name of seen) if (!amazonFlags.has(name)) throw new Error(`Option --${name} does not apply to Amazon price-diff.`);
        if (repeated('supplier').length !== 1) throw new Error('Provide exactly one Amazon proposal with --supplier.');
        request = { mode, platform, baseline: read('baseline', option('baseline'), amazonFileExtension),
          proposal: read('supplier', option('supplier'), amazonFileExtension) };
        break;
      }
      const groups = groupedInputs('supplier', supplierFlags);
      const supplierNumber = (value: string) => {
        const index = number(value);
        if (index > groups.length) throw new Error('Choose an available supplier by its 1-based command order.');
        return index;
      };
      const confirmations = Object.fromEntries(checks.map(check => [check, new Set(repeated(`confirm-${check}-supplier`).map(supplierNumber))])) as Record<typeof checks[number], Set<number>>;
      const confirm = (check: typeof checks[number], index: number) => flag(`confirm-${check}`) || confirmations[check].has(index) || undefined;
      const resolutionText = option('resolutions-b64');
      const decoded = resolutionText === undefined ? '{}' : decodeName(resolutionText);
      if (hasDuplicateKeys(decoded)) throw new Error('Duplicate supplier or row keys in --resolutions-b64.');
      const resolutions = rowResolutions.parse(JSON.parse(decoded));
      Object.keys(resolutions).forEach(supplierNumber);
      const bomPricing = option('bom-pricing-supplier');
      if (bomPricing !== undefined && option('bom') === undefined) throw new Error('--bom-pricing-supplier requires --bom.');
      const market = text(named('market'));
      if (market !== undefined && platform !== 'shopify') throw new Error('--market applies to Shopify only.');
      const conflictPolicy = z.enum(conflictPolicies).optional().parse(option('conflict-policy'));
      const baseline = source('baseline');
      const suppliers = groups.map(({ supplier, sheet, recipe, label }, index): PriceSupplier => {
        const order = index + 1;
        return {
          file: read(`supplier-${order}`, supplier.value, /\.(?:csv|xlsx)$/i), sheet: text(sheet?.value), label: text(label?.value),
          recipe: recipe === undefined ? undefined : read(`recipe-${order}`, recipe.value, /\.json$/i),
          confirmed: confirm('mapping', order), currencyConfirmed: confirm('currency', order), fxConfirmed: confirm('fx', order),
          resolutions: resolutions[String(order) as keyof typeof resolutions],
        };
      });
      request = { mode, platform, baseline, suppliers, bom: optional('bom'), bomSupplierId: bomPricing === undefined ? undefined : String(supplierNumber(bomPricing)),
        storeLabel: text(named('store-label')), options: { market, conflictPolicy, conflictPolicyConfirmed: flag('confirm-conflict-policy') } };
      break;
    }
    case 'verify': {
      const platform = z.enum(importPlatforms).parse(required('platform'));
      const extension = platform === 'amazon' ? amazonFileExtension : csv;
      request = { mode, platform, baseline: read('baseline', option('baseline'), extension), candidate: read('candidate', option('candidate'), extension),
        matchedUpdate: option('matched-update') === undefined ? undefined : read('matched-update', option('matched-update'), extension) };
      break;
    }
    case 'promo': {
      const rounding = z.enum(['none', 'ending-99', 'ending-95', 'nearest-whole']).parse(option('rounding') ?? 'none');
      const discount = z.enum(['percent-off', 'fixed-amount-off']).parse(required('discount-mode'));
      const skuPrefix = text(named('sku-prefix'));
      const handle = text(named('handle'));
      const tag = text(named('tag'));
      const skus = tokens.flatMap(token => token.kind === 'option' && (token.name === 'sku' || token.name === 'sku-b64')
        ? [profileText(240).parse(token.name === 'sku' ? token.value : decodeName(token.value!))] : []);
      const scope = skuPrefix === undefined && handle === undefined && tag === undefined && !skus.length ? undefined :
        { skuPrefix, handle, tag, ...(skus.length ? { skus } : {}) };
      const rule = { mode: discount, rounding, amount: required('discount-amount'), minimumRetail: required('minimum-retail'),
        ...(flag('preserve-higher-compare-at') ? { preserveHigherCompareAt: true } : {}) };
      const costSheet = option('cost-sheet');
      request = { mode, platform: store('platform'), baseline: source('baseline'),
        costSheet: costSheet === undefined ? undefined : read('cost-sheet', costSheet, /\.(?:csv|xlsx)$/i),
        options: { rule, scope, skipLineNumbers: repeated('skip-line').map(number), costCheck: flag('cost-check'), storeLabel: text(named('store-label')) } };
      break;
    }
    case 'supplier-delta': {
      const side = (name: typeof deltaSides[number]): DeltaSource => {
        const column = (field: typeof deltaFields[keyof typeof deltaFields]) => {
          const optionName = `${name}-${field}-column`;
          const value = text(named(optionName));
          if (value === undefined) return undefined;
          if (option(optionName + '-b64') === undefined && rowNumber.safeParse(value).success) return { index: number(value) - 1 };
          return { header: value };
        };
        const inventoryOff = option(`${name}-inventory-column`) === 'none' && option(`${name}-inventory-column-b64`) === undefined;
        return { ...read(name, option(name), /\.(?:csv|xlsx)$/i), sheetName: text(named(`${name}-sheet`)),
          columns: { skuColumn: column('sku'), costColumn: column('cost'), inventoryColumn: inventoryOff ? null : column('inventory') } };
      };
      request = { mode, previous: side('previous'), next: side('next') };
      break;
    }
    case 'inventory-sync': {
      const groups = groupedInputs('supplier', inventorySupplierFlags);
      const baseline = source('baseline');
      const suppliers = groups.map((group, index): CliInventorySupplier => {
        const column = (optionName: string) => {
          const choice = group[optionName];
          if (choice === undefined) return undefined;
          return !choice.encoded && /^\d+$/.test(choice.value)
            ? { index: rowNumber.safeParse(choice.value).success ? number(choice.value) - 1 : -1 }
            : { header: choice.value };
        };
        return { ...read(`supplier-${index + 1}`, group.supplier.value, /\.(?:csv|xlsx)$/i), sheetName: group.sheet?.value,
          columns: { skuColumn: column('sku-column'), quantityColumn: column('quantity-column') } };
      });
      const wholeNumber = (name: string) => {
        const value = option(name);
        return value === undefined ? undefined : /^\d+$/.test(value) ? Number(value) : NaN;
      };
      request = { mode, baseline, suppliers, options: {
        targetLocation: named('target-location'),
        reserveUnits: wholeNumber('reserve-units') ?? 0,
        zeroOutThreshold: wholeNumber('zero-out-threshold') ?? 0,
        maxCap: wholeNumber('max-cap'),
        approveLargeDrop: flag('approve-large-drop'),
      } };
      break;
    }
    case 'cost-creep': {
      const periods = groupedInputs('period', periodFlags).map((group, index) => {
        const label = group['period-label']?.value;
        if (label === undefined) throw new Error('Provide --period-label for period ' + (index + 1) + '.');
        return { ...read('period-' + (index + 1), group.period.value, /\.(?:csv|xlsx)$/i), label,
          sheetName: group['period-sheet']?.value,
          mapping: { skuColumn: group['period-sku-column']?.value, amountColumn: group['period-cost-column']?.value } };
      });
      const baseline = optional('baseline');
      const baselineCurrency = option('baseline-currency');
      const baselineSku = named('baseline-sku-column');
      const baselineRetail = named('baseline-retail-column');
      if (!baseline && [baselineCurrency, baselineSku, baselineRetail].some((value) => value !== undefined)) {
        throw new Error('Baseline column and currency options require --baseline.');
      }
      const profilePath = option('workspace-profile');
      const profile = profilePath === undefined ? undefined : parseWorkspaceProfile(read('workspace-profile', profilePath, /\.json$/i).bytes);
      if (profile && !profile.ok) throw new Error(profile.diagnostics.map(({ message }) => message).join('\n'));
      request = { mode, periods, options: {
        creepThresholdPercent: option('creep-threshold-percent'), currency: option('currency'), branding: profile?.value.branding,
        retail: baseline ? { ...baseline, currency: baselineCurrency, mapping: { skuColumn: baselineSku, amountColumn: baselineRetail } } : undefined,
      } };
      break;
    }
    case 'migrate': {
      const sourcePlatform = store('source-platform');
      const targetPlatform = store('target-platform');
      if (sourcePlatform === targetPlatform) throw new Error('Choose distinct migration platforms.');
      request = { mode, sourcePlatform, targetPlatform, source: read('source', positionals[0], csv) };
      break;
    }
  }
  const { status, exitCode, artifacts } = await dispatchCli(request);
  const manifest = await createCustodyManifest(mode, exitCode, inputs, artifacts);
  publish(outDir, artifacts, manifest);
  process.stdout.write(JSON.stringify({ mode, status, exitCode, outputs: [...artifacts.map(({ filename }) => filename), 'custody-manifest.json'] }) + '\n');
  process.exitCode = exitCode;
}

try {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const options = separator === -1 ? args : args.slice(0, separator);
  if (options.some(arg => arg === '--mode' || arg.startsWith('--mode='))) await explicitMain(args);
  else await legacyMain();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
