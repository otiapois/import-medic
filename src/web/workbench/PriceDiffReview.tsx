import { Fragment, lazy, memo, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { hasPricingInstructions, validatePricingRule } from '../../core/shopify-price-diff/pricing-rules';
import type { ColumnSelection, ColumnSuggestions, ConflictPolicy, DiffIssue, DiffRow, RowResolution } from '../../core/shopify-price-diff/types';
import type { ShopifyMarket } from '../../core/shopify-price-diff/markets';
import type { StorePlatform } from '../../core/shopify-price-diff/workspace-profile';
import type { WorkbenchWorker } from '../../core/worker/client';
import type { DiffFilter, DiffSummary, DownloadFormat, PricePreviewRow } from '../../core/worker/protocol';
import type { WhatIfResult, WhatIfScenario } from '../../core/whatif/simulator';
import { BatchImpact } from './BatchImpact';
import { PriceFingerprints } from './CustodyFingerprints';
import { downloadFile, FormulaGuard } from './downloads';
import { PAGE_SIZE, Pagination, pagination } from './Pagination';
import { DiffIssueList, PriceDiffIssues } from './PriceDiffIssues';
import type { GeneratedPairSource, MappingDrafts, ReviewSource } from './PriceDiffWorkbench';
import { formatPriceChange } from './priceDisplay';
import { PricingFormula } from './PricingFormula';
import { useSignoffBranding } from './SignoffBranding';
import { SupplierRecipeBar } from './supplierRecipe';
import type { MappingField } from './supplierRecipe';
import { useWorkerPage } from './useWorkerPage';
import type { useWorkerSession } from './workerSession';
import { STORE_PLATFORMS } from './WorkspaceProfile';

const MarginWhatIf = lazy(() => import('./MarginWhatIf'));

const FILTERS = [
  { id: 'all', label: 'All rows' },
  { id: 'updated', label: 'Updated' },
  { id: 'flagged', label: 'Flagged' },
  { id: 'unmatched', label: 'Unmatched' },
  { id: 'unchanged', label: 'Unchanged' },
  { id: 'skipped', label: 'Skipped' },
] as const;
const OPTION_FIELDS = ['option1', 'option2', 'option3'] as const;
const CONFLICT_POLICIES: Readonly<Record<ConflictPolicy, string>> = {
  'block-conflicts': 'Block conflicts',
  'prefer-first': 'Prefer first supplier',
  'prefer-last': 'Prefer last supplier',
  'prefer-lowest': 'Prefer lowest price',
  'prefer-highest': 'Prefer highest price',
};
const PRICE_GUARDS = new Set(['price-drop', 'price-increase', 'price-increase-from-zero']);
const INVENTORY_GUARDS = new Set(['inventory-drop', 'inventory-zero-out']);
const SECONDARY_PRICE_GUARDS = new Set(['compare-at-not-above-price', 'woo-sale-not-below-regular', 'bigcommerce-sale-not-below-price']);
const SKIPPABLE_CHECKS = new Set([
  ...PRICE_GUARDS, ...INVENTORY_GUARDS, 'invalid-inventory-qty', 'invalid-price', 'invalid-compare-at-price',
  'missing-supplier-key', 'invalid-supplier-variant-key', 'invalid-currency', 'currency-conflict',
  'currency-confirmation-required', 'unsupported-linked-option', 'invalid-computed-price',
  ...SECONDARY_PRICE_GUARDS, 'invalid-sale-price', 'fx-source-currency-conflict',
]);

type PriceDownload = Extract<DownloadFormat, `price-${string}`>;
type RowDecisions = Readonly<Record<number, RowResolution>>;
type SupplierDecisions = Readonly<Record<string, RowDecisions>>;
type ResolveRow = (supplierId: string, row: number, change: RowResolution, message: string) => void;
const NO_DECISIONS: SupplierDecisions = {};
const NO_ROW_DECISIONS: RowDecisions = {};
type RowSettings = { compareAt: boolean; inventory: boolean; storeCurrency?: string };

export function PriceDiffReview({ platform, workspaceCurrency, session, worker, sources, baselineIssues, drafts, setDrafts, onRecipe,
  baselineFile, onPairAvailable, characterKeys, market, targetChanged, targetSelector, active }: {
  platform: StorePlatform;
  workspaceCurrency?: string;
  session: ReturnType<typeof useWorkerSession>;
  worker: WorkbenchWorker | null;
  sources: readonly ReviewSource[];
  baselineIssues: readonly DiffIssue[];
  drafts: MappingDrafts;
  setDrafts: Dispatch<SetStateAction<MappingDrafts>>;
  onRecipe: (supplierId: string, file: File | null) => void;
  baselineFile?: File;
  onPairAvailable: (pair: GeneratedPairSource | null) => void;
  characterKeys: boolean;
  market?: ShopifyMarket;
  targetChanged: boolean;
  targetSelector: ReactNode;
  active: boolean;
}) {
  const id = useId();
  const { branding } = useSignoffBranding();
  const catalog = platform !== 'shopify';
  const platformLabel = STORE_PLATFORMS[platform];
  const { run, invalidate, progress, paused } = session;
  const [policyChoice, setPolicyChoice] = useState<ConflictPolicy>();
  const [notice, setNotice] = useState('');
  const [saveErrors, setSaveErrors] = useState<Record<string, string[]>>({});
  const [whatIfOpen, setWhatIfOpen] = useState(false);
  const multiple = sources.length > 1;
  const settings = useMemo(() => sources.map((source) => {
    const { id, mapping } = source;
    const { selection: draftSelection, remapped, unresolved: draftUnresolved } = drafts[id] ?? {
      selection: targetChanged ? { ...mapping.selection, confirmed: false } : mapping.selection,
      remapped: mapping.remapped || mapping.diagnostics.length > 0,
      unresolved: mapping.missing,
    };
    let selection = draftSelection;
    let unresolved = draftUnresolved;
    if (market) {
      // Keep base-store mappings in the draft while sending only fields that belong to this target.
      const { inventoryColumn: _stock, compareAtColumn, pricingRule, ...rest } = draftSelection;
      selection = rest;
      unresolved = unresolved.filter((field) => field !== 'inventoryColumn' && (market.compareAtHeader || field !== 'compareAtColumn'));
      if (market.compareAtHeader) {
        selection.compareAtColumn = compareAtColumn;
        if (pricingRule) selection.pricingRule = pricingRule;
      } else if (pricingRule) {
        const { compareAtRule: _compareAt, ...priceOnlyRule } = pricingRule;
        selection.pricingRule = priceOnlyRule;
      }
    }
    const rule = selection.pricingRule;
    const fx = rule?.fx;
    const pricingError = validatePricingRule(rule);
    const activeFormula = hasPricingInstructions(rule);
    const rateNeedsConfirmation = Boolean(fx && !selection.fxRateConfirmed);
    const rejected = source.recipeErrors.length > 0;
    const canCompare = !mapping.sheetMissing && !mapping.recipeBlocked && !rejected &&
      !pricingError && !rateNeedsConfirmation && (selection.confirmed || (!targetChanged && !activeFormula));
    const missingRequired = selection.joinKey === 'sku' ? unresolved.includes('skuColumn')
      : unresolved.some((field) => field === 'handleColumn' || OPTION_FIELDS.some((option) => option === field));
    const canConfirm = !pricingError && !rateNeedsConfirmation && !mapping.sheetMissing && !mapping.recipeBlocked && !rejected &&
      !missingRequired && !unresolved.includes('priceColumn') && !unresolved.includes('compareAtColumn') &&
      !unresolved.includes('inventoryColumn') && typeof selection.priceColumn === 'number' && (
        selection.joinKey === 'sku' ? typeof selection.skuColumn === 'number' :
          selection.joinKey === 'handle-options' && typeof selection.handleColumn === 'number' && typeof selection.optionColumns?.[0] === 'number'
      );
    const compareAtColumn = typeof selection.compareAtColumn === 'number';
    return {
      source, selection, draftSelection, remapped, unresolved, draftUnresolved, pricingError, activeFormula, fx, canCompare, canConfirm, compareAtColumn,
      compareAt: compareAtColumn || Boolean(rule?.compareAtRule),
      inventory: typeof selection.inventoryColumn === 'number',
      storeCurrency: fx?.storeCurrency ?? (market ? undefined : workspaceCurrency),
    };
  }), [drafts, market, sources, targetChanged, workspaceCurrency]);
  const restoredPolicies = new Set(settings.flatMap(({ selection }) => selection.conflictPolicy ? [selection.conflictPolicy] : []));
  const conflictPolicy = policyChoice ?? (restoredPolicies.size === 1 ? [...restoredPolicies][0] : 'block-conflicts');
  const configuration = useMemo(() => ({ settings, conflictPolicy }), [settings, conflictPolicy]);
  const decisionContext = useMemo(() => ({ sources, conflictPolicy, market }), [sources, conflictPolicy, market]);
  const [confirmedPolicy, setConfirmedPolicy] = useState<{
    configuration?: typeof configuration;
    scenario?: { context: typeof decisionContext; drafts: MappingDrafts };
  } | null>(null);
  const [rowDecisions, setRowDecisions] = useState<{ context: typeof decisionContext; bySupplier: SupplierDecisions } | null>(null);
  const resolutions = rowDecisions?.context === decisionContext ? rowDecisions.bySupplier : NO_DECISIONS;
  const approvedScenario = confirmedPolicy?.scenario;
  const conflictPolicyConfirmed = confirmedPolicy?.configuration === configuration ||
    (approvedScenario?.drafts === drafts && approvedScenario.context === decisionContext);
  const preparedInputs = useMemo(() => ({ configuration, resolutions, conflictPolicyConfirmed, worker }),
    [configuration, resolutions, conflictPolicyConfirmed, worker]);
  const [report, setReport] = useState<{ summary: DiffSummary; worker: WorkbenchWorker; inputs: typeof preparedInputs } | null>(null);
  const canCompare = settings.every((item) => item.canCompare);
  const allConfirmed = settings.every(({ selection }) => selection.confirmed);
  const current = Boolean(worker && report?.inputs === preparedInputs);
  const summary = current && canCompare ? report?.summary ?? null : null;
  const busy = Boolean(progress) || paused;
  const rowSettings = useMemo(() => Object.fromEntries(settings.map(({ source, compareAt, inventory, storeCurrency }) =>
    [source.id, { compareAt, inventory, storeCurrency }])), [settings]);
  const overlapCount = (market || targetChanged ? summary : report?.summary)?.overlapCount ?? 0;
  const policyPending = multiple && overlapCount > 0 && conflictPolicy !== 'block-conflicts' && !conflictPolicyConfirmed;
  const ready = nativePairReady(summary) && !policyPending;
  const scenarioReport = active && whatIfOpen && allConfirmed && summary && !summary.mappingBlocked && !policyPending ? report : null;
  const compareScenarios = useMemo(() => scenarioReport
    ? (scenarios: WhatIfScenario[]) => scenarioReport.worker.request({ type: 'simulatePrice', scenarios })
    : null, [scenarioReport]);
  const inventory = settings.some((item) => item.inventory);
  const pairSource = useMemo((): GeneratedPairSource | null => {
    if (!ready || !summary || !worker || !baselineFile) return null;
    return {
      platform,
      market: summary.market,
      baseline: baselineFile,
      async load() {
        const [update, rollback] = await Promise.all([
          worker.request({ type: 'download', format: 'price-csv' }),
          worker.request({ type: 'download', format: 'price-rollback-csv' }),
        ]);
        return {
          update: new File([update.bytes], update.filename, { type: update.mime }),
          rollback: new File([rollback.bytes], rollback.filename, { type: rollback.mime }),
        };
      },
    };
  }, [ready, summary, worker, baselineFile, platform]);

  useLayoutEffect(() => {
    if (!pairSource) return;
    onPairAvailable(pairSource);
    return () => onPairAvailable(null);
  }, [onPairAvailable, pairSource]);

  useEffect(() => {
    if (!worker || !canCompare) return;
    void run(({ worker, progress: update }) => {
      if (multiple) {
        return worker.request({
          type: 'diffBatch', conflictPolicy, conflictPolicyConfirmed, ...(market ? { market: market.name } : {}),
          suppliers: settings.map(({ source, selection }) => ({
            supplierId: source.id, label: source.label, sheetIndex: source.mapping.sheetIndex,
            selection, resolutions: resolutions[source.id] ?? NO_ROW_DECISIONS,
          })),
        }, update);
      }
      const [{ source, selection }] = settings;
      return worker.request({
        type: 'diff', supplierId: source.id, label: source.labelOverride, sheetIndex: source.mapping.sheetIndex,
        selection, resolutions: resolutions[source.id] ?? NO_ROW_DECISIONS, ...(market ? { market: market.name } : {}),
      }, update);
    }, (summary, worker) => setReport({ summary, worker, inputs: preparedInputs }), 'comparing');
  }, [preparedInputs, worker, canCompare, multiple, conflictPolicy, conflictPolicyConfirmed, market, settings, resolutions, run]);

  function patchSelection(supplierId: string, change: Partial<ColumnSelection>) {
    invalidate();
    const { draftSelection, draftUnresolved, remapped } = settings.find(({ source }) => source.id === supplierId)!;
    if (change.inventoryDropThresholdPercent !== undefined && change.inventoryDropThresholdPercent !== (draftSelection.inventoryDropThresholdPercent ?? 80)) {
      setRowDecisions(null);
    }
    setDrafts((previous) => ({ ...previous, [supplierId]: { selection: { ...draftSelection, ...change }, unresolved: draftUnresolved, remapped } }));
  }

  function changeMapping(supplierId: string, change: Partial<ColumnSelection>, field?: MappingField) {
    invalidate();
    if (canCompare) void worker?.request({ type: 'invalidatePrice' }).catch(() => undefined);
    const item = settings.find(({ source }) => source.id === supplierId)!;
    const selection = { ...item.draftSelection, ...change, confirmed: false, sameCurrencyConfirmed: false };
    if (field === 'priceColumn' || (change.pricingRule && change.pricingRule.fx !== item.draftSelection.pricingRule?.fx)) selection.fxRateConfirmed = false;
    if (market && !market.compareAtHeader && change.pricingRule && item.draftSelection.pricingRule?.compareAtRule) {
      selection.pricingRule = { ...change.pricingRule, compareAtRule: item.draftSelection.pricingRule.compareAtRule };
    } else if (typeof selection.compareAtColumn === 'number' && selection.pricingRule?.compareAtRule) {
      const { compareAtRule, ...ruleWithoutCompareAt } = selection.pricingRule;
      selection.pricingRule = ruleWithoutCompareAt;
    }
    setDrafts((previous) => ({
      ...previous, [supplierId]: {
        selection,
        unresolved: field ? item.draftUnresolved.filter((name) => name !== field) : item.draftUnresolved,
        remapped: item.remapped || Boolean(item.source.recipe && !change.pricingRule),
      },
    }));
    setRowDecisions(null);
    setNotice('');
  }

  const resolveRow = useCallback<ResolveRow>((supplierId, row, change, message) => {
    invalidate();
    setRowDecisions({
      context: decisionContext,
      bySupplier: { ...resolutions, [supplierId]: { ...resolutions[supplierId], [row]: { ...resolutions[supplierId]?.[row], ...change } } },
    });
    const label = multiple ? settings.find(({ source }) => source.id === supplierId)?.source.label ?? 'Supplier' : 'Supplier';
    setNotice(`${label} row ${row}. ${message}`);
  }, [decisionContext, invalidate, multiple, resolutions, settings]);

  function saveRecipe(source: ReviewSource, selection: ColumnSelection, supplierLabel: string, storeLabel?: string) {
    if (busy || !summary || summary.mappingBlocked || !selection.confirmed) return;
    setSaveErrors((previous) => ({ ...previous, [source.id]: [] }));
    void run(({ worker, progress: update }) => worker.request({
      type: 'saveRecipe', supplierId: source.id, supplierLabel, storeLabel, sheetIndex: source.mapping.sheetIndex,
      selection: { ...selection, ...(multiple ? { conflictPolicy } : {}) },
    }, update), (response) => {
      if (!response.ok) {
        setSaveErrors((previous) => ({ ...previous, [source.id]: response.diagnostics.map(({ message }) => message) }));
        return;
      }
      const { filename, bytes, mime } = response.value;
      downloadFile(filename, bytes, mime);
      setNotice('Supplier recipe saved as a local JSON file.');
    }, 'exporting');
  }

  function download(format: PriceDownload) {
    if (busy || !summary || ((format === 'price-csv' || format === 'price-rollback-csv') && !ready)) return;
    void run(
      ({ worker, progress: update }) => worker.request({
        type: 'download', format, ...(format === 'price-signoff-html' && branding ? { branding } : {}),
      }, update),
      ({ filename, bytes, mime }) => downloadFile(filename, bytes, mime),
      'exporting',
    );
  }

  function applyScenario(result: WhatIfResult, label: string) {
    if (!scenarioReport || scenarioReport.inputs !== preparedInputs || busy || !result.canApply) return false;
    const rules = new Map(result.suppliers.map(({ supplierId, pricingRule }) => [supplierId, pricingRule]));
    const nextDrafts = Object.fromEntries(settings.map(({ source, draftSelection, draftUnresolved, remapped }) => {
      const rule = rules.get(source.id);
      const compareAtRule = market && !market.compareAtHeader ? draftSelection.pricingRule?.compareAtRule : undefined;
      const pricingRule = compareAtRule ? { ...(rule ?? { mode: 'direct' }), compareAtRule } : rule;
      return [source.id, { selection: { ...draftSelection, pricingRule }, unresolved: draftUnresolved, remapped }];
    })) satisfies MappingDrafts;
    invalidate();
    if (conflictPolicyConfirmed) setConfirmedPolicy({ scenario: { context: decisionContext, drafts: nextDrafts } });
    setDrafts(nextDrafts);
    setNotice(`Applied ${label} to the update. Rebuilding the price diff.`);
    return true;
  }

  return (
    <section className="workbench-results price-review" aria-labelledby={`${id}-heading`}>
      <div className="price-section price-settings">
        {targetSelector}
        {settings.map(({ source, selection, remapped, unresolved, pricingError, activeFormula, fx, canConfirm, compareAtColumn }) => {
          const { id, label, headers, recipe, recipeErrors, mapping } = source;
          const { sheetIndex, sheetMissing, suggestions } = mapping;
          const recipeDiagnostics = (selection.confirmed ? [] : mapping.diagnostics).concat(recipeErrors, saveErrors[id] ?? []);
          const recipeStatus = recipe ? (
            selection.confirmed && !summary?.mappingBlocked
              ? `Recipe applied${remapped ? ' with remapping' : ''}: ${recipe.supplierLabel}.`
              : `Recipe needs review: ${recipe.supplierLabel}. ${sheetMissing ? 'Choose a replacement worksheet.' : mapping.diagnostics.length ? 'Review the column choices, then confirm them.' : 'Check and confirm the saved columns and pricing settings.'}`
          ) : '';
          const currencyReport = targetChanged ? summary : summary ?? report?.summary;
          const needsCurrency = multiple ? currencyReport?.currencyConfirmationSupplierIds?.includes(id) : currencyReport?.currencyConfirmationRequired;
          return (
            <div key={id} className={multiple ? 'price-supplier-settings' : undefined} role={multiple ? 'group' : undefined}
              aria-label={multiple ? `Settings for ${label}` : undefined}>
              {multiple ? <h3>{label}</h3> : null}
              <SupplierRecipeBar recipe={recipe} status={recipeStatus} diagnostics={recipeDiagnostics}
                defaultLabel={multiple ? label : undefined} busy={busy}
                canSave={Boolean(summary && !summary.mappingBlocked && selection.confirmed)}
                onLoad={(file) => onRecipe(id, file)} onClear={() => onRecipe(id, null)}
                onSave={(label, storeLabel) => saveRecipe(source, selection, label, storeLabel)} />
              <ColumnMapping platform={platform} market={market} headers={headers} suggestions={suggestions} selection={selection} canConfirm={canConfirm && !paused}
                invalidPricing={Boolean(pricingError)} hasSavedRate={Boolean(recipe && recipe.version >= 3 && 'fxRateNeedsRecheck' in recipe && recipe.fxRateNeedsRecheck)}
                unresolved={unresolved} onChange={(change, field) => changeMapping(id, change, field)}
                onConfirmRate={(fxRateConfirmed) => {
                  if (!fxRateConfirmed) void worker?.request({ type: 'invalidatePrice' }).catch(() => undefined);
                  patchSelection(id, { fxRateConfirmed, confirmed: false });
                  setNotice('');
                }} onConfirm={() => {
                  patchSelection(id, { confirmed: true });
                  setNotice(activeFormula ? 'Supplier columns and pricing formula confirmed.' : 'Supplier columns confirmed.');
                }}>
                <PricingFormula selection={selection} error={pricingError} worker={worker} supplierId={id} sheetIndex={sheetIndex} workspaceCurrency={workspaceCurrency}
                  market={market} secondaryPriceLabel={catalog ? 'Sale price' : market?.compareAtHeader ?? 'Compare-at'}
                  canAutoCompareAt={!catalog && (!market || Boolean(market.compareAtHeader)) && !compareAtColumn && !unresolved.includes('compareAtColumn')}
                  onChange={(pricingRule) => changeMapping(id, { pricingRule })} />
              </ColumnMapping>
              <Guardrails selection={selection} onApply={(change) => {
                patchSelection(id, change);
                setNotice('Guardrail thresholds updated.');
              }} />
              {!fx && selection.confirmed && (selection.sameCurrencyConfirmed || needsCurrency) ? (
                <div className="price-currency">
                  <label className="checkbox-label">
                    <input type="checkbox" checked={selection.sameCurrencyConfirmed ?? false}
                      onChange={(event) => patchSelection(id, { sameCurrencyConfirmed: event.currentTarget.checked })} />
                    <span>{market ? `I confirm the supplier prices use the ${market.name} market currency.` : `I confirm the supplier prices use my ${platformLabel} store currency.`}</span>
                  </label>
                  <p className="field-help">These prices use {market ? 'the target market’s currency' : 'the store currency'} directly. You can enable manual conversion in Pricing formula &amp; rounding.</p>
                </div>
              ) : null}
            </div>
          );
        })}
        {multiple && overlapCount > 0 ? (
          <div className="price-conflict-policy">
            <label htmlFor={`${id}-policy`}>Supplier conflict policy</label>
            <select id={`${id}-policy`} value={conflictPolicy} aria-describedby={`${id}-policy-help`} onChange={(event) => {
              invalidate();
              setPolicyChoice(event.currentTarget.value as ConflictPolicy);
              setConfirmedPolicy(null);
              setRowDecisions(null);
            }}>
              {Object.entries(CONFLICT_POLICIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <p id={`${id}-policy-help`} className="field-help" role="status">
              {overlapCount.toLocaleString('en-US')} {overlapCount === 1 ? 'variant appears' : 'variants appear'} in multiple supplier sheets.
              {restoredPolicies.size > 1 && !policyChoice ? ' The loaded recipes specify different policies. Choose one for this batch.' : ''}
              {conflictPolicy === 'block-conflicts' ? ` Conflicting values block both ${platformLabel} downloads.`
                : conflictPolicyConfirmed ? ' Policy confirmed for this batch.' : ' Confirm this policy for the current batch.'}
            </p>
            {conflictPolicy !== 'block-conflicts' && !conflictPolicyConfirmed ? (
              <button type="button" className="button button-primary button-small"
                disabled={busy || !summary?.overlapCount || !allConfirmed || summary.mappingBlocked}
                onClick={() => {
                  invalidate();
                  setConfirmedPolicy({ configuration });
                  setNotice('Supplier conflict policy confirmed for this batch.');
                }}>Confirm supplier conflict policy</button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="price-section price-preview">
        <div className="price-heading">
          <div>
            <h2 id={`${id}-heading`}>Before / after price diff{market ? ` · ${market.priceHeader}` : ''}</h2>
            <p className="field-help">{multiple ? `Source rows refer to the original ${platformLabel} baseline and each supplier worksheet.`
              : 'Row numbers refer to the original baseline CSV and the selected supplier sheet.'}</p>
          </div>
          <span className={`issue-badge ${ready || (summary?.status === 'no-changes' && !policyPending) ? 'badge-fixed' : 'badge-review'}`}
            role="status" data-testid="price-diff-status">
            {ready ? 'Ready to download' : summary?.status === 'no-changes' && !policyPending ? inventory ? 'No price or inventory changes' : 'No price changes' : 'Review required'}
          </span>
        </div>
        <p className="sr-only" role="status">{notice}</p>
        {!allConfirmed && !summary ? <PriceDiffIssues issues={[...baselineIssues, ...sources.flatMap(({ issues }) => issues)]} title="File checks" /> : null}
        {report && summary?.issueCount ? <PriceIssues worker={report.worker} summary={summary} showSupplierSource={multiple} /> : null}
        {allConfirmed && !summary?.mappingBlocked ? (
          <PriceDiffTable platform={platform} report={summary ? report : null} ready={ready} compareAt={settings.some(({ compareAt }) => compareAt)} inventory={inventory}
            showSource={multiple || inventory || Boolean(sources[0].labelOverride)} defaultSourceId={sources[0].id} rowSettings={rowSettings}
            conflictPolicy={conflictPolicy} policyTarget={overlapCount > 0 ? `${id}-policy` : undefined}
            activeFormula={settings.some(({ activeFormula }) => activeFormula)} resolutions={resolutions} onResolve={resolveRow}
            characterKeys={characterKeys} />
        ) : <p className="empty-panel">Choose and confirm the supplier columns to compare prices.</p>}
      </div>
      <div className="price-section what-if-section">
        <details className="what-if-panel" onToggle={(event) => setWhatIfOpen(event.currentTarget.open)}>
          <summary>Interactive Margin What-If</summary>
          {whatIfOpen ? (
            <Suspense fallback={<p className="field-help" role="status">Opening margin simulator…</p>}>
              <MarginWhatIf compare={compareScenarios} busy={busy} onApply={applyScenario} />
            </Suspense>
          ) : null}
        </details>
      </div>
      <PriceExports platform={platform} market={market} summary={summary} busy={busy} ready={ready} policyPending={policyPending}
        guard={settings.some(({ selection }) => selection.formulaGuard)} inventory={inventory}
        onGuard={(formulaGuard) => {
          invalidate();
          setDrafts(Object.fromEntries(settings.map(({ source, draftSelection, draftUnresolved, remapped }) => [
            source.id, { selection: { ...draftSelection, formulaGuard }, unresolved: draftUnresolved, remapped },
          ])));
        }} onDownload={download} />
    </section>
  );
}

function ColumnMapping({ platform, market, headers, suggestions, selection, canConfirm, invalidPricing, hasSavedRate, unresolved, onChange, onConfirmRate, onConfirm, children }: {
  platform: StorePlatform;
  market?: ShopifyMarket;
  headers: readonly string[];
  suggestions: ColumnSuggestions;
  selection: ColumnSelection;
  canConfirm: boolean;
  invalidPricing: boolean;
  hasSavedRate: boolean;
  unresolved: readonly MappingField[];
  onChange: (change: Partial<ColumnSelection>, field?: MappingField) => void;
  onConfirmRate: (checked: boolean) => void;
  onConfirm: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const heading = useRef<HTMLLegendElement>(null);
  const fx = selection.pricingRule?.fx;
  const catalog = platform !== 'shopify';
  const canMapCompareAt = !market || Boolean(market.compareAtHeader);
  const confirmation = (
    <div className="price-mapping-note">
      <p className="field-help">{selection.confirmed
        ? catalog ? 'A blank sale price value keeps the baseline value.'
          : !canMapCompareAt ? `Confirmed for ${market?.priceHeader}.`
            : selection.pricingRule?.compareAtRule ? 'Compare-at uses the automatic pricing rule.' : 'A blank compare-at value keeps the baseline value.'
        : invalidPricing ? 'Check the settings in Pricing formula & rounding before confirming.'
          : 'Confirm your column choices and pricing settings. Changing either clears row decisions.'}</p>
      {!selection.confirmed ? <button type="button" className="button button-primary button-small" disabled={!canConfirm} onClick={() => {
        heading.current?.focus({ preventScroll: true });
        onConfirm();
      }}>Confirm columns</button> : null}
    </div>
  );
  return (
    <fieldset className="price-mapping">
      <legend ref={heading} tabIndex={-1}>Match supplier columns</legend>
      <div className="price-fields">
        {catalog ? null : <label>Join key
          <select value={selection.joinKey ?? ''} onChange={(event) => {
            const joinKey = event.currentTarget.value as ColumnSelection['joinKey'];
            onChange({ joinKey });
          }}>
            <option value="" disabled>Choose a join key</option>
            <option value="sku">Variant SKU</option>
            <option value="handle-options">Handle + variant options</option>
          </select>
        </label>}
        {!catalog && selection.joinKey === 'handle-options' ? (
          <>
            <ColumnField label="Handle column" value={selection.handleColumn} headers={headers} suggested={suggestions.handleColumns}
              missing={unresolved.includes('handleColumn')} onChange={(handleColumn) => onChange({ handleColumn }, 'handleColumn')} />
            {OPTION_FIELDS.map((field, index) => (
              <ColumnField key={field} label={`Option ${index + 1} value column`} value={selection.optionColumns?.[index]}
                headers={headers} suggested={suggestions.optionColumns[index] ?? []} blank="No column"
                missing={unresolved.includes(field)}
                onChange={(column) => onChange({ optionColumns: OPTION_FIELDS.map((_, slot) => slot === index ? column ?? null : selection.optionColumns?.[slot] ?? null) }, field)}
              />
            ))}
          </>
        ) : catalog || selection.joinKey === 'sku' ? (
          <ColumnField label="SKU column" value={selection.skuColumn} headers={headers} suggested={suggestions.skuColumns}
            missing={unresolved.includes('skuColumn')} onChange={(skuColumn) => onChange({ skuColumn }, 'skuColumn')} />
        ) : null}
        <ColumnField label={catalog ? 'Regular price column' : 'New price column'} value={selection.priceColumn} headers={headers} suggested={suggestions.priceColumns}
          missing={unresolved.includes('priceColumn')} onChange={(priceColumn) => onChange({ priceColumn }, 'priceColumn')} />
        <ColumnField label={catalog ? 'Sale price column (optional)' : 'Compare-at price column'} value={selection.compareAtColumn} headers={headers} suggested={suggestions.compareAtColumns} blank="Leave unchanged"
          disabled={!canMapCompareAt}
          missing={unresolved.includes('compareAtColumn')} onChange={(compareAtColumn) => onChange({ compareAtColumn: compareAtColumn ?? null }, 'compareAtColumn')} />
      </div>
      {!fx ? confirmation : null}
      {children}
      {fx ? (
        <>
          <div className="price-currency">
            <label className="checkbox-label">
              <input type="checkbox" checked={selection.fxRateConfirmed ?? false} disabled={invalidPricing} aria-describedby={`${id}-fx-recheck`}
                onChange={(event) => onConfirmRate(event.currentTarget.checked)} />
              <span>I verified today’s FX rate for this batch.</span>
            </label>
            <p id={`${id}-fx-recheck`} className="field-help">
              {hasSavedRate ? 'This recipe includes a saved FX rate. Verify today’s FX rate before confirming columns.'
                : 'Verify the manual FX rate for this batch before confirming columns.'}
              {!invalidPricing ? <> <code>{fx.sourceCurrency} → {fx.storeCurrency} @ {fx.fxRate}</code></> : null}
            </p>
          </div>
          {confirmation}
        </>
      ) : null}
      <div className="price-inventory-settings">
        <ColumnField label={catalog ? 'Stock column (optional)' : 'Inventory qty column (optional)'} value={selection.inventoryColumn} headers={headers} blank="Leave unchanged" disabled={Boolean(market)}
          missing={unresolved.includes('inventoryColumn')} onChange={(inventoryColumn) => onChange({ inventoryColumn: inventoryColumn ?? null }, 'inventoryColumn')} />
        {market ? <p className="field-help">Inventory mapping is available for the base store.</p> : typeof selection.inventoryColumn === 'number' ? (
          <p className="field-help">{platform === 'bigcommerce'
            ? <>Stock needs a numeric baseline quantity and the original <code>Track Inventory</code> value. Use <code>by product</code> for standalone products or <code>by option</code> on the parent of a SKU.</>
            : catalog ? 'Stock updates require an existing numeric quantity. Large drops and zero quantities require review.'
              : 'Shopify’s product CSV quantity column is for single-location stores. Large drops and zero quantities require review.'}</p>
        ) : null}
      </div>
    </fieldset>
  );
}

function ColumnField({ label, headers, suggested, value, blank, missing, disabled, onChange }: {
  label: string;
  headers: readonly string[];
  suggested?: readonly number[];
  value: number | null | undefined;
  blank?: string;
  missing: boolean;
  disabled?: boolean;
  onChange: (index: number | undefined) => void;
}) {
  const id = useId();
  return (
    <label><span id={id}>{label}</span>
      <select aria-labelledby={id} value={value ?? (blank && !missing ? 'none' : '')} aria-invalid={missing || undefined} disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value === 'none' ? undefined : Number(event.currentTarget.value))}>
        {missing || !blank ? <option value="" disabled>{missing ? 'Choose a replacement column' : 'Choose a column'}</option> : null}
        {blank ? <option value="none">{blank}</option> : null}
        {headers.map((header, index) => <option key={index} value={index}>{index + 1}. {header || '(blank header)'}{suggested?.includes(index) ? ' (suggested)' : ''}</option>)}
      </select>
    </label>
  );
}

function Guardrails({ selection, onApply }: {
  selection: ColumnSelection;
  onApply: (change: Partial<ColumnSelection>) => void;
}) {
  const inventory = typeof selection.inventoryColumn === 'number';
  return (
    <details className="price-guardrails">
      <summary>Price guardrails · {selection.dropThresholdPercent ?? 50}% drop / {selection.increaseThresholdPercent ?? 200}% increase
        {inventory ? ` · ${selection.inventoryDropThresholdPercent ?? 80}% maximum stock drop` : ''}</summary>
      <p className="field-help">A change beyond either threshold, zero, or an invalid price requires review.
        {inventory ? ' Zero stock or a drop beyond the stock threshold also requires review.' : ''}</p>
      <form className="price-guardrail-form" onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        onApply({
          dropThresholdPercent: Number(values.get('drop')),
          increaseThresholdPercent: Number(values.get('increase')),
          ...(inventory ? { inventoryDropThresholdPercent: Number(values.get('stockDrop')) } : {}),
        });
      }}>
        <label>Maximum drop (%)<input name="drop" type="number" min="0" max="100" step="0.001" required defaultValue={selection.dropThresholdPercent ?? 50} /></label>
        <label>Maximum increase (%)<input name="increase" type="number" min="0" max="100000" step="0.001" required defaultValue={selection.increaseThresholdPercent ?? 200} /></label>
        {inventory ? <label>Maximum stock drop (%)<input name="stockDrop" type="number" min="0" max="100" step="0.001" required defaultValue={selection.inventoryDropThresholdPercent ?? 80} /></label> : null}
        <button className="button button-secondary button-small" type="submit">Apply guardrails</button>
      </form>
    </details>
  );
}

function PriceIssues({ worker, summary, showSupplierSource }: { worker: WorkbenchWorker; summary: DiffSummary; showSupplierSource: boolean }) {
  const [requestedPage, setPage] = useState(0);
  const page = pagination(summary.issueCount, requestedPage, setPage);
  const read = useCallback(() => worker.request({ type: 'diffIssues', page: page.page, pageSize: PAGE_SIZE }), [worker, summary, page.page]);
  const data = useWorkerPage(read);
  return (
    <>
      {data?.error ? <p role="alert">{data.error}</p> : null}
      {data?.page ? <DiffIssueList issues={data.page.rows} title="File and mapping checks" showSupplierSource={showSupplierSource} /> : null}
      <Pagination state={page} total={summary.issueCount} />
    </>
  );
}

interface PriceRowOptions {
  platform: StorePlatform;
  compareAt: boolean;
  inventory: boolean;
  ready: boolean;
  showSource: boolean;
  activeFormula: boolean;
  defaultSourceId: string;
  rowSettings: Readonly<Record<string, RowSettings>>;
  conflictPolicy: ConflictPolicy;
  policyTarget?: string;
  resolutions: SupplierDecisions;
  onResolve: ResolveRow;
}

const PriceDiffTable = memo(function PriceDiffTable({ report, onResolve, characterKeys, ...options }: PriceRowOptions & {
  report: { summary: DiffSummary; worker: WorkbenchWorker } | null;
  characterKeys: boolean;
}) {
  const [filter, setFilter] = useState<DiffFilter>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const searchHelp = useId();
  const queueId = useId();
  const controls = useRef<HTMLDivElement>(null);
  const pendingSearch = search.trim() !== query;
  const activeWatchlist = filter === 'margin-watchlist';
  const toggleWatchlist = useCallback(() => setFilter((current) => current === 'margin-watchlist' ? 'all' : 'margin-watchlist'), []);
  const resolve = useCallback<ResolveRow>((supplierId, line, change, message) => {
    controls.current?.focus({ preventScroll: true });
    onResolve(supplierId, line, change, message);
  }, [onResolve]);
  useEffect(() => {
    if (!pendingSearch) return;
    // Send only the settled search to the worker, and hide the old page as soon as the input changes.
    const timeout = window.setTimeout(() => setQuery(search.trim()), 100);
    return () => window.clearTimeout(timeout);
  }, [pendingSearch, search]);
  return (
    <>
      {report ? <BatchImpact impact={report.summary.analytics} platform={options.platform} market={report.summary.market?.priceHeader}
        active={activeWatchlist} queueId={queueId} onToggle={toggleWatchlist} /> : null}
      <label className="price-search">{options.platform === 'woocommerce' ? 'Search by SKU, ID or Parent'
        : options.platform === 'bigcommerce' ? 'Search by SKU, ID or Product Name' : 'Search by SKU or Handle'}
        <input data-price-row-search type="search" value={search} maxLength={300}
          aria-keyshortcuts={characterKeys ? '/' : undefined} aria-describedby={characterKeys ? searchHelp : undefined}
          onChange={(event) => setSearch(event.currentTarget.value)} />
      </label>
      {characterKeys ? <p className="field-help" id={searchHelp}>Press <kbd>/</kbd> to focus search.</p> : null}
      <div className="price-filters" role="group" aria-label="Filter price diff" tabIndex={-1} ref={controls}>
        {FILTERS.map(({ id, label }) => (
          <button type="button" key={id} aria-pressed={filter === id}
            aria-description={report ? `${report.summary.counts[id]} rows` : undefined}
            className="button button-secondary button-small" onClick={() => setFilter(id)}>
            {label} {report ? <span aria-hidden="true">{report.summary.counts[id].toLocaleString('en-US')}</span> : null}
          </button>
        ))}
      </div>
      <div id={queueId} aria-busy={pendingSearch || !report}>
        {report && !pendingSearch ? (
          <PriceRows key={JSON.stringify([filter, query])} worker={report.worker} summary={report.summary}
            filter={filter} search={query} {...options} onResolve={resolve} />
        ) : <p className="empty-panel">{report ? 'Loading price rows…' : 'The price queue refreshes after processing finishes.'}</p>}
      </div>
    </>
  );
});

function PriceRows({ platform, worker, summary, filter, search, compareAt, inventory, ready, showSource, activeFormula, defaultSourceId,
  rowSettings, conflictPolicy, policyTarget, resolutions, onResolve }: PriceRowOptions & {
  worker: WorkbenchWorker;
  summary: DiffSummary;
  filter: DiffFilter;
  search: string;
}) {
  const catalog = platform !== 'shopify';
  const market = summary.market;
  const priceHeading = market?.priceHeader ?? (catalog ? 'Regular price' : undefined);
  const secondaryHeading = market?.compareAtHeader ?? (catalog ? 'Sale price' : 'Compare-at');
  const [request, setRequest] = useState({ page: 0, total: 0 });
  const [editingRow, setEditingRow] = useState<string | null>(null);
  const watchlist = filter === 'margin-watchlist';
  const read = useCallback(() => worker.request({ type: 'diffRows', filter, search, page: request.page, pageSize: PAGE_SIZE }),
    [worker, summary, filter, search, request.page]);
  const data = useWorkerPage(read);
  const result = data?.page;
  const total = search ? result?.total ?? request.total : summary.counts[filter];
  const page = pagination(total, result?.page ?? request.page, (page) => {
    setEditingRow(null);
    setRequest({ page, total });
  });
  return (
    <>
      <p className="field-help" role="status">
        {result ? `${total.toLocaleString('en-US')} ${total === 1 ? 'matching row' : 'matching rows'}` : 'Loading price rows…'}
      </p>
      {data?.error ? <p role="alert">{data.error}</p> : null}
      {result?.rows.length ? (
        <div className="preview-card price-table-card">
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Price diff scrollable table">
            <table className="price-table" data-stock-and-source={inventory && showSource} data-market={Boolean(market)}
              aria-label={`${STORE_PLATFORMS[platform]} price diff${market ? ` · ${market.priceHeader}` : ''}`}>
              <thead>
                <tr>
                  <th scope="col" className="line-cell">{platform === 'bigcommerce' ? 'Product or SKU' : catalog ? 'Product or variation' : 'Variant'}</th>
                  <th scope="col">{priceHeading ? `${priceHeading} before` : 'Before'}</th>
                  {activeFormula ? <><th scope="col">Supplier raw</th><th scope="col">Computed price</th></> : null}
                  <th scope="col">{priceHeading ? `${priceHeading} after` : 'After'}</th><th scope="col">Change</th><th scope="col" className="price-status-column">Status</th>
                  {compareAt && watchlist ? <th scope="col">{secondaryHeading}</th> : null}
                  {compareAt && !watchlist ? <><th scope="col">{secondaryHeading} before</th><th scope="col">{secondaryHeading} after</th></> : null}
                  {inventory ? <><th scope="col">{catalog ? 'Stock before' : 'Qty before'}</th><th scope="col">{catalog ? 'Stock after' : 'Qty after'}</th></> : null}
                  {showSource ? <th scope="col" className="price-row-source">Supplier source</th> : null}
                  <th scope="col">Source rows</th><th scope="col" className="price-row-review">Review</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => {
                  const supplierId = row.supplierId ?? defaultSourceId;
                  return (
                    <PriceRow key={row.id} row={row} supplierId={supplierId} options={row.variantOptions} catalog={catalog}
                      compareAt={compareAt} inventory={inventory} showSource={showSource} conflictPolicy={conflictPolicy} policyTarget={policyTarget}
                      activeFormula={activeFormula} watchlist={watchlist} settings={rowSettings[supplierId]}
                      manualPrice={row.supplierRow !== null && resolutions[supplierId]?.[row.supplierRow]?.price !== undefined}
                      editing={editingRow === row.id} onEdit={(open) => setEditingRow(open ? row.id : null)}
                      showExportContext={ready} onResolve={onResolve} />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : result ? (
        <p className="empty-panel">{filter === 'all' && !search ? 'No price rows to compare yet.' : 'No rows match this filter.'}</p>
      ) : null}
      <Pagination state={page} total={total} />
    </>
  );
}

function PriceRow({ row, supplierId, options, catalog, compareAt, inventory, showSource, activeFormula, watchlist, settings, conflictPolicy,
  policyTarget, manualPrice, editing, showExportContext, onEdit, onResolve }: {
  row: PricePreviewRow;
  supplierId: string;
  options: string | undefined;
  catalog: boolean;
  compareAt: boolean;
  inventory: boolean;
  showSource: boolean;
  activeFormula: boolean;
  watchlist: boolean;
  settings?: RowSettings;
  conflictPolicy: ConflictPolicy;
  policyTarget?: string;
  manualPrice: boolean;
  editing: boolean;
  showExportContext: boolean;
  onEdit: (open: boolean) => void;
  onResolve: ResolveRow;
}) {
  const id = useId();
  const action = useRef<HTMLButtonElement>(null);
  const supplierLine = row.supplierRow;
  const skipped = row.status === 'Skipped';
  const blocking = row.issues.filter(({ blocking }) => blocking);
  const canSkip = supplierLine !== null && blocking.every(({ code }) => SKIPPABLE_CHECKS.has(code));
  const canConfirm = row.status === 'Blocked' && blocking.length > 0 && blocking.every(({ code }) => PRICE_GUARDS.has(code) || INVENTORY_GUARDS.has(code));
  const priceGuard = blocking.some(({ code }) => PRICE_GUARDS.has(code));
  const inventoryGuard = blocking.some(({ code }) => INVENTORY_GUARDS.has(code));
  const quantity = catalog ? 'stock' : 'inventory qty';
  const confirmation = inventoryGuard ? priceGuard ? `Confirm proposed price and ${quantity}` : `Confirm proposed ${quantity}` : 'Confirm proposed price';
  const compareAtBlocked = blocking.some(({ code }) => SECONDARY_PRICE_GUARDS.has(code));
  const beforeSecondaryPrice = row.oldCompareAtPrice || '—';
  const afterSecondaryPrice = (skipped ? row.oldCompareAtPrice : row.newCompareAtPrice ?? row.supplierCompareAtPrice) ||
    (row.compareAtOutput === 'empty' ? '(empty)' : '—');
  const secondaryStatus = compareAtBlocked ? 'review' : row.status === 'Updated' && row.oldCompareAtPrice !== row.newCompareAtPrice ? 'changed' : undefined;
  const invalidInventory = blocking.some(({ code }) => code === 'invalid-inventory-qty');
  const inventoryBlocked = inventoryGuard || invalidInventory;
  const canEditPrice = row.baselineRow !== null && row.bigcommerce?.type !== 'SKU';
  const canEditInventory = Boolean(settings?.inventory && (row.baselineRow !== null || invalidInventory));
  const afterInventory = skipped ? row.oldInventoryQty : row.newInventoryQty;
  const contenders = row.supplierContenders ?? [];
  const cancelEdit = useCallback(() => {
    onEdit(false);
    action.current?.focus();
  }, [onEdit]);
  useEffect(() => {
    if (!editing) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing ||
        action.current?.closest('[hidden]') || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      cancelEdit();
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [editing, cancelEdit]);
  return (
    <tr data-status={row.status} data-supplier-id={row.supplierId} data-supplier-row={supplierLine ?? undefined} data-baseline-row={row.baselineRow ?? undefined}>
      <th scope="row" className="line-cell">
        <code>{row.sku || 'No SKU'}</code>
        {row.bigcommerce ? <span className="price-row-detail">
          {row.bigcommerce.type === 'SKU' ? row.bigcommerce.name.split(/(?<=[=,])/).map((part, index) => (
            <Fragment key={index}>{index ? <wbr /> : null}{part}</Fragment>
          )) : row.bigcommerce.name}
        </span> : row.handle ? <span className="price-row-detail">{row.handle}</span> : null}
        {row.woocommerce ? <span className="price-row-detail">
          {row.woocommerce.type} · ID {row.woocommerce.id}{row.woocommerce.parent ? ` · Parent ${row.woocommerce.parent}` : ''}
        </span> : row.bigcommerce ? <span className="price-row-detail">{row.bigcommerce.type} · ID {row.bigcommerce.id}{row.bigcommerce.type === 'SKU' ? ` · Product ${row.bigcommerce.productId}` : ''}</span>
          : options ? <span className="price-row-detail">{options}</span> : null}
      </th>
      <td><code>{row.oldPrice ?? '—'}</code></td>
      {activeFormula ? (
        <>
          <td><code>{row.supplierPrice ?? '—'}</code></td>
          <td><code>{row.computedPrice ?? '—'}</code>
            {row.fxApplied ? <span className="price-row-detail">FX applied · {row.fxApplied.sourceCurrency} → {row.fxApplied.storeCurrency} @ {row.fxApplied.fxRate}</span> : null}
            {row.matchedTier ? <span className="price-row-detail">{row.matchedTier}</span> : null}
          </td>
        </>
      ) : null}
      <td data-cell-status={row.status === 'Updated' ? 'changed' : row.status === 'Blocked' ? 'review' : undefined}>
        <code>{(skipped ? row.oldPrice : row.newPrice ?? (activeFormula ? null : row.supplierPrice)) ?? '—'}</code>
        {activeFormula && manualPrice && !skipped && row.newPrice !== null ? <span className="price-row-detail">Manual override</span> : null}
        {watchlist ? (
          <dl className="price-row-values price-row-margin">
            <div><dt>Landed cost</dt><dd><code>{row.landedCost ?? 'Unknown'}</code></dd></div>
            <div><dt>Gross margin</dt><dd className="count-review"><code>{row.grossMarginPercent == null ? 'Unknown' : `${row.grossMarginPercent}%`}</code></dd></div>
          </dl>
        ) : null}
      </td>
      <td><code>{formatPriceChange(row.deltaPercent)}</code></td>
      <td>
        <span className={`issue-badge price-row-status ${row.status === 'Updated' ? 'badge-fixed' : row.status === 'Blocked' ? 'badge-review' : ''}`}>{row.status}</span>
        {showExportContext && row.status !== 'Updated' && row.priceOutput === 'value' ? <span className="price-row-detail">Included unchanged with product group</span> : null}
        {showExportContext && skipped && row.priceOutput === 'omitted' ? <span className="price-row-detail">Omitted from update CSV</span> : null}
      </td>
      {compareAt && watchlist ? (
        <td>
          <dl className="price-row-values">
            <div><dt>Before</dt><dd><code>{beforeSecondaryPrice}</code></dd></div>
            <div><dt>After</dt><dd data-cell-status={secondaryStatus}><code>{afterSecondaryPrice}</code></dd></div>
          </dl>
        </td>
      ) : null}
      {compareAt && !watchlist ? (
        <>
          <td><code>{beforeSecondaryPrice}</code></td>
          <td data-cell-status={secondaryStatus}><code>{afterSecondaryPrice}</code></td>
        </>
      ) : null}
      {inventory ? (
        <>
          <td><code>{row.oldInventoryQty ?? '—'}</code></td>
          <td data-cell-status={inventoryBlocked ? 'review' : row.status === 'Updated' && row.oldInventoryQty !== afterInventory ? 'changed' : undefined}>
            <code>{afterInventory ?? '—'}</code>
            {inventoryBlocked && row.supplierInventoryQty != null ? <span className="price-row-detail">Supplier {catalog ? 'stock' : 'qty'} {row.supplierInventoryQty}</span> : null}
          </td>
        </>
      ) : null}
      {showSource ? (
        <td className="price-row-source">
          {row.supplierSource ? <span className="issue-badge price-source-badge">{row.supplierSource}</span> : '—'}
          {row.supplierFilename && row.supplierFilename !== row.supplierSource ? <span className="price-row-detail">{row.supplierFilename}</span> : null}
          {row.supplierWorksheet && row.supplierWorksheet !== row.supplierSource && row.supplierWorksheet !== row.supplierFilename
            ? <span className="price-row-detail">{row.supplierWorksheet}</span> : null}
          {contenders.length > 1 ? (
            <>
              <span className="price-row-detail">{row.supplierSource
                ? invalidInventory ? 'Candidate needs inventory review'
                  : conflictPolicy === 'block-conflicts' ? 'Overlapping supplier rows' : CONFLICT_POLICIES[conflictPolicy]
                : 'Supplier overlap requires review'}</span>
              <ul className="price-source-contenders">
                {contenders.map((candidate) => (
                  <li key={`${candidate.supplierId}:${candidate.row}`}>
                    <strong>{candidate.label}</strong> · row {candidate.row}
                    {candidate.filename !== candidate.label || (candidate.worksheet && /\.xlsx$/i.test(candidate.filename))
                      ? <span>{candidate.filename}{candidate.worksheet && /\.xlsx$/i.test(candidate.filename) ? ` · ${candidate.worksheet}` : ''}</span> : null}
                    <span>Price <code>{candidate.price ?? '—'}</code>
                      {candidate.inventoryColumn ? <> · {catalog ? 'Stock' : 'Qty'} <code>{candidate.inventoryQty ?? '—'}</code></> : null}
                      {candidate.compareAtColumn ? <> · {catalog ? 'Sale price' : 'Compare-at'} <code>{candidate.compareAtPrice ?? '—'}</code></> : null}</span>
                  </li>
                ))}
              </ul>
              {policyTarget && !row.supplierSource ? <a className="price-row-detail" href={`#${policyTarget}`}>Choose conflict policy</a> : null}
            </>
          ) : null}
        </td>
      ) : null}
      <td className="price-row-lines">
        {row.baselineRow !== null ? <span>Baseline {row.baselineRow}</span> : null}
        {supplierLine !== null ? <span>Supplier {supplierLine}</span> : null}
      </td>
      <td className="price-row-review">
        {row.issues.length ? <ul className="price-row-issues" id={`${id}-issues`}>{row.issues.map(({ code, column, message }, index) => (
          <li key={`${code}:${column}:${index}`} className={code === 'compare-at-not-above-price' ? 'compare-at-block' : undefined}>{message}</li>
        ))}</ul> : null}
        {canSkip ? (
          <div className="price-row-actions" role="group" aria-label={`Review supplier row ${supplierLine}`}>
            <label className="checkbox-label"><input type="checkbox" checked={skipped} onChange={(event) => {
              const skip = event.currentTarget.checked;
              onEdit(false);
              onResolve(supplierId, supplierLine, { skip }, skip ? 'Skipped.' : 'Returned to review.');
            }} /><span>Skip row</span></label>
            {!skipped && (canEditPrice || canEditInventory) ? (
              <>
                <button ref={action} type="button" className="button button-secondary button-small" aria-expanded={editing}
                  aria-controls={editing ? `${id}-override` : undefined} onClick={() => onEdit(!editing)}>{canEditPrice ? 'Edit price' : `Edit ${quantity}`}</button>
                {canConfirm ? <button type="button" className="button button-secondary button-small" aria-describedby={`${id}-issues`} onClick={() => {
                  action.current?.focus();
                  onResolve(supplierId, supplierLine, { confirm: true }, 'Proposed values confirmed.');
                }}>{confirmation}</button> : null}
              </>
            ) : null}
          </div>
        ) : null}
        {editing && supplierLine !== null && settings ? <OverrideForm id={`${id}-override`} catalog={catalog} row={row} priceEditable={canEditPrice} settings={settings} onApply={(change) => {
          action.current?.focus();
          onEdit(false);
          onResolve(supplierId, supplierLine, { ...change, confirm: false }, 'Override applied.');
        }} onCancel={cancelEdit} /> : null}
      </td>
    </tr>
  );
}

function OverrideForm({ id, catalog, row, priceEditable, settings, onApply, onCancel }: {
  id: string;
  catalog: boolean;
  row: DiffRow;
  priceEditable: boolean;
  settings: RowSettings;
  onApply: (change: RowResolution) => void;
  onCancel: () => void;
}) {
  const { inventory, storeCurrency } = settings;
  const compareAt = priceEditable && settings.compareAt;
  const initialPrice = row.newPrice ?? '';
  const initialCompareAt = row.newCompareAtPrice ?? row.supplierCompareAtPrice ?? '';
  const initialInventory = row.newInventoryQty ?? row.supplierInventoryQty ?? '';
  return (
    <form id={id} className="price-override" onSubmit={(event) => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      const price = priceEditable ? String(fields.get('price')) : undefined;
      const compareAtPrice = compareAt ? String(fields.get('compareAt')) : undefined;
      const inventoryQty = inventory ? String(fields.get('inventoryQty')) : undefined;
      const change: RowResolution = {};
      if (price !== undefined && price !== initialPrice) change.price = price;
      if (compareAtPrice !== undefined && compareAtPrice !== initialCompareAt) change.compareAtPrice = compareAtPrice;
      if (inventoryQty !== undefined && inventoryQty !== initialInventory) change.inventoryQty = inventoryQty;
      if (Object.keys(change).length) onApply(change);
      else onCancel();
    }}>
      {priceEditable && storeCurrency ? <p className="field-help">Enter price overrides in {storeCurrency}.</p> : null}
      {priceEditable ? <label>{catalog ? 'Override regular price' : 'Override price'}<input name="price" inputMode="decimal" required autoFocus defaultValue={initialPrice} /></label> : null}
      {compareAt ? <label>{catalog ? 'Override sale price' : 'Override compare-at price'}<input name="compareAt" inputMode="decimal" defaultValue={initialCompareAt} /></label> : null}
      {inventory ? <label>{catalog ? 'Override stock' : 'Override inventory qty'}<input name="inventoryQty" inputMode="numeric" autoFocus={!priceEditable} defaultValue={initialInventory} /></label> : null}
      <div className="price-override-buttons">
        <button type="submit" className="button button-primary button-small">Apply override</button>
        <button type="button" className="button button-secondary button-small" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function nativePairReady(summary: DiffSummary | null) {
  return Boolean(summary?.canDownload && summary.rollbackVerification.checked);
}

function PriceExports({ platform, market, summary, busy, ready, policyPending, guard, inventory, onGuard, onDownload }: {
  platform: StorePlatform;
  market?: ShopifyMarket;
  summary: DiffSummary | null;
  busy: boolean;
  ready: boolean;
  policyPending: boolean;
  guard: boolean;
  inventory: boolean;
  onGuard: (guard: boolean) => void;
  onDownload: (format: PriceDownload) => void;
}) {
  const id = useId();
  const woo = platform === 'woocommerce';
  const label = STORE_PLATFORMS[platform];
  const canDownload = ready && !busy;
  const blocks = summary?.formulaGuard.blockedCount ?? 0;
  return (
    <div className="export-actions price-exports">
      <h3>Download the update, rollback, and audit</h3>
      {woo ? <>
        <p><strong>ID, Type, SKU, Parent preserved.</strong> Descriptions, Images, Meta omitted. Categories and tags are also omitted.</p>
        <p>Start with a fresh WooCommerce Products CSV export from the same store. In the built-in product importer, choose <strong>Update existing products</strong>.</p>
      </> : platform === 'bigcommerce' ? <>
        <p>Both files retain Item Type, Product ID, Product Name and Product Code/SKU. Descriptions, categories, images and metadata are omitted.</p>
        <p>For both files, use the legacy BigCommerce Bulk Edit importer and enable <strong>Ignore blank values</strong> so blank cells preserve existing values.</p>
      </> : market ? <p>Both files retain Shopify’s required Title, handles, SKUs and options. Complete product groups retain sibling variants’ original values for the selected market. Base and other market prices, descriptions, tags and images are omitted.</p>
        : <p>Shopify requires Title. The CSV retains the original Title, handles, SKUs, and options. Complete product groups include any unchanged or skipped sibling variants at their original prices. Descriptions, tags, and image columns are omitted.</p>}
      <p id={`${id}-rollback`}>{woo
        ? `The rollback CSV restores exact baseline regular prices and any mapped sale prices${inventory ? ' and stock quantities' : ''}.`
        : platform === 'bigcommerce' ? `The rollback CSV restores exact baseline values for changed prices, sale prices${inventory ? ' and stock quantities' : ''}.`
          : market ? <>The rollback CSV restores exact baseline values in <code>{market.priceHeader}</code>{market.compareAtHeader ? <> and any exported <code>{market.compareAtHeader}</code></> : null}.</>
            : `The rollback CSV restores exact baseline prices for affected product groups, including mapped or calculated compare-at prices${inventory ? ' and mapped inventory quantities' : ''}.`}
        {' '}Verification runs locally against this batch.</p>
      <FormulaGuard checked={guard} disabled={busy} onChange={onGuard}
        description={`Checks formula-like text and preserves signed amounts. A required ${label} field that would need escaping blocks the native update CSV. You can still download the protected audit CSV.`} />
      <p className="field-help" role="status">
        {summary
          ? `Audit preview · ${summary.formulaGuard.neutralizedCount.toLocaleString('en-US')} native CSV cells neutralized · ${blocks.toLocaleString('en-US')} native CSV cells require protection.`
          : 'Audit preview becomes available after comparison.'}
      </p>
      {summary?.verification.checked ? <p className="price-verification" data-testid="price-verification">Local CSV check · {summary.verification.nonTargetFieldsChanged} non-target fields changed · {summary.verification.brokenVariantGroups} variant groups broken.</p> : null}
      {ready && summary ? <p className="price-verification">Local rollback check · {summary.rollbackVerification.restoredVariants.toLocaleString('en-US')} {summary.rollbackVerification.restoredVariants === 1 ? 'variant restored' : 'variants restored'} to baseline.</p> : null}
      {!ready ? (
        <p className="export-warning" id={id}>
          {policyPending ? `Confirm the supplier conflict policy for this batch to enable both ${label} CSV downloads.`
            : blocks ? `Spreadsheet formula guard blocked the native ${label} update CSV to preserve the original fields. Download the guarded diff audit CSV to review the affected cells.`
            : summary?.status === 'no-changes' ? `There are no ${inventory ? 'price or inventory' : 'price'} changes to export. The full audit is available.`
              : summary ? 'Resolve blocking checks or skip individual flagged rows to enable the update CSV. The full audit is available.'
                : 'Confirm the supplier columns and pricing settings and finish comparison to enable downloads.'}
        </p>
      ) : null}
      <div className="export-buttons">
        <button type="button" className="button button-primary" disabled={!canDownload} aria-describedby={ready ? undefined : id} onClick={() => onDownload('price-csv')}>Download Safe {label} Update CSV</button>
        <button type="button" className="button button-secondary" disabled={!canDownload} aria-describedby={ready ? `${id}-rollback` : `${id}-rollback ${id}`} onClick={() => onDownload('price-rollback-csv')}>Download {label} Rollback CSV</button>
        <button type="button" className="button button-secondary" disabled={!summary || busy} onClick={() => onDownload('price-audit-csv')}>Download Full Diff Audit (.csv)</button>
        <button type="button" className="button button-secondary" disabled={!summary || busy} onClick={() => onDownload('price-audit-json')}>Download Full Diff Audit (.json)</button>
        <button type="button" className="button button-secondary" disabled={!summary || busy} onClick={() => onDownload('price-signoff-html')}>Download Client Sign-Off (.html)</button>
      </div>
      {summary ? <PriceFingerprints custody={summary.custody} ready={ready} /> : null}
    </div>
  );
}
