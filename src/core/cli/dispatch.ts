import { PLATFORM_IDS, repairCsvWithBytes, type RepairOptions } from '..';
import { sha256, type PriceCustody, type RepairCustody } from '../audit/custody';
import { parseBigCommerceBaseline } from '../bigcommerce-price-diff';
import { parseBom } from '../bom/rollup';
import { buildCatalogMigration } from '../catalog-migrator/engine';
import { buildPromoCampaign, type PromoCampaignOptions } from '../promo-campaign';
import { createBookkeeperSignoffHtml } from '../repair/bookkeeper-signoff';
import { parseBaseline, parseSupplier, suggestColumns, type ColumnSelection, type RowResolution, type SupplierDiffInput } from '../shopify-price-diff';
import { applySupplierRecipe, parseSupplierRecipe } from '../shopify-price-diff/recipe';
import { createSignoffHtml } from '../shopify-price-diff/signoff-html';
import { issue, type BatchDiffOptions, type StorePlatform } from '../shopify-price-diff/types';
import { buildSupplierDelta, inspectSupplierDeltaSource } from '../supplier-delta/engine';
import type { SupplierDeltaMapping, SupplierDeltaSide } from '../supplier-delta/types';
import { inspectImport } from '../verify-import/inspector';
import { parseWooCommerceBaseline } from '../woocommerce-price-diff';
import { repairAudit } from '../worker/repair-views';
import { runPriceComparison } from '../whatif/simulator';

export const cliModes = ['repair', 'price-diff', 'verify', 'promo', 'supplier-delta', 'migrate'] as const;
export const storePlatforms = ['shopify', 'woocommerce', 'bigcommerce'] as const satisfies readonly StorePlatform[];
export type CliMode = typeof cliModes[number];
export interface CliFile { filename: string; bytes: Uint8Array }
export type CliArtifact = CliFile & { role: string };
export type CliStatus = 'ready' | 'blocked' | 'no-changes' | 'PASS' | 'FAIL_UNSAFE';
export interface CliResult { status: CliStatus; exitCode: 0 | 2; artifacts: CliArtifact[] }

export interface PriceSupplier {
  file: CliFile;
  sheet?: string;
  recipe?: CliFile;
  label?: string;
  confirmed?: boolean;
  currencyConfirmed?: boolean;
  fxConfirmed?: boolean;
  resolutions?: Readonly<Record<number, RowResolution>>;
}

type DeltaColumn = { header: string } | { index: number };
export interface DeltaSource extends CliFile {
  sheetName?: string;
  columns?: { skuColumn?: DeltaColumn; costColumn?: DeltaColumn; inventoryColumn?: DeltaColumn | null };
}

type PriceRequest = { mode: 'price-diff'; platform: StorePlatform; baseline: CliFile; suppliers: PriceSupplier[];
  bom?: CliFile; bomSupplierId?: string; storeLabel?: string; options: BatchDiffOptions };

export type CliRequest =
  | { mode: 'repair'; source: CliFile; platform: typeof PLATFORM_IDS[number]; options: RepairOptions; generatedAt: Date }
  | PriceRequest
  | { mode: 'verify'; platform: StorePlatform; baseline: CliFile; candidate: CliFile; matchedUpdate?: CliFile }
  | { mode: 'promo'; platform: StorePlatform; baseline: CliFile; costSheet?: CliFile; options: Omit<PromoCampaignOptions, 'costSheet'> }
  | { mode: 'supplier-delta'; previous: DeltaSource; next: DeltaSource }
  | { mode: 'migrate'; source: CliFile; sourcePlatform: StorePlatform; targetPlatform: StorePlatform };

const utf8 = new TextEncoder();
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
const artifact = (role: string, filename: string, content: string | Uint8Array): CliArtifact =>
  ({ role, filename, bytes: typeof content === 'string' ? utf8.encode(content) : content });

