import { repairCsvWithBytes } from '..';
import { createCatalogImpact, type CatalogMarginRow } from '../analytics/catalog-impact';
import { sha256, type PriceCustody, type RepairCustody, type SupplierFingerprint } from '../audit/custody';
import { decodeCsv, parseCsv } from '../csv';
import { Journal } from '../journal';
import { stripBankStatement } from '../profiles/quickbooks-bank';
import { createBookkeeperSignoffHtml } from '../repair/bookkeeper-signoff';
import { buildMultiSupplierDiff, buildPriceDiff, parseBaseline, parseSupplier, previewPricingFormula, suggestColumns } from '../shopify-price-diff';
import { applySupplierRecipe, createSupplierRecipe, MAX_RECIPE_BYTES, parseSupplierRecipe, serializeSupplierRecipe } from '../shopify-price-diff/recipe';
import { parseWooCommerceBaseline } from '../woocommerce-price-diff';
import { parseBigCommerceBaseline } from '../bigcommerce-price-diff';
import { bigCommerceSkuHeader } from '../bigcommerce-price-diff/source';
import { createSignoffHtml } from '../shopify-price-diff/signoff-html';
import type { Baseline, ColumnSelection, DiffIssue, DiffRow, PriceDiffResult, SourceTable, SupplierFile } from '../shopify-price-diff/types';
import type { RepairOptions, RepairResult } from '../types';
import { inspectImport, type ImportInspection } from '../verify-import/inspector';
import { suggestPlatforms } from './platform-suggestion';
import { invalidatesResult, resultScope, supersededResult } from './protocol';
import type { DiffFilter, DiffSummary, DownloadFormat, InspectionSummary, PlatformSuggestion, RepairSummary, SheetMeta, WorkerDownload, WorkerMessage, WorkerPage, WorkerProgress, WorkerReply, WorkerRequest, WorkerResult } from './protocol';
import { guardSummary, indexRepairViews, repairAudit, repairAuditText } from './repair-views';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<WorkerMessage>) => void;
  postMessage: (reply: WorkerReply, transfer?: Transferable[]) => void;
};
type Progress = (phase: WorkerProgress['phase'], percent: number) => void;

const fileIssueLimit = 40;
const linePreviewLimit = 40;
const contenderPreviewLimit = 12;
const csvMime = 'text/csv;charset=utf-8';
const jsonMime = 'application/json;charset=utf-8';
const allStatuses: Record<DiffRow['status'], Exclude<DiffFilter, 'all'>> = {
  Updated: 'updated', Unchanged: 'unchanged', Blocked: 'flagged',
  'Unmatched Supplier Row': 'unmatched', 'Missing in Supplier': 'unmatched', Skipped: 'skipped',
};

let baseline: (Baseline & { sha256: string }) | undefined;
const suppliers = new Map<string, SupplierFile & { fingerprint: SupplierFingerprint }>();
const defaultSupplierId = 'primary';
let price: Awaited<ReturnType<typeof indexPriceResult>> | undefined;
let inspection: ImportInspection | undefined;
let repairSource: { filename: string; bytes: Uint8Array; sha256: string; bankSuggestions?: PlatformSuggestion[] } | undefined;
let repair: { result: RepairResult; options: RepairOptions; views: ReturnType<typeof indexRepairViews>; suggestions: PlatformSuggestion[];
  verifiedBytes: Uint8Array<ArrayBuffer> | null; custody: RepairCustody } | undefined;

function requireLoaded<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function previewIssue(issue: DiffIssue): DiffIssue {
  if (issue.supplierContenders && issue.supplierContenders.length > contenderPreviewLimit) {
    issue = { ...issue, supplierContenders: issue.supplierContenders.slice(0, contenderPreviewLimit),
      message: `${issue.message} ${issue.supplierContenders.length} supplier rows are listed in the full audit.` };
  }
  if (issue.rows.length <= linePreviewLimit) return issue;
  const message = issue.code.startsWith('duplicate-') ? 'This identity occurs on more than one source line.' : issue.message;
  return { ...issue, rows: issue.rows.slice(0, linePreviewLimit), message: `${message} ${issue.rows.length} source lines are listed in the full audit.` };
}

