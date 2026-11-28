import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ColumnSelection, ColumnSuggestions, DiffIssue } from '../../core/shopify-price-diff/types';
import type { SupplierRecipe } from '../../core/shopify-price-diff/recipe';
import type { StorePlatform, WorkspaceProfile } from '../../core/shopify-price-diff/workspace-profile';
import type { ImportPlatform } from '../../core/verify-import/inspector';
import type { WorkbenchWorker } from '../../core/worker/client';
import type { BaselineMeta, BomMeta, SupplierMeta } from '../../core/worker/protocol';
import demoBaseline from '../../../fixtures/shopify-price-diff/baseline-agency.csv?raw';
import demoSupplier from '../../../fixtures/shopify-price-diff/supplier-agency.csv?raw';
import wooDemoBaseline from '../../../fixtures/woocommerce-price-diff/baseline.csv?raw';
import wooDemoSupplier from '../../../fixtures/woocommerce-price-diff/supplier.csv?raw';
import { BIGCOMMERCE_DEMO } from './bigCommerceDemo';
import { kitBomDemo, kitDemoBaselineName } from './kitBomDemo';
import { ModeNavigation } from './ModeNavigation';
import { PriceDiffIssues } from './PriceDiffIssues';
import { PriceFileInput } from './PriceFileInput';
import { recipeRemapping } from './supplierRecipe';
import type { MappingField } from './supplierRecipe';
import { TabBar } from './TabBar';
import { useWorkerSession, WorkerStatus } from './workerSession';
import { PRICE_UPDATE_PLATFORMS, withWorkspaceDefaults, WorkspaceProfileControls } from './WorkspaceProfile';

const PriceDiffReview = lazy(() => import('./PriceDiffReview').then(({ PriceDiffReview }) => ({ default: PriceDiffReview })));
const VerifyImportPanel = lazy(() => import('./VerifyImportPanel'));
const SaleCampaignWorkflow = lazy(() => import('./promo/SaleCampaignWorkflow'));
const SupplierDeltaPanel = lazy(() => import('./supplier-delta/SupplierDeltaPanel'));
const CatalogMigrationPanel = lazy(() => import('./catalog-migrator/CatalogMigrationPanel'));
const InventoryWorkflow = lazy(() => import('./inventory-sync/InventoryWorkflow'));
const AmazonPricePanel = lazy(() => import('./amazon/AmazonPricePanel'));

const STUDIO_MODES = [
  { id: 'build', label: 'Build Update' },
  { id: 'verify', label: 'Verify Update / Rollback CSV' },
  { id: 'campaign', label: 'Sale Campaign Pack' },
  { id: 'delta', label: 'Supplier Delta' },
  { id: 'migrate', label: 'Migrate Catalog' },
  { id: 'inventory-sync', label: 'Inventory Sync' },
] as const;

type StudioMode = typeof STUDIO_MODES[number]['id'];
type PairMode = 'build' | 'campaign';

const FILE_FIELDS = {
  baseline: {
    title: 'Shopify baseline export',
    formats: 'Drop a Shopify product CSV',
    label: 'Choose Shopify baseline CSV',
    accept: '.csv',
    extension: /\.csv$/i,
    invalid: 'Choose one Shopify baseline file with a .csv extension.',
  },
  supplier: {
    title: 'Supplier price sheet',
    formats: 'Drop a supplier CSV or XLSX',
    label: 'Choose supplier price sheet',
    accept: '.csv,.xlsx',
    extension: /\.(csv|xlsx)$/i,
    invalid: 'Choose one supplier file with a .csv or .xlsx extension.',
  },
};

const WOO_BASELINE_FIELD = {
  ...FILE_FIELDS.baseline,
  title: 'WooCommerce baseline export',
  formats: 'Drop a WooCommerce Products CSV export',
  label: 'Choose WooCommerce baseline CSV',
  invalid: 'Choose one WooCommerce baseline file with a .csv extension.',
};

const BIGCOMMERCE_BASELINE_FIELD = {
  ...FILE_FIELDS.baseline,
  title: 'BigCommerce baseline export',
  formats: 'Drop a legacy BigCommerce Bulk Edit CSV export',
  label: 'Choose BigCommerce baseline CSV',
  invalid: 'Choose one BigCommerce baseline file with a .csv extension.',
};

const BOM_FIELD = {
  title: 'Bundle BOM sheet',
  formats: 'Drop a Bundle BOM CSV or XLSX',
  label: 'Choose Bundle BOM sheet',
  accept: '.csv,.xlsx',
};

const DEMOS = {
  shopify: { label: 'Load Synthetic Agency Demo', baseline: demoBaseline, baselineName: 'baseline-agency.csv', supplier: demoSupplier, supplierName: 'supplier-agency.csv' },
  woocommerce: { label: 'Load Synthetic WooCommerce Demo', baseline: wooDemoBaseline, baselineName: 'woocommerce-baseline-synthetic.csv', supplier: wooDemoSupplier, supplierName: 'woocommerce-supplier-synthetic.csv' },
  bigcommerce: { ...BIGCOMMERCE_DEMO, label: 'Load Synthetic BigCommerce Demo' },
};