function result(status: CliStatus, ...artifacts: CliArtifact[]): CliResult {
  const exitCode = status === 'blocked' || status === 'FAIL_UNSAFE' ? 2 : 0;
  return { status, exitCode, artifacts };
}

function blockedAudit(filename: string, issues: unknown[]): CliResult {
  return result('blocked', artifact('audit', filename, json({ version: 1, status: 'blocked', issues })));
}

async function repair(request: Extract<CliRequest, { mode: 'repair' }>): Promise<CliResult> {
  const { source, platform, options, generatedAt } = request;
  const repaired = repairCsvWithBytes(source.bytes, source.filename, platform, options, []);
  const output = repaired.result.needsManualReviewCount === 0 ? repaired.verifiedBytes : null;
  // A legacy repair may have reviewable, verified bytes. Explicit automation holds those bytes.
  const report = { ...repaired.result, canDownload: output !== null };
  const custody: RepairCustody = { sourceSha256: await sha256(source.bytes), ...(output ? { repairedCsvSha256: await sha256(output) } : {}) };
  return result(output ? 'ready' : 'blocked',
    artifact('audit', 'repair-audit.json', json(repairAudit(report, options, custody))),
    artifact('sign-off', 'bookkeeper-sign-off.html', createBookkeeperSignoffHtml(report, { generatedAt, generatedAtDisplay: generatedAt.toISOString(), options, custody })),
    ...(output ? [artifact('repaired', 'repaired.csv', output)] : []));
}