function issuesMeta(issues: DiffIssue[]) {
  return { issues: issues.slice(0, fileIssueLimit).map(previewIssue), issueCount: issues.length };
}

function sheetMeta({ name, headers, issues, rows }: SourceTable): SheetMeta {
  return { name, headers, rowCount: rows.length, ...issuesMeta(issues) };
}

function pageOf<T>(items: readonly T[], page: number, pageSize: number): WorkerPage<T> {
  const size = Math.min(100, Math.max(1, Math.floor(pageSize)));
  const current = Math.min(Math.max(0, Math.floor(page)), Math.max(0, Math.ceil(items.length / size) - 1));
  const first = current * size;
  return { rows: items.slice(first, first + size), total: items.length, page: current };
}

const yieldToWorker = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function indexPriceResult(result: PriceDiffResult, source: Baseline & { sha256: string }, suppliers: readonly SupplierFingerprint[],
  pricingRule: ColumnSelection['pricingRule'], progress: Progress, ensureCurrent: () => void) {
  const { updateBytes, rollbackBytes } = result;
  const custody: PriceCustody = { baselineSha256: source.sha256, suppliers };
  if (result.canDownload && updateBytes && rollbackBytes) {
    [custody.updateCsvSha256, custody.rollbackCsvSha256] = await Promise.all([sha256(updateBytes), sha256(rollbackBytes)]);
    ensureCurrent();
  }
  const rowIssues = new Set<DiffIssue>();
  const rows: Record<DiffFilter, DiffRow[]> = { all: result.rows, updated: [], flagged: [], unmatched: [], unchanged: [], skipped: [], 'margin-watchlist': [] };
  const impact = createCatalogImpact(result.inventoryEnabled, result.issues);
  const marginByRow = new Map<DiffRow, CatalogMarginRow>();
  const searchable = new Map<DiffRow, string[]>();
  let previous = 91;
  for (const [index, row] of result.rows.entries()) {
    if ((index & 2047) === 0) {
      const percent = 91 + Math.floor(8 * index / result.rows.length);
      if (percent > previous) progress('comparing', percent);
      previous = percent;
      await yieldToWorker();
      ensureCurrent();
    }
    rows[allStatuses[row.status]].push(row);
    for (const entry of row.issues) rowIssues.add(entry);
    const margin = impact.add(row);
    if (margin) {
      marginByRow.set(row, margin);
      if (margin.belowOrAtCost) rows['margin-watchlist'].push(row);
    }
    searchable.set(row, [row.sku, row.handle, row.woocommerce?.id, row.woocommerce?.parent, row.bigcommerce?.name, row.bigcommerce?.productId]
      .flatMap(value => value ? [value.toLowerCase()] : []));
  }
  const issues = result.issues.filter((entry) => !rowIssues.has(entry) || /^(duplicate|currency)-/.test(entry.code));
  const variantOptions = new Map(source.variants.map(({ source, options }) => [source.line, options.filter(Boolean).join(' / ')]));
  const counts = { all: rows.all.length, updated: rows.updated.length, flagged: rows.flagged.length,
    unmatched: rows.unmatched.length, unchanged: rows.unchanged.length, skipped: rows.skipped.length, 'margin-watchlist': rows['margin-watchlist'].length };
  const summary: DiffSummary = {
    status: result.status, canDownload: result.canDownload, verification: result.verification, rollbackVerification: result.rollbackVerification,
    counts, analytics: impact.summarize(), custody, ...(result.market ? { market: result.market } : {}),
    issueCount: issues.length, formulaGuard: guardSummary(result.formulaGuard),
    currencyConfirmationRequired: result.issues.some(({ code }) => code === 'currency-confirmation-required'),
    currencyConfirmationSupplierIds: [...new Set(result.issues.flatMap(({ code, supplierId }) =>
      code === 'currency-confirmation-required' ? [supplierId ?? defaultSupplierId] : []))],
    inventoryEnabled: result.inventoryEnabled, overlapCount: result.overlapCount, conflictCount: result.conflictCount, conflictPolicy: result.conflictPolicy,
    mappingBlocked: result.issues.some(({ source, blocking }) => source === 'mapping' && blocking),
  };
  let cached: { filter: DiffFilter; search: string; matching: DiffRow[] } | undefined;
  function searchRows(filter: DiffFilter, search: string) {
    if (!search) return rows[filter];
    if (cached?.filter === filter && cached.search === search) return cached.matching;
    const matching = rows[filter].filter((row) => searchable.get(row)!.some(value => value.includes(search)));
    cached = { filter, search, matching };
    return matching;
  }
  return { result, rows, issues, variantOptions, summary, pricingRule, marginByRow, searchRows };
}