type FileSide = keyof typeof FILE_FIELDS;
type LocalFile = { file: File; synthetic: boolean };
type SupplierInput = { file?: LocalFile; recipeFile?: File; sheetChoice?: string; error?: string };
type LoadedSupplier = { file: File; sheetName: string | undefined; firstVisibleSheet?: true; meta: SupplierMeta };

export interface GeneratedPairSource {
  platform: ImportPlatform;
  market?: ShopMarket;
  baseline: File;
  load: () => Promise<{ update: File; rollback: File }>;
}

type ShopMarket = NonNullable<BaselineMeta['markets']>[number];

export interface PriceMapping {
  sheetIndex: number;
  sheetMissing: boolean;
  recipeBlocked: boolean;
  suggestions: ColumnSuggestions;
  selection: ColumnSelection;
  diagnostics: string[];
  missing: MappingField[];
  remapped: boolean;
}

interface RecipeLoad {
  recipe: SupplierRecipe | null;
  recipeErrors: string[];
}

interface PreparedSupplier extends RecipeLoad {
  supplier?: SupplierMeta;
  mapping?: PriceMapping;
}

export interface ReviewSource extends RecipeLoad {
  id: string;
  label: string;
  labelOverride?: string;
  filename: string;
  worksheet?: string;
  mapping: PriceMapping;
  headers: readonly string[];
  issues: readonly DiffIssue[];
}

export interface MappingDraft {
  selection: ColumnSelection;
  remapped: boolean;
  unresolved: readonly MappingField[];
}

export type MappingDrafts = Readonly<Record<string, MappingDraft>>;

interface PreparedFiles {
  baseline?: BaselineMeta;
  bom?: BomMeta;
  suppliers: Readonly<Record<string, PreparedSupplier>>;
}

const PRIMARY = 'primary';
const EMPTY_RECIPE: RecipeLoad = { recipe: null, recipeErrors: [] };
const sourceLabel = (filename: string) => filename.slice(0, 120);
const worksheetNames = (supplier: SupplierMeta) => supplier.sheetNames ?? supplier.sheets.map(({ name }) => name);