async function priceDiff({ baseline: source, platform, suppliers, bom, bomSupplierId, storeLabel, options }: PriceRequest): Promise<CliResult> {
  const parse = platform === 'bigcommerce' ? parseBigCommerceBaseline : platform === 'woocommerce' ? parseWooCommerceBaseline : parseBaseline;
  const baseline = parse(source.bytes, source.filename);
  const diagnostics: unknown[] = [];
  const inputs: SupplierDiffInput[] = [];
  for (const [index, supplier] of suppliers.entries()) {
    const { file, sheet, recipe: recipeFile, confirmed, currencyConfirmed, fxConfirmed, resolutions } = supplier;
    const supplierId = String(index + 1);
    const details = { supplierId, supplierSource: file.filename };
    const recipe = recipeFile && parseSupplierRecipe(recipeFile.bytes);
    if (recipe && !recipe.ok) {
      diagnostics.push(...recipe.diagnostics.map(diagnostic => ({ ...diagnostic, ...details })));
      continue;
    }
    const named = sheet ?? recipe?.value.sheetName ?? undefined;
    const workbook = /\.xlsx$/i.test(file.filename);
    if (workbook !== (named !== undefined)) {
      diagnostics.push(issue('supplier', 'worksheet-selection-required', workbook ? 'Choose the exact name of a visible worksheet.' : 'Only an XLSX workbook accepts a named worksheet.', details));
      continue;
    }
    if (sheet !== undefined && recipe?.value.sheetName != null && sheet !== recipe.value.sheetName) {
      diagnostics.push(issue('supplier', 'recipe-worksheet-mismatch', 'The chosen worksheet must match the exact worksheet in the recipe.', details));
      continue;
    }
    const parsed = parseSupplier(file.bytes, file.filename, named === undefined ? undefined : { sheetName: named });
    const picked = parsed.sheets[0];
    if (!picked || parsed.issues.some(({ blocking }) => blocking)) {
      diagnostics.push(...parsed.issues.map(entry => ({ ...entry, ...details })));
      continue;
    }
    let selection: ColumnSelection;
    if (recipe) {
      const applied = applySupplierRecipe(recipe.value, parsed, 0);
      if (!applied.ok) {
        diagnostics.push(...applied.diagnostics.map(diagnostic => ({ ...diagnostic, ...details })));
        continue;
      }
      selection = { ...applied.value.selection, confirmed: confirmed === true };
    } else {
      const suggestions = suggestColumns(baseline, picked);
      if (suggestions.requiresConfirmation) {
        diagnostics.push(issue('mapping', 'ambiguous-cli-mapping', 'Save a recipe that chooses the exact supplier columns and confirm its mapping for this run.', details));
        continue;
      }
      selection = { ...suggestions.selection, confirmed };
    }
    if (resolutions) {
      const lines = new Set(picked.rows.map(row => String(row.line)));
      if (Object.keys(resolutions).some(line => !lines.has(line))) {
        diagnostics.push(issue('supplier', 'missing-resolution-row', 'Apply review choices only to physical rows present in this supplier sheet.', details));
        continue;
      }
    }
    const selected = { ...selection, sameCurrencyConfirmed: currencyConfirmed, fxRateConfirmed: fxConfirmed, market: options.market };
    inputs.push({ supplierId, filename: file.filename, label: supplier.label ?? recipe?.value.supplierLabel, sheet: picked, selection: selected, resolutions });
  }
  if (diagnostics.length) return blockedAudit('price-audit.json', [...baseline.issues, ...diagnostics]);
  const bomInputs = bom ? { sheet: parseBom(bom.bytes, bom.filename), pricingSupplierId: bomSupplierId } : undefined;
  const policies = new Set(inputs.flatMap(input => input.selection?.conflictPolicy === undefined ? [] : [input.selection.conflictPolicy]));
  if (options.conflictPolicy === undefined && policies.size > 1) {
    return blockedAudit('price-audit.json', [issue('mapping', 'conflicting-recipe-policies', 'Choose an explicit conflict policy for the supplier batch.')]);
  }
  const compared = runPriceComparison(baseline, inputs.length === 1 && options.conflictPolicy === undefined
    ? { kind: 'single', supplier: inputs[0], bom: bomInputs }
    : { kind: 'batch', suppliers: inputs, options: { ...options, conflictPolicy: options.conflictPolicy ?? [...policies][0] }, bom: bomInputs });
  const { canDownload, updateBytes, rollbackBytes } = compared;
  const available = canDownload && updateBytes !== null && rollbackBytes !== null;
  const custody: PriceCustody = {
    baselineSha256: await sha256(source.bytes),
    suppliers: await Promise.all(inputs.map(async ({ supplierId, filename, sheet }) => {
      const { bytes } = suppliers[Number(supplierId) - 1].file;
      return { filename, ...(sheet.selectedSheet === undefined ? {} : { selectedSheet: sheet.selectedSheet }), bytes: bytes.byteLength, sha256: await sha256(bytes) };
    })),
  };
  if (bom && bomInputs) {
    const { worksheet } = bomInputs.sheet;
    custody.bom = { filename: bom.filename, ...(worksheet ? { worksheet } : {}), bytes: bom.bytes.byteLength, sha256: await sha256(bom.bytes) };
  }
  if (available) [custody.updateCsvSha256, custody.rollbackCsvSha256] = await Promise.all([sha256(updateBytes), sha256(rollbackBytes)]);
  const status = available ? 'ready' : compared.status === 'no-changes' ? 'no-changes' : 'blocked';
  return result(status,
    artifact('audit', 'price-audit.json', compared.serializeAuditJson(custody)),
    artifact('sign-off', 'client-sign-off.html', createSignoffHtml(baseline, compared, undefined, undefined, custody, undefined, storeLabel)),
    ...(available ? [artifact('update', 'price-update.csv', updateBytes), artifact('rollback', 'price-rollback.csv', rollbackBytes)] : []));
}