function makeDownload(filename: string, text: string, mime: string): WorkerDownload {
  return { filename, bytes: new TextEncoder().encode(text).buffer, mime };
}

function pricePlatformName(): string {
  return baseline?.platform === 'bigcommerce' ? 'BigCommerce' : baseline?.platform === 'woocommerce' ? 'WooCommerce' : 'Shopify';
}

function download(format: DownloadFormat): WorkerDownload {
  if (format.startsWith('price-')) {
    const state = requireLoaded(price, 'Run the ' + pricePlatformName() + ' price comparison before downloading.');
    const basename = baseline?.name.replace(/\.csv$/i, '') || baseline?.platform || 'shopify';
    if (format === 'price-audit-csv') return makeDownload(`${basename}-price-diff.audit.csv`, state.result.auditCsv, csvMime);
    if (format === 'price-audit-json') return makeDownload(`${basename}-price-diff.audit.json`, state.result.serializeAuditJson(state.summary.custody), jsonMime);
    if (format === 'price-signoff-html') {
      const source = requireLoaded(baseline, 'Choose a ' + pricePlatformName() + ' baseline CSV first.');
      return makeDownload(`${basename}-client-sign-off.html`, createSignoffHtml(source, state.result, state.pricingRule,
        { summary: state.summary.analytics, watchlist: state.rows['margin-watchlist'] }, state.summary.custody), 'text/html;charset=utf-8');
    }
    if (!state.result.canDownload || !state.result.updateBytes || !state.result.rollbackBytes) {
      throw new Error('The ' + pricePlatformName() + ' CSV downloads are blocked. Review the audit before exporting.');
    }
    const rollback = format === 'price-rollback-csv';
    const verified = rollback ? state.result.rollbackBytes : state.result.updateBytes;
    return { filename: `${basename}-price-${rollback ? 'rollback' : 'update'}.csv`, bytes: verified.slice().buffer, mime: csvMime };
  }
  const state = requireLoaded(repair, 'Repair your CSV before downloading.');
  const { result } = state;
  const basename = result.filename.replace(/\.csv$/i, '') || 'import-medic';
  if (format === 'repair-csv') {
    if (!state.verifiedBytes) throw new Error('The repaired CSV is blocked. Review the audit before exporting.');
    return { filename: `${basename}-repaired.csv`, bytes: state.verifiedBytes.slice().buffer, mime: csvMime };
  }
  if (format === 'repair-bookkeeper-html') {
    const safeBasename = basename.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').slice(0, 160).replace(/[ .]+$/, '') || 'import-medic';
    const detectedProvider = state.suggestions.find(({ platform }) => platform === result.platform)?.provider;
    return makeDownload(`${safeBasename}-bookkeeper-sign-off.html`, createBookkeeperSignoffHtml(result,
      { generatedAt: new Date(), detectedProvider, options: state.options, custody: state.custody }), 'text/html;charset=utf-8');
  }
  const audit = repairAudit(result, state.options, state.custody);
  if (format === 'repair-audit-json') return makeDownload(`${basename}.audit.json`, JSON.stringify(audit, null, 2) + '\n', jsonMime);
  return makeDownload(`${basename}.audit.txt`, repairAuditText(audit), 'text/plain;charset=utf-8');
}