export function PriceDiffWorkbench({ characterKeys }: { characterKeys: boolean }) {
  const heading = useId();
  const [mode, setMode] = useState<StudioMode>('build');
  const [verifyVisited, setVerifyVisited] = useState(false);
  const [hygieneSelected, setHygieneSelected] = useState(false);
  const [campaignVisited, setCampaignVisited] = useState(false);
  const [deltaVisited, setDeltaVisited] = useState(false);
  const [migrationVisited, setMigrationVisited] = useState(false);
  const [inventoryVisited, setInventoryVisited] = useState(false);
  const [pairMode, setPairMode] = useState<PairMode>('build');
  const [buildPair, setBuildPair] = useState<GeneratedPairSource | null>(null);
  const [campaignPair, setCampaignPair] = useState<GeneratedPairSource | null>(null);
  const [buildPlatform, setBuildPlatform] = useState<ImportPlatform>('shopify');
  const [amazonBatchStarted, setAmazonBatchStarted] = useState(false);
  const [marketName, setMarketName] = useState<string>();
  const [targetChanged, setTargetChanged] = useState(false);
  const [pendingPlatform, setPendingPlatform] = useState<ImportPlatform | null>(null);
  const platformControls = useRef<HTMLDivElement>(null);
  const [profile, setProfile] = useState<WorkspaceProfile | null>(null);
  const [profileRevision, setProfileRevision] = useState(0);
  const [baselineFile, setBaselineFile] = useState<LocalFile>();
  const [baselineError, setBaselineError] = useState('');
  const [bomFile, setBomFile] = useState<LocalFile>();
  const [bomError, setBomError] = useState('');
  const [bomOpen, setBomOpen] = useState(false);
  const bomDisclosure = useRef<HTMLDetailsElement>(null);
  const [supplierInputs, setSupplierInputs] = useState<Record<string, SupplierInput>>({ [PRIMARY]: {} });
  const [order, setOrder] = useState<string[]>([PRIMARY]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<MappingDrafts>({});
  const nextSupplier = useRef(2);
  const [validWorker, setValidWorker] = useState(false);
  const loaded = useRef<{ worker: WorkbenchWorker; baseline?: BaselineMeta; bom?: BomMeta; suppliers: Map<string, LoadedSupplier> } | null>(null);
  const imported = useRef(new WeakMap<File, RecipeLoad>());
  const session = useWorkerSession();
  const { run, invalidate, reset, cancel, resume, paused, progress, error, finished } = session;
  const inputs = useMemo(() => ({ baselineFile, bomFile, bomError, supplierInputs }), [baselineFile, bomFile, bomError, supplierInputs]);
  const [prepared, setPrepared] = useState<{ data: PreparedFiles; inputs: typeof inputs; worker: WorkbenchWorker } | null>(null);
  const active = prepared?.inputs === inputs ? prepared.data : null;
  const busy = Boolean(progress) || paused;
  const multiple = order.length > 1;
  const amazon = buildPlatform === 'amazon';
  const platform: StorePlatform = buildPlatform === 'amazon' ? 'shopify' : buildPlatform;
  const platformLabel = PRICE_UPDATE_PLATFORMS[buildPlatform];
  const woo = platform === 'woocommerce';
  const bigCommerce = platform === 'bigcommerce';
  const usingKitDemo = baselineFile?.synthetic && baselineFile.file.name === kitDemoBaselineName(platform);
  const baselineField = woo ? WOO_BASELINE_FIELD : bigCommerce ? BIGCOMMERCE_BASELINE_FIELD : FILE_FIELDS.baseline;
  const markets = active?.baseline?.markets;
  const market = markets?.find(({ name }) => name === marketName);

  useEffect(() => {
    const { baselineFile, bomFile, supplierInputs } = inputs;
    const entries = Object.entries(supplierInputs);
    if (paused || (!baselineFile && !bomFile && !entries.some(([, { file, recipeFile }]) => file || recipeFile))) return;
    void run(async ({ worker, progress: update, isCurrent }): Promise<PreparedFiles> => {
      if (loaded.current?.worker !== worker) {
        const [baseline, bom] = await Promise.all([
          baselineFile ? worker.request({ type: 'loadBaseline', file: baselineFile.file, platform }, update) : undefined,
          bomFile ? worker.request({ type: 'loadBom', file: bomFile.file }, update) : undefined,
        ]);
        if (!isCurrent()) throw new Error('The price files changed.');
        loaded.current = { worker, baseline, bom, suppliers: new Map() };
      }
      const { baseline, bom, suppliers } = loaded.current;
      const details = await Promise.all(entries.map(async ([supplierId, { file, sheetChoice, recipeFile }]): Promise<[string, PreparedSupplier]> => {
        let recipeLoad = recipeFile ? imported.current.get(recipeFile) : undefined;
        if (recipeFile && !recipeLoad) {
          const response = await worker.request({ type: 'loadRecipe', file: recipeFile }, update);
          recipeLoad = response.ok
            ? { recipe: response.value, recipeErrors: [] }
            : { recipe: null, recipeErrors: response.diagnostics.map(({ message }) => message) };
          imported.current.set(recipeFile, recipeLoad);
        }
        const recipeDetails = recipeLoad ?? EMPTY_RECIPE;
        const { recipe, recipeErrors } = recipeDetails;
        const recipeWorksheet = recipe?.version === 6 ? recipe.selectedSheet : undefined;
        // Older recipes addressed the original indexed worksheet list.
        const firstVisibleSheet = recipe && recipe.version !== 6 && recipe.sheetName !== null && sheetChoice === undefined ? undefined : true;
        let supplier: SupplierMeta | undefined;
        if (file) {
          const cached = suppliers.get(supplierId);
          const previous = cached?.file === file.file ? cached : undefined;
          let requested = sheetChoice ?? (previous && recipeWorksheet && worksheetNames(previous.meta).includes(recipeWorksheet) ? recipeWorksheet : undefined);
          if (previous && previous.sheetName === requested && previous.firstVisibleSheet === firstVisibleSheet) {
            supplier = previous.meta;
          } else {
            suppliers.delete(supplierId);
            if (!isCurrent()) throw new Error('The supplier worksheet changed.');
            supplier = await worker.request({ type: 'loadSupplier', supplierId, file: file.file, sheetName: requested, firstVisibleSheet }, update);
            if (!isCurrent()) throw new Error('The supplier worksheet changed.');
            // A recipe can be loaded before the workbook. Discover the names before requesting its exact sheet.
            if (requested === undefined && recipeWorksheet && worksheetNames(supplier).includes(recipeWorksheet)) {
              requested = recipeWorksheet;
              supplier = await worker.request({ type: 'loadSupplier', supplierId, file: file.file, sheetName: requested }, update);
              if (!isCurrent()) throw new Error('The supplier worksheet changed.');
            }
            suppliers.set(supplierId, { file: file.file, sheetName: requested, firstVisibleSheet, meta: supplier });
          }
        }
        if (!baseline || !supplier?.sheets.length || supplier.issues.some(({ blocking }) => blocking)) {
          return [supplierId, { supplier, ...recipeDetails }];
        }
        const applied = recipe ? await worker.request({
          type: 'applyRecipe',
          supplierId,
          sheetIndex: 0,
          recipe: sheetChoice === undefined ? recipe : recipe.version === 6
            ? { ...recipe, sheetName: sheetChoice, selectedSheet: sheetChoice }
            : { ...recipe, sheetName: null },
        }) : null;
        if (!isCurrent()) throw new Error('The supplier worksheet changed.');
        if (applied?.ok && applied.value.supplier && file) {
          supplier = applied.value.supplier;
          suppliers.set(supplierId, { file: file.file, sheetName: supplier.selectedSheet, firstVisibleSheet, meta: supplier });
        }
        const sheetIndex = applied?.ok ? applied.value.sheetIndex : Math.max(0, supplier.sheets.findIndex(({ name }) => name === recipe?.sheetName));
        const diagnostics = applied && !applied.ok ? applied.diagnostics : [];
        const sheetMissing = diagnostics.some(({ field }) => field === 'sheetName');
        const recipeBlocked = diagnostics.some(({ code }) => code === 'unsafe-supplier-sheet' || code === 'unsupported-woo-recipe' || code === 'unsupported-bigcommerce-recipe');
        const remapped = Boolean(recipe?.sheetName && sheetChoice !== undefined && supplier.sheets[sheetIndex].name !== recipe.sheetName);
        const suggestions = await worker.request({ type: 'priceSettings', supplierId, sheetIndex });
        const recovery = recipe && applied && !applied.ok && !recipeBlocked ? recipeRemapping(recipe, supplier.sheets[sheetIndex].headers) : null;
        const selection = applied?.ok ? applied.value.selection : recovery?.selection ?? {
          ...suggestions.selection,
          joinKey: baseline.hasSku && suggestions.skuColumns.length > 0 && suggestions.handleColumns.length > 0 &&
            suggestions.optionColumns[0].length > 0 ? undefined : suggestions.selection.joinKey,
          skuColumn: suggestions.skuColumns.length === 1 ? suggestions.skuColumns[0] : undefined,
          handleColumn: suggestions.handleColumns.length === 1 ? suggestions.handleColumns[0] : undefined,
          optionColumns: suggestions.optionColumns.map((columns) => columns.length === 1 ? columns[0] : null),
          priceColumn: suggestions.priceColumns.length === 1 ? suggestions.priceColumns[0] : undefined,
          confirmed: !suggestions.requiresConfirmation && recipeErrors.length === 0,
        };
        return [supplierId, {
          supplier, ...recipeDetails,
          mapping: {
            sheetIndex, sheetMissing, recipeBlocked, suggestions, selection, remapped,
            diagnostics: diagnostics.map(({ message }) => message),
            missing: recovery?.missing ?? [],
          },
        }];
      }));
      return { baseline, bom, suppliers: Object.fromEntries(details) };
    }, (data, worker) => {
      setPrepared((previous) => ({ data: previous?.inputs === inputs ? previous.data : data, inputs, worker }));
      setValidWorker(true);
    }, baselineFile || bomFile || entries.some(([, { file }]) => file) ? 'reading' : 'parsing');
  }, [inputs, paused, platform, run]);

  function clearPriceReport(reloadFiles: boolean, duringRead = false) {
    setBuildPair(null);
    if (reloadFiles) {
      reset();
      setValidWorker(false);
      loaded.current = null;
      setPrepared(null);
      return;
    }
    // A label or order change is applied when the pending file read completes.
    // Invalidating the shared session during that read would discard its result.
    if ((!active && !duringRead) || !validWorker) return;
    invalidate();
    void prepared?.worker.request({ type: 'invalidatePrice' }).catch(() => undefined);
  }

  function updateSupplier(id: string, change: Partial<SupplierInput>, reloadFile: boolean) {
    clearPriceReport(reloadFile, true);
    setDrafts(({ [id]: removed, ...remaining }) => remaining);
    setSupplierInputs((previous) => ({ ...previous, [id]: { ...previous[id], ...change } }));
  }

  function replaceBaseline(file: LocalFile | undefined) {
    clearPriceReport(true);
    setDrafts({});
    setMarketName(undefined);
    setTargetChanged(false);
    setBaselineFile(file);
  }

  function load(side: FileSide, choices: FileList, supplierId?: string) {
    if (!choices.length) return;
    const file = choices[0];
    const field = side === 'baseline' ? baselineField : FILE_FIELDS.supplier;
    const correct = choices.length === 1 && field.extension.test(file.name);
    const next = correct ? { file, synthetic: false } : undefined;
    const error = correct ? '' : field.invalid;
    if (supplierId) {
      setLabels(({ [supplierId]: removed, ...remaining }) => remaining);
      updateSupplier(supplierId, { file: next, sheetChoice: undefined, error }, true);
    } else {
      setBaselineError(error);
      replaceBaseline(next);
    }
  }

  function replaceBom(file: LocalFile | undefined, error = '') {
    clearPriceReport(true);
    setBomFile(file);
    setBomError(error);
  }

  function loadBom(choices: FileList) {
    if (!choices.length) return;
    const file = choices[0];
    if (choices.length !== 1 || !FILE_FIELDS.supplier.extension.test(file.name)) {
      replaceBom(undefined, 'Choose one Bundle BOM file with a .csv or .xlsx extension.');
      return;
    }
    replaceBom({ file, synthetic: false });
  }

  function resetBatch() {
    clearPriceReport(true);
    setDrafts({});
    setMarketName(undefined);
    setTargetChanged(false);
    setBaselineError('');
    setBomFile(undefined);
    setBomError('');
    if (bomDisclosure.current) bomDisclosure.current.open = false;
    setLabels({});
    setOrder([PRIMARY]);
  }

  function switchPlatform(next: ImportPlatform) {
    resetBatch();
    setBaselineFile(undefined);
    setSupplierInputs({ [PRIMARY]: {} });
    setProfile(null);
    setAmazonBatchStarted(false);
    setPendingPlatform(null);
    setBuildPlatform(next);
    platformControls.current?.querySelector<HTMLButtonElement>(`[data-platform="${next}"]`)?.focus({ preventScroll: true });
  }

  function choosePlatform(next: ImportPlatform) {
    if (buildPlatform === next) setPendingPlatform(null);
    else if (amazonBatchStarted || baselineFile || bomFile || bomError || profile || Object.values(supplierInputs).some(({ file, recipeFile }) => file || recipeFile)) setPendingPlatform(next);
    else switchPlatform(next);
  }

  function loadDemo() {
    resetBatch();
    const demo = DEMOS[platform];
    setBaselineFile({ file: new File([demo.baseline], demo.baselineName, { type: 'text/csv' }), synthetic: true });
    setSupplierInputs({
      [PRIMARY]: { file: { file: new File([demo.supplier], demo.supplierName, { type: 'text/csv' }), synthetic: true } },
    });
  }

  function loadKitDemo() {
    resetBatch();
    const demo = kitBomDemo(platform);
    setBaselineFile(demo.baseline);
    setSupplierInputs({ [PRIMARY]: { file: demo.supplier } });
    setBomFile(demo.bom);
    setDrafts({
      [PRIMARY]: {
        remapped: false,
        unresolved: [],
        selection: {
          joinKey: 'sku',
          skuColumn: 0,
          priceColumn: 1,
          confirmed: true,
          pricingRule: { mode: 'multiplier', multiplier: '2' },
        },
      },
    });
    if (bomDisclosure.current) bomDisclosure.current.open = true;
  }

  function addSupplier() {
    if (order.length >= 3) return;
    clearPriceReport(false);
    const id = `supplier-${nextSupplier.current++}`;
    setSupplierInputs((previous) => ({ ...previous, [id]: {} }));
    setOrder((previous) => [...previous, id]);
  }

  function moveSupplier(index: number, direction: -1 | 1) {
    clearPriceReport(false);
    setOrder((previous) => {
      const next = [...previous];
      [next[index], next[index + direction]] = [next[index + direction], next[index]];
      return next;
    });
  }

  function clearSupplier(id: string) {
    setLabels(({ [id]: removed, ...remaining }) => remaining);
    if (multiple) {
      clearPriceReport(true);
      setDrafts(({ [id]: removed, ...remaining }) => remaining);
      setSupplierInputs(({ [id]: removed, ...remaining }) => remaining);
      setOrder((previous) => previous.filter((supplierId) => supplierId !== id));
      document.getElementById(heading)?.focus({ preventScroll: true });
    } else {
      updateSupplier(id, { file: undefined, sheetChoice: undefined, error: undefined }, true);
    }
  }

  const reviewSources = useMemo((): ReviewSource[] | null => {
    if (!active) return null;
    const sources: ReviewSource[] = [];
    for (const id of order) {
      const { supplier, mapping, recipe, recipeErrors } = active.suppliers[id];
      if (!supplier || !mapping) return null;
      const { name, headers, issues } = supplier.sheets[mapping.sheetIndex];
      const labelOverride = labels[id]?.trim() || undefined;
      const defaults = profile && !recipe ? { ...mapping, selection: withWorkspaceDefaults(mapping.selection, profile) } : mapping;
      sources.push({ id, label: labelOverride ?? sourceLabel(supplier.name), labelOverride,
        filename: supplier.name, worksheet: /\.xlsx$/i.test(supplier.name) && !mapping.sheetMissing ? name : undefined,
        mapping: defaults, headers, issues, recipe, recipeErrors });
    }
    return sources;
  }, [active, labels, order, profile]);

  function applyProfile(value: WorkspaceProfile) {
    clearPriceReport(false);
    setDrafts((previous) => Object.fromEntries(Object.entries(previous).map(([id, draft]) => [id,
      supplierInputs[id]?.recipeFile ? draft : { ...draft, selection: withWorkspaceDefaults(draft.selection, value) },
    ])));
    setProfile(value);
    setProfileRevision((revision) => revision + 1);
  }

  const profileSelection = drafts[order[0]]?.selection ?? reviewSources?.[0].mapping.selection;
  const targetSelector = markets?.length ? (
    <div className="price-target">
      <div className="price-sheet">
        <label htmlFor={`${heading}-target`}>Target price list</label>
        <select id={`${heading}-target`} value={market?.name ?? ''} aria-describedby={`${heading}-target-help`}
          onChange={(event) => {
            const name = event.currentTarget.value || undefined;
            clearPriceReport(false);
            setTargetChanged(true);
            setMarketName(name);
            setDrafts((previous) => Object.fromEntries(Object.entries(previous).map(([id, draft]) => [id, {
              ...draft, selection: { ...draft.selection, confirmed: false, sameCurrencyConfirmed: false, fxRateConfirmed: false },
            }])));
          }}>
          <option value="">Base store (Variant Price)</option>
          {markets.map(({ name, priceHeader }) => <option key={name} value={name}>{priceHeader}</option>)}
        </select>
      </div>
      <p id={`${heading}-target-help`} className="field-help">
        {market ? <>Only <code>{market.priceHeader}</code>{market.compareAtHeader ? <> and <code>{market.compareAtHeader}</code></> : null} can change. Use this market’s currency and confirm your columns again.</>
          : 'Choose which Shopify price list to update.'}
      </p>
    </div>
  ) : null;

  function changeMode(next: StudioMode) {
    setMode(next);
    if (next === 'verify') setVerifyVisited(true);
    if (next === 'build' || next === 'campaign') setPairMode(next);
    if (next === 'campaign') setCampaignVisited(true);
    if (next === 'delta') setDeltaVisited(true);
    if (next === 'migrate') setMigrationVisited(true);
    if (next === 'inventory-sync') setInventoryVisited(true);
  }

  function openCampaignVerification() {
    setHygieneSelected(false);
    changeMode('verify');
    document.getElementById(`${heading}-verify-tab`)?.focus({ preventScroll: true });
  }

  const pairSource = pairMode === 'campaign' ? campaignPair : buildPair;
  const workbenchLabel = {
    build: `${platformLabel} Safe Price Update workbench`, verify: 'Verify Before Import workbench', campaign: 'Sale Campaign Pack workbench',
    delta: 'Supplier Delta workbench', migrate: 'Catalog migration workbench',
    'inventory-sync': 'Inventory Sync workbench',
  }[mode];

  return (
    <section className="workbench price-workbench" aria-label={workbenchLabel}>
      <div className="workbench-input price-studio-top">
        <ModeNavigation current="price" />
        <TabBar id={heading} label="Price Update Studio mode" items={STUDIO_MODES} active={mode} className="price-studio-tabs"
          onChange={changeMode} />
      </div>
      <div id={`${heading}-build-panel`} role="tabpanel" aria-labelledby={`${heading}-build-tab`} hidden={mode !== 'build'}>
        <div className="workbench-input price-studio-pane">
          <div className="price-section price-build-platform">
            <div className="price-store-platform">
              <span id={`${heading}-platform`}>Store platform</span>
              <div className="price-platform-toggle" role="group" aria-labelledby={`${heading}-platform`} ref={platformControls}>
                {(Object.keys(PRICE_UPDATE_PLATFORMS) as ImportPlatform[]).map((option) => (
                  <button key={option} type="button" data-platform={option} aria-pressed={buildPlatform === option}
                    onClick={() => choosePlatform(option)}>{PRICE_UPDATE_PLATFORMS[option]}</button>
                ))}
              </div>
            </div>
            {pendingPlatform ? <div className="price-platform-confirm">
              <p className="field-help" role="status">Switching to {PRICE_UPDATE_PLATFORMS[pendingPlatform]} clears {amazon ? 'this Amazon batch' : 'this batch and its workspace settings'}.</p>
              <button type="button" className="button button-secondary button-small" onClick={() => switchPlatform(pendingPlatform)}>Switch to {PRICE_UPDATE_PLATFORMS[pendingPlatform]}</button>
              <button type="button" className="text-button" onClick={() => {
                platformControls.current?.querySelector<HTMLButtonElement>(`[data-platform="${buildPlatform}"]`)?.focus({ preventScroll: true });
                setPendingPlatform(null);
              }}>Keep this batch</button>
            </div> : null}
          </div>
          {amazon ? (
            <Suspense fallback={<p className="price-section price-build-files" role="status">Opening Amazon Price &amp; Quantity…</p>}>
              <AmazonPricePanel onBatchStarted={setAmazonBatchStarted} onPairAvailable={setBuildPair} />
            </Suspense>
          ) : null}
          {!amazon ? <div className="price-section price-build-files">
            <div className="price-heading">
              <div>
                <h2 id={heading} tabIndex={-1}>{multiple ? `Add your ${platformLabel} baseline and supplier sheets` : 'Add your two price files'}</h2>
                <p className="field-help">{multiple
                  ? 'Add up to three supplier sheets. The order applies when you prefer the first or last supplier. Files stay in this browser.'
                  : `Use a current ${platformLabel} product export and a supplier price sheet. Both files stay in this browser.`}</p>
              </div>
              <button type="button" className="button button-secondary" onClick={loadDemo}>{DEMOS[platform].label}</button>
            </div>
            {woo && !usingKitDemo && baselineFile?.synthetic && supplierInputs[PRIMARY]?.file?.synthetic ? <p className="field-help">
              For the synthetic cost sheet, select Tiered cost brackets before confirming the columns. You can also map Sale price and Stock.
            </p> : null}
            {bigCommerce && !usingKitDemo && baselineFile?.synthetic && supplierInputs[PRIMARY]?.file?.synthetic ? <p className="field-help">
              Optionally map Sale Price and Stock. The standalone mug has price, sale and stock changes. The shirt SKU has a stock-only change.
            </p> : null}
            {bigCommerce ? <p className="field-help catalog-import-note">Legacy Bulk Edit supports pricing for standalone products. For product groups with SKU rows, this studio supports tracked stock updates and holds pricing changes. SKU Price is read-only and SKU rows have no editable Sale Price.</p> : null}
            <div className="price-files" data-multiple={multiple} role="group" aria-labelledby={heading}>
              <PriceFileInput side="baseline" field={baselineField} file={baselineFile}
                message={{ reading: Boolean(progress && baselineFile && !active), error: baselineError }}
                onLoad={(choices) => load('baseline', choices)} onClear={() => { setBaselineError(''); replaceBaseline(undefined); }} />
              <div className="price-supplier-area">
                <ol className="price-supplier-stack" aria-label="Supplier sheet order" role="list">
                  {order.map((supplierId, index) => {
                    const { file, sheetChoice, error } = supplierInputs[supplierId];
                    const previous = prepared?.inputs.supplierInputs[supplierId]?.file === file
                      ? prepared?.data.suppliers[supplierId]?.supplier : undefined;
                    const { supplier = previous, mapping, recipe, recipeErrors } = active?.suppliers[supplierId] ?? {};
                    const position = index + 1;
                    const names = supplier ? worksheetNames(supplier) : [];
                    const selectedName = sheetChoice ?? supplier?.sheets[mapping?.sheetIndex ?? 0]?.name;
                    const sheet = supplier?.sheets.find(({ name }) => name === selectedName);
                    const worksheetLabel = multiple ? `Supplier worksheet ${position}` : 'Supplier worksheet';
                    const worksheet = names.length > 1 || mapping?.sheetMissing || sheetChoice !== undefined ? (
                      <label className="price-sheet">{worksheetLabel}
                        <select aria-label={worksheetLabel} value={mapping?.sheetMissing ? '' : selectedName ?? ''} onChange={(event) => {
                          updateSupplier(supplierId, { sheetChoice: event.currentTarget.value }, false);
                        }}>
                          {mapping?.sheetMissing ? <option value="" disabled>Choose replacement worksheet</option> : null}
                          {names.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                      </label>
                    ) : undefined;
                    return (
                      <li key={supplierId}>
                        <PriceFileInput side="supplier" field={FILE_FIELDS.supplier} position={multiple ? position : undefined} file={file}
                          message={{ reading: Boolean(progress && file && !active), error }}
                          onLoad={(choices) => load('supplier', choices, supplierId)}
                          onClear={multiple ? undefined : () => clearSupplier(supplierId)} worksheet={worksheet}>
                          {sheet ? (
                            <p className="price-source-count field-help">{sheet.rowCount.toLocaleString('en-US')} {sheet.rowCount === 1 ? 'row' : 'rows'} in selected sheet</p>
                          ) : null}
                          {file && (multiple || labels[supplierId] !== undefined) ? (
                            <label className="price-supplier-label">Supplier sheet label{multiple ? ` ${position}` : ''}
                              <input type="text" value={labels[supplierId] ?? sourceLabel(file.file.name)} maxLength={120} onChange={(event) => {
                                const label = event.currentTarget.value;
                                clearPriceReport(false);
                                setLabels((previous) => ({ ...previous, [supplierId]: label }));
                              }} />
                            </label>
                          ) : null}
                          {multiple ? (
                            <div className="price-supplier-actions">
                              <button type="button" className="text-button" aria-label={`Move supplier sheet ${position} up`}
                                disabled={index === 0} onClick={() => moveSupplier(index, -1)}>Move up</button>
                              <button type="button" className="text-button" aria-label={`Move supplier sheet ${position} down`}
                                disabled={index === order.length - 1} onClick={() => moveSupplier(index, 1)}>Move down</button>
                              <button type="button" className="text-button" aria-label={`Remove supplier sheet ${position}`}
                                onClick={() => clearSupplier(supplierId)}>Remove</button>
                            </div>
                          ) : null}
                          <PriceDiffIssues issues={supplier?.issues ?? []} title="Supplier file checks" />
                          {!reviewSources && (recipe || recipeErrors?.length) ? (
                            <div className="recipe-retained">
                              {recipe ? <p className="field-help" role="status">Recipe loaded: {recipe.supplierLabel}. Add the price files to check the saved mapping.</p> : null}
                              {recipeErrors?.map((message) => <p key={message} role="alert">{message}</p>)}
                              <button type="button" className="text-button" disabled={busy}
                                onClick={() => updateSupplier(supplierId, { recipeFile: undefined, sheetChoice: undefined }, false)}>Use manual mapping</button>
                            </div>
                          ) : null}
                        </PriceFileInput>
                      </li>
                    );
                  })}
                </ol>
                <button type="button" className="button button-secondary button-small" disabled={order.length >= 3}
                  onClick={addSupplier}>+ Add another supplier sheet</button>
                <div className="bom-entry">
                  <details className="bom-input" ref={bomDisclosure} onToggle={(event) => setBomOpen(event.currentTarget.open)}>
                    <summary>Bundle BOM sheet (optional){bomFile ? <span className="bom-attached" aria-hidden="true">Attached</span> : null}</summary>
                    {bomOpen ? (
                      <>
                        <p className="field-help">Required columns are Bundle SKU, Component SKU, and Quantity. Assembly Cost is optional. XLSX needs one visible worksheet.</p>
                        <PriceFileInput side="bom" field={BOM_FIELD} showTitle={false} file={bomFile}
                          message={{ reading: Boolean(progress && bomFile && !active), error: bomError }}
                          onLoad={loadBom} onClear={() => replaceBom(undefined)} clearLabel="Remove Bundle BOM sheet">
                          {active?.bom ? <p className="field-help">
                            {active.bom.worksheet ? <>Worksheet <strong>{active.bom.worksheet}</strong> · </> : null}
                            {active.bom.rowCount.toLocaleString('en-US')} {active.bom.rowCount === 1 ? 'BOM row' : 'BOM rows'}
                          </p> : null}
                          {!reviewSources ? <PriceDiffIssues issues={active?.bom?.issues ?? []} title="Bundle BOM file checks" /> : null}
                          {bomError ? <button className="text-button" type="button" onClick={() => replaceBom(undefined)}>Clear BOM selection</button> : null}
                        </PriceFileInput>
                      </>
                    ) : null}
                  </details>
                  <button type="button" className="text-button" onClick={loadKitDemo}>Load Synthetic Kit BOM Demo</button>
                </div>
              </div>
            </div>
            <WorkerStatus progress={progress} paused={paused} finished={finished} error={error} focusHeading={heading} onCancel={() => {
              setValidWorker(false);
              cancel();
            }} onResume={resume} />
            {!reviewSources ? <PriceDiffIssues issues={active?.baseline?.issues ?? []} title="Baseline file checks" /> : null}
            {!reviewSources ? targetSelector : null}
            <WorkspaceProfileControls key={platform} platform={platform} profile={profile} selection={profileSelection} onApply={applyProfile} />
          </div> : null}
        </div>
        {!amazon && reviewSources ? (
          <Suspense fallback={<p role="status">Opening price review…</p>}>
            <PriceDiffReview key={profileRevision} platform={platform} workspaceCurrency={profile?.storeCurrency} session={session} worker={validWorker && !paused && !bomError ? prepared?.worker ?? null : null}
              sources={reviewSources} baselineIssues={active?.baseline?.issues ?? []} drafts={drafts} setDrafts={setDrafts}
              baselineFile={baselineFile?.file} bom={active?.bom} onPairAvailable={setBuildPair} characterKeys={characterKeys}
              market={market} targetChanged={targetChanged} targetSelector={targetSelector} active={mode === 'build'}
              onRecipe={(supplierId, file) => updateSupplier(supplierId, { recipeFile: file ?? undefined, sheetChoice: undefined }, false)} />
          </Suspense>
        ) : null}
      </div>
      <div id={`${heading}-verify-panel`} role="tabpanel" aria-labelledby={`${heading}-verify-tab`}
        className="workbench-input price-studio-pane" hidden={mode !== 'verify'}>
        {verifyVisited ? (
          <Suspense fallback={<p className="price-section" role="status">Opening CSV verification…</p>}>
            <VerifyImportPanel pairSource={pairSource} buildPlatform={buildPlatform} active={mode === 'verify'}
              hygieneSelected={hygieneSelected} onViewChange={setHygieneSelected} />
          </Suspense>
        ) : null}
      </div>
      <div id={`${heading}-campaign-panel`} role="tabpanel" aria-labelledby={`${heading}-campaign-tab`}
        className="workbench-input price-studio-pane" hidden={mode !== 'campaign'}>
        {campaignVisited ? (
          <Suspense fallback={<p className="price-section" role="status">Opening Sale Campaign Pack…</p>}>
            <SaleCampaignWorkflow active={mode === 'campaign'} initialPlatform={platform} onPairAvailable={setCampaignPair} onVerify={openCampaignVerification} />
          </Suspense>
        ) : null}
      </div>
      <div id={`${heading}-delta-panel`} role="tabpanel" aria-labelledby={`${heading}-delta-tab`}
        className="workbench-input price-studio-pane" hidden={mode !== 'delta'}>
        {deltaVisited ? (
          <Suspense fallback={<p className="price-section" role="status">Opening Supplier Delta…</p>}>
            <SupplierDeltaPanel active={mode === 'delta'} />
          </Suspense>
        ) : null}
      </div>
      <div id={`${heading}-migrate-panel`} role="tabpanel" aria-labelledby={`${heading}-migrate-tab`}
        className="workbench-input price-studio-pane" hidden={mode !== 'migrate'}>
        {migrationVisited ? (
          <Suspense fallback={<p className="price-section" role="status">Opening Catalog Migration…</p>}>
            <CatalogMigrationPanel active={mode === 'migrate'} />
          </Suspense>
        ) : null}
      </div>
      <div id={`${heading}-inventory-sync-panel`} role="tabpanel" aria-labelledby={`${heading}-inventory-sync-tab`}
        className="workbench-input price-studio-pane" hidden={mode !== 'inventory-sync'}>
        {inventoryVisited ? (
          <Suspense fallback={<p className="price-section" role="status">Opening Inventory Sync…</p>}>
            <InventoryWorkflow active={mode === 'inventory-sync'} characterKeys={characterKeys} />
          </Suspense>
        ) : null}
      </div>
    </section>
  );
}