async function supplierDelta(previous: DeltaSource, next: DeltaSource): Promise<CliResult> {
  const issues: unknown[] = [];
  const mappingFor = (source: DeltaSource, side: SupplierDeltaSide): SupplierDeltaMapping => {
    const xlsx = /\.xlsx$/i.test(source.filename);
    const mapping: SupplierDeltaMapping = {};
    if (xlsx !== (source.sheetName !== undefined)) {
      issues.push({ code: 'worksheet-selection-required', side, blocking: true, message: xlsx ? 'Choose the exact name of a visible worksheet.' : 'Only an XLSX workbook accepts a named worksheet.' });
      return mapping;
    }
    const { headers, suggestions } = inspectSupplierDeltaSource(source);
    for (const field of ['skuColumn', 'costColumn', 'inventoryColumn'] as const) {
      const value = source.columns?.[field];
      if (value === undefined) {
        if (field === 'inventoryColumn' && suggestions.inventoryColumns.length > 1) {
          issues.push({ code: 'ambiguous-inventory-column', side, field, blocking: true, message: 'Choose the inventory column or explicitly exclude inventory.' });
        }
        continue;
      }
      if (value === null) {
        mapping.inventoryColumn = null;
        continue;
      }
      const matches = 'index' in value ? (value.index < headers.length ? [value.index] : []) :
        headers.flatMap((header, index) => header === value.header ? [index] : []);
      if (matches.length === 1) mapping[field] = matches[0];
      else issues.push({ code: 'invalid-column-selection', side, field, value, blocking: true, message: 'Choose one available, unambiguous column.' });
    }
    return mapping;
  };
  const mappings = { previous: mappingFor(previous, 'previous'), next: mappingFor(next, 'next') };
  if (issues.length) return blockedAudit('supplier-delta-audit.json', issues);
  const { status, deltaCsv, signOffHtml, auditJson } = await buildSupplierDelta(previous, next, mappings);
  const audit = artifact('audit', 'supplier-delta-audit.json', auditJson);
  return status === 'ready' && deltaCsv !== null && signOffHtml !== null
    ? result('ready', audit, artifact('sign-off', 'supplier-delta-sign-off.html', signOffHtml), artifact('delta', 'supplier-delta-report.csv', deltaCsv))
    : result('blocked', audit);
}

export async function dispatchCli(request: CliRequest): Promise<CliResult> {
  switch (request.mode) {
    case 'repair': return repair(request);
    case 'price-diff': return priceDiff(request);
    case 'verify': {
      const report = await inspectImport(request.platform, request.baseline.bytes, request.candidate.bytes, request.matchedUpdate?.bytes);
      return result(report.verdict, artifact('report', 'verify-report.json', json(report)));
    }
    case 'promo': {
      const promo = await buildPromoCampaign(request.platform, request.baseline.bytes, { ...request.options, costSheet: request.costSheet?.bytes });
      const { audit, signoff, launch, revert } = promo.fileNames;
      const report = artifact('audit', audit, promo.auditJson);
      return promo.canExport && promo.launchCsv !== null && promo.revertCsv !== null && promo.signoffHtml !== null
        ? result('ready', report, artifact('sign-off', signoff, promo.signoffHtml), artifact('launch', launch, promo.launchCsv), artifact('revert', revert, promo.revertCsv))
        : result('blocked', report);
    }
    case 'supplier-delta': return supplierDelta(request.previous, request.next);
    case 'migrate': {
      const { sourcePlatform, targetPlatform, source } = request;
      const { artifacts: { targetCsv, auditJson, signOffHtml } } = await buildCatalogMigration(sourcePlatform, targetPlatform, source.bytes, source.filename);
      return result(targetCsv ? 'ready' : 'blocked', { role: 'audit', ...auditJson }, { role: 'sign-off', ...signOffHtml },
        ...(targetCsv ? [{ role: 'target', ...targetCsv }] : []));
    }
  }
}

export async function createCustodyManifest(mode: CliMode, exitCode: CliResult['exitCode'], inputs: readonly CliArtifact[], outputs: readonly CliArtifact[]): Promise<string> {
  const fingerprints = (files: readonly CliArtifact[]) => Promise.all(files.map(async ({ role, filename, bytes }) =>
    ({ role, filename, byteLength: bytes.byteLength, sha256: await sha256(bytes) })));
  const [inputFingerprints, outputFingerprints] = await Promise.all([fingerprints(inputs), fingerprints(outputs)]);
  return json({ version: 1, mode, exitCode, inputs: inputFingerprints, outputs: outputFingerprints });
}