async function run(request: WorkerRequest, progress: Progress, ensureCurrent: () => void): Promise<WorkerResult> {
  switch (request.type) {
    case 'loadBaseline':
    case 'loadSupplier': {
      price = undefined;
      if (request.type === 'loadBaseline') baseline = undefined;
      else suppliers.delete(request.supplierId ?? defaultSupplierId);
      progress('reading', 5);
      const bytes = new Uint8Array(await request.file.arrayBuffer());
      const digest = await sha256(bytes);
      progress('parsing', 35);
      if (request.type === 'loadBaseline') {
        const parsed = request.platform === 'bigcommerce' ? parseBigCommerceBaseline(bytes, request.file.name) :
          request.platform === 'woocommerce' ? parseWooCommerceBaseline(bytes, request.file.name) : parseBaseline(bytes, request.file.name);
        baseline = { ...parsed, sha256: digest };
        progress('parsing', 100);
        const sku = baseline.platform === 'bigcommerce' ? bigCommerceSkuHeader(baseline) : baseline.platform === 'woocommerce' ? 'SKU' : 'Variant SKU';
        return { ...sheetMeta(baseline), hasSku: baseline.columns.has(sku), ...(baseline.markets ? { markets: baseline.markets } : {}) };
      }
      const supplier = parseSupplier(bytes, request.file.name);
      suppliers.set(request.supplierId ?? defaultSupplierId, { ...supplier,
        fingerprint: { filename: request.file.name, bytes: bytes.byteLength, sha256: digest } });
      progress('parsing', 100);
      return { name: supplier.name, ...issuesMeta(supplier.issues), sheets: supplier.sheets.map(sheetMeta) };
    }
    case 'removeSupplier':
      suppliers.delete(request.supplierId);
      price = undefined;
      return undefined;
    case 'diffBatch': {
      price = undefined;
      const base = requireLoaded(baseline, 'Choose a ' + pricePlatformName() + ' baseline CSV first.');
      const batch = request.suppliers.map(({ supplierId, sheetIndex, ...settings }) => {
        const input = requireLoaded(suppliers.get(supplierId), 'Choose a supplier file before comparing.');
        const sheet = requireLoaded(input.sheets[sheetIndex], 'Choose an available supplier worksheet first.');
        return { ...settings, supplierId, sheet, filename: input.name, fingerprint: input.fingerprint };
      });
      progress('comparing', 5);
      const result = buildMultiSupplierDiff(base, batch, request, undefined, progress);
      progress('comparing', 91);
      const state = await indexPriceResult(result, base, batch.map(({ fingerprint }) => fingerprint),
        batch.length === 1 ? batch[0].selection.pricingRule : undefined, progress, ensureCurrent);
      ensureCurrent();
      price = state;
      progress('comparing', 100);
      return price.summary;
    }
    case 'invalidatePrice':
      price = undefined;
      return undefined;
    case 'priceSettings':
    case 'priceFormulaPreview':
    case 'diff': {
      if (request.type === 'diff') price = undefined;
      const base = requireLoaded(baseline, 'Choose a ' + pricePlatformName() + ' baseline CSV first.');
      const supplierId = request.supplierId ?? defaultSupplierId;
      const input = requireLoaded(suppliers.get(supplierId), 'Choose a supplier file before comparing.');
      const sheet = requireLoaded(input.sheets[request.sheetIndex], 'Choose an available supplier worksheet first.');
      if (request.type === 'priceSettings') return suggestColumns(base, sheet);
      const selection = { ...request.selection, market: request.market ?? request.selection.market };
      if (request.type === 'priceFormulaPreview') return previewPricingFormula(base, sheet, selection);
      progress('comparing', 5);
      const result = buildPriceDiff(base, sheet, selection, request.resolutions, undefined, { supplierId, label: request.label, filename: input.name }, progress);
      progress('comparing', 91);
      const state = await indexPriceResult(result, base, [input.fingerprint], request.selection.pricingRule, progress, ensureCurrent);
      ensureCurrent();
      price = state;
      progress('comparing', 100);
      return price.summary;
    }
    case 'diffRows': {
      const state = requireLoaded(price, 'Run the ' + pricePlatformName() + ' price comparison first.');
      const matching = state.searchRows(request.filter, request.search.trim().toLowerCase());
      const page = pageOf(matching, request.page, request.pageSize);
      return { ...page, rows: page.rows.map((row) => ({ ...row, ...state.marginByRow.get(row),
        supplierContenders: row.supplierContenders?.slice(0, contenderPreviewLimit),
        issues: row.issues.map(previewIssue), variantOptions: state.variantOptions.get(row.baselineRow ?? -1) ?? '' })) };
    }
    case 'diffIssues': {
      const state = requireLoaded(price, 'Run the ' + pricePlatformName() + ' price comparison first.');
      const page = pageOf(state.issues, request.page, request.pageSize);
      return { ...page, rows: page.rows.map(previewIssue) };
    }
    case 'inspectImport': {
      inspection = undefined;
      progress('reading', 5);
      const [original, candidate, update] = await Promise.all([
        request.baseline.arrayBuffer(), request.candidate.arrayBuffer(), request.pairedUpdate?.arrayBuffer(),
      ]);
      ensureCurrent();
      progress('comparing', 35);
      const result = await inspectImport(request.platform, new Uint8Array(original), new Uint8Array(candidate), update && new Uint8Array(update));
      ensureCurrent();
      inspection = result;
      const { rows, issues, ...metadata } = result;
      const summary: InspectionSummary = { ...metadata, rowCount: rows.length, issueCount: issues.length };
      progress('comparing', 100);
      return summary;
    }
    case 'inspectionRows': {
      const result = requireLoaded(inspection, 'Inspect the files before reviewing changes.');
      return pageOf(result.rows, request.page, request.pageSize);
    }
    case 'inspectionIssues': {
      const result = requireLoaded(inspection, 'Inspect the files before reviewing issues.');
      return pageOf(result.issues, request.page, request.pageSize);
    }
    case 'loadRepair': {
      repairSource = undefined;
      repair = undefined;
      progress('reading', 10);
      const source = request.file instanceof File
        ? { filename: request.file.name, bytes: new Uint8Array(await request.file.arrayBuffer()) }
        : request.file;
      repairSource = { ...source, sha256: await sha256(source.bytes) };
      progress('reading', 100);
      return undefined;
    }
    case 'repair': {
      const source = requireLoaded(repairSource, 'Choose a CSV to repair first.');
      repair = undefined;
      progress('repairing', 35);
      const { bytes, filename } = source;
      const { result, verifiedBytes } = repairCsvWithBytes(bytes, filename, request.platform, request.options, request.edits);
      const custody: RepairCustody = { sourceSha256: source.sha256 };
      if (verifiedBytes) {
        custody.repairedCsvSha256 = await sha256(verifiedBytes);
        ensureCurrent();
      }
      progress('repairing', 85);
      let suggestions = suggestPlatforms(result.sourceHeaders);
      if (suggestions.length === 0 && result.sourceHeaders.length <= 2) {
        if (!source.bankSuggestions) {
          const { records } = parseCsv(decodeCsv(bytes).text);
          const [header] = stripBankStatement(records, new Journal('quickbooks-bank'));
          source.bankSuggestions = header ? suggestPlatforms(header.cells) : [];
        }
        suggestions = source.bankSuggestions;
      }
      const views = indexRepairViews(result);
      repair = { result, options: request.options, views, suggestions, verifiedBytes, custody };
      const { rows, removedRows, issues, changes, repairedCsv: _, formulaGuard, bookkeeperAmounts: _amounts, ...metadata } = result;
      let fixed = 0;
      let warnings = 0;
      for (const issue of issues) {
        if (issue.autoFixed) fixed++;
        else if (issue.severity === 'warning') warnings++;
      }
      const manuallyEdited = new Set(changes.flatMap(({ code, row, column }) => code === 'manual-edit' ? [`${row}:${column}`] : [])).size;
      const summary: RepairSummary = { ...metadata, formulaGuard: guardSummary(formulaGuard), suggestions, custody,
        rowCount: rows.length, removedRowCount: removedRows.length, issueCount: issues.length, fixed, warnings, manuallyEdited,
        beforeHeaderMarks: views.beforeHeaderMarks, afterHeaderMarks: views.afterHeaderMarks };
      progress('repairing', 100);
      return summary;
    }
    case 'repairRows': {
      const { result, views } = requireLoaded(repair, 'Repair your CSV before opening the preview.');
      const page = pageOf(result.rows, request.page, request.pageSize);
      return { ...page, rows: page.rows.map(views.rowView) };
    }
    case 'repairRemoved': {
      const { result } = requireLoaded(repair, 'Repair your CSV before opening the preview.');
      return pageOf(result.removedRows, request.page, request.pageSize);
    }
    case 'repairIssues': {
      const { result } = requireLoaded(repair, 'Repair your CSV before opening the review.');
      const issues = request.filter === 'all' ? result.issues : result.issues.filter(({ autoFixed }) => autoFixed === (request.filter === 'fixed'));
      return pageOf(issues, request.page, request.pageSize);
    }
    case 'download': {
      progress('exporting', 25);
      await yieldToWorker();
      ensureCurrent();
      const result = download(request.format);
      progress('exporting', 90);
      await yieldToWorker();
      ensureCurrent();
      progress('exporting', 100);
      return result;
    }
    case 'loadRecipe': {
      if (!/\.json$/i.test(request.file.name)) return { ok: false, diagnostics: [{ code: 'invalid-recipe-extension', message: 'Choose an ImportMedic supplier recipe with a .json extension.' }] };
      if (request.file.size > MAX_RECIPE_BYTES) return { ok: false, diagnostics: [{ code: 'recipe-too-large', message: 'Choose an ImportMedic recipe smaller than 64 KB.' }] };
      return parseSupplierRecipe(new Uint8Array(await request.file.arrayBuffer()));
    }
    case 'applyRecipe':
      if ((baseline?.platform === 'woocommerce' || baseline?.platform === 'bigcommerce') && (request.recipe.joinKey.type !== 'sku' || ('pricingRule' in request.recipe &&
        'compareAtRule' in request.recipe.pricingRule && request.recipe.pricingRule.compareAtRule !== undefined))) {
        return { ok: false, diagnostics: [{ code: baseline.platform === 'bigcommerce' ? 'unsupported-bigcommerce-recipe' : 'unsupported-woo-recipe',
          message: 'Choose a SKU recipe without an automatic compare-at rule for ' + pricePlatformName() + '.' }] };
      }
      return applySupplierRecipe(request.recipe, requireLoaded(suppliers.get(request.supplierId ?? defaultSupplierId), 'Choose a supplier file before applying a recipe.'), request.sheetIndex);
    case 'saveRecipe': {
      const input = requireLoaded(suppliers.get(request.supplierId ?? defaultSupplierId), 'Choose a supplier file before saving a recipe.');
      const sheet = requireLoaded(input.sheets[request.sheetIndex], 'Choose an available supplier worksheet before saving a recipe.');
      const recipe = createSupplierRecipe(request.supplierLabel, sheet.headers, request.selection, /\.xlsx$/i.test(input.name) ? sheet.name : null, request.storeLabel);
      if (!recipe.ok) return recipe;
      const validated = applySupplierRecipe(recipe.value, input, request.sheetIndex);
      if (!validated.ok) return validated;
      const basename = recipe.value.supplierLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'supplier';
      return { ok: true, value: makeDownload(`${basename}-supplier-recipe.json`, serializeSupplierRecipe(recipe.value), jsonMime) };
    }
  }
}

let queue = Promise.resolve();
const revisions = { price: 0, repair: 0, inspection: 0 };
scope.onmessage = ({ data: { id, request } }) => {
  const invalidated = invalidatesResult(request);
  if (invalidated) revisions[invalidated]++;
  const domain = resultScope(request);
  const revision = domain === undefined ? undefined : revisions[domain];
  const isCurrent = () => domain === undefined || revisions[domain] === revision;
  const ensureCurrent = () => {
    if (!isCurrent()) throw new Error(supersededResult);
  };
  queue = queue.then(async () => {
    try {
      ensureCurrent();
      const value = await run(request, (phase, percent) => {
        if (isCurrent()) scope.postMessage({ id, kind: 'progress', progress: { phase, percent } });
      }, ensureCurrent);
      ensureCurrent();
      const download = value && 'ok' in value ? value.ok ? value.value : undefined : value;
      scope.postMessage({ id, kind: 'result', value }, download && 'bytes' in download ? [download.bytes] : undefined);
    } catch (error) {
      scope.postMessage({ id, kind: 'error', message: error instanceof Error ? error.message : 'Local processing failed. Try reopening the file.' });
    }
  });
};
