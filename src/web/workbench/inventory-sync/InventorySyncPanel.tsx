import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { InventoryBaselineInspection, InventoryMapping, InventorySupplierInspection } from '../../../core/inventory-sync/types';
import { LocalCliCommand, encodeCliText, exampleSheetPath } from '../LocalCliCommand';
import { PriceFileInput } from '../PriceFileInput';
import { useSignoffBranding } from '../SignoffBranding';
import { downloadFile } from '../downloads';
import { InventoryDiagnostics, InventoryResults } from './InventoryResults';
import { inventoryDemo } from './demo';
import { InventoryWorker } from './inventoryWorker';
import type { InventoryArtifact, InventoryJob, InventorySummary } from './inventoryWorker';
import './inventory.css';

const BASELINE_FIELD = {
  title: 'Shopify inventory export', formats: 'Drop a Shopify Inventory CSV', label: 'Choose Shopify Inventory CSV', accept: '.csv',
};
const SUPPLIER_FIELD = {
  title: 'Supplier stock sheet', formats: 'Drop a supplier CSV or XLSX', label: 'Choose supplier stock sheet', accept: '.csv,.xlsx',
};
const DOWNLOADS = [
  { artifact: 'update', label: 'Inventory Update CSV', native: true },
  { artifact: 'rollback', label: 'Inventory Rollback CSV', native: true },
  { artifact: 'audit', label: 'Inventory Audit JSON', native: false },
  { artifact: 'signoff', label: 'Inventory Sign-Off (.html)', native: false },
] as const;
const SETTINGS = [
  { field: 'reserveUnits', label: 'Safety reserve units' },
  { field: 'zeroOutThreshold', label: 'Zero-out threshold' },
  { field: 'maxCap', label: 'Max cap (optional)' },
] as const;
const MAPPINGS = [
  { field: 'skuColumn', label: 'SKU column' },
  { field: 'quantityColumn', label: 'quantity column' },
] as const;

type LocalFile = { file: File; synthetic?: boolean };
interface BaselineSlot {
  input?: LocalFile;
  inspection?: InventoryBaselineInspection;
  error?: string;
}
interface SupplierSlot {
  id: number;
  selection?: { input: LocalFile; sheetName?: string };
  sheetNames?: string[];
  inspection?: InventorySupplierInspection;
  mapping?: Partial<InventoryMapping>;
  error?: string;
}
type RunReport = { job: InventoryJob; id: number } & (
  { worker: InventoryWorker; summary: InventorySummary; error?: never } | { summary?: never; error: string }
);
const EMPTY_SETTINGS = { reserveUnits: '0', zeroOutThreshold: '0', maxCap: '' };
const EMPTY_LOCATIONS: readonly string[] = [];

function completeMapping(mapping?: Partial<InventoryMapping>): InventoryMapping | undefined {
  const { skuColumn, quantityColumn } = mapping ?? {};
  return skuColumn != null && quantityColumn != null ? { skuColumn, quantityColumn } : undefined;
}

function wholeUnits(value: string) {
  const number = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(number) ? number : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The local inventory operation could not finish.';
}

export default function InventorySyncPanel({ characterKeys }: { characterKeys: boolean }) {
  const id = useId();
  const { branding } = useSignoffBranding();
  const workerRef = useRef<InventoryWorker | null>(null);
  const getWorker = useCallback(() => workerRef.current ??= new InventoryWorker(), []);
  const revision = useRef(0);
  const lastSupplierId = useRef(1);
  const [baseline, setBaseline] = useState<BaselineSlot>({});
  const [suppliers, setSuppliers] = useState<SupplierSlot[]>([{ id: 1 }]);
  const [settings, setSettings] = useState(EMPTY_SETTINGS);
  const [location, setLocation] = useState('');
  const [approval, setApproval] = useState(false);
  const [approvalCount, setApprovalCount] = useState(0);
  const [checked, setChecked] = useState<RunReport>();
  const [saveStatus, setSaveStatus] = useState<{ id: number; error?: string }>();
  const locations = baseline.inspection?.locations ?? EMPTY_LOCATIONS;
  const targetLocation = location || (locations.length === 1 ? locations[0] : '');
  const options = useMemo(() => {
    const reserveUnits = wholeUnits(settings.reserveUnits);
    const zeroOutThreshold = wholeUnits(settings.zeroOutThreshold);
    const maxCap = wholeUnits(settings.maxCap);
    return reserveUnits === undefined || zeroOutThreshold === undefined || (settings.maxCap !== '' && maxCap === undefined)
      ? null : { reserveUnits, zeroOutThreshold, maxCap };
  }, [settings]);

  const job = useMemo<InventoryJob | null>(() => {
    if (!baseline.input || !baseline.inspection || !options) return null;
    const sources: InventoryJob['suppliers'] = [];
    for (const slot of suppliers) {
      if (!slot.selection || !slot.inspection) return null;
      const { input, sheetName } = slot.selection;
      const mapping = completeMapping(slot.mapping);
      if ((!sheetName && slot.inspection.sheetNames.length) || (slot.inspection.headers.length && !mapping)) return null;
      sources.push({ file: input.file, sheetName, mapping });
    }
    return {
      baseline: baseline.input.file, suppliers: sources,
      options: { ...options, targetLocation: targetLocation || undefined, approveLargeDrop: approval, brand: branding },
    };
  }, [baseline, suppliers, options, targetLocation, approval, branding]);

  const current = checked?.job === job ? checked : undefined;
  const result = current?.summary;
  const currentSave = saveStatus && saveStatus.id === current?.id ? saveStatus : undefined;
  const saving = Boolean(currentSave && !currentSave.error);
  const ready = Boolean(result?.status === 'ready' && targetLocation);
  const held = (!targetLocation && locations.length > 1) || !options || result?.status === 'blocked';
  const reading = (baseline.input && !baseline.inspection && !baseline.error)
    || suppliers.some(({ selection, inspection, error }) => selection && !inspection && !error);

  useEffect(() => () => {
    revision.current += 1;
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  useEffect(() => {
    if (!job) return;
    const comparisonId = ++revision.current;
    const finish = async () => {
      try {
        const worker = getWorker();
        const summary = await worker.request({ type: 'build', comparisonId, job });
        if (comparisonId !== revision.current) return;
        if (!job.options.approveLargeDrop) setApprovalCount(summary.approvalCount);
        setChecked({ job, id: comparisonId, worker, summary });
      } catch (error) {
        if (comparisonId === revision.current) setChecked({ job, id: comparisonId, error: errorText(error) });
      }
    };
    // Coalesce edits to numeric settings before reading and comparing the files again.
    const timer = window.setTimeout(() => void finish(), 100);
    return () => {
      window.clearTimeout(timer);
      if (comparisonId === revision.current) revision.current += 1;
    };
  }, [job, getWorker]);

  function invalidate(resetApproval = true) {
    revision.current += 1;
    setChecked(undefined);
    setSaveStatus(undefined);
    void workerRef.current?.request({ type: 'clear' }).catch(() => undefined);
    if (resetApproval) {
      setApproval(false);
      setApprovalCount(0);
    }
  }

  async function replaceBaseline(input?: LocalFile, error?: string) {
    invalidate();
    setLocation('');
    setBaseline({ input, error });
    if (!input) return;
    try {
      const inspection = await getWorker().request({ type: 'inspectBaseline', file: input.file });
      setBaseline((current) => current.input === input ? { input, inspection } : current);
    } catch (cause) {
      setBaseline((current) => current.input === input ? { input, error: errorText(cause) } : current);
    }
  }

  function setSupplier(supplierId: number, update: (slot: SupplierSlot) => SupplierSlot) {
    setSuppliers((current) => current.map((slot) => slot.id === supplierId ? update(slot) : slot));
  }

  async function replaceSupplier(supplierId: number, input?: LocalFile, sheetName?: string, mapping?: InventoryMapping, error?: string) {
    invalidate();
    const selection = input ? { input, sheetName } : undefined;
    setSupplier(supplierId, (slot) => ({
      id: supplierId, selection, error, sheetNames: input === slot.selection?.input ? slot.sheetNames : undefined,
    }));
    if (!selection) return;
    try {
      const inspection = await getWorker().request({ type: 'inspectSupplier', file: selection.input.file, sheetName });
      setSupplier(supplierId, (slot) => slot.selection === selection ? { ...slot, inspection, sheetNames: inspection.sheetNames, mapping } : slot);
    } catch (cause) {
      setSupplier(supplierId, (slot) => slot.selection === selection ? { ...slot, error: errorText(cause) } : slot);
    }
  }

  function loadDemo() {
    const demo = inventoryDemo();
    const supplierId = ++lastSupplierId.current;
    setSettings(demo.settings);
    setSuppliers([{ id: supplierId }]);
    void replaceBaseline({ file: demo.baseline, synthetic: true });
    void replaceSupplier(supplierId, { file: demo.supplier, synthetic: true }, undefined, demo.mapping);
  }

  async function save(artifact: InventoryArtifact) {
    if (!current?.summary || saving || ((artifact === 'update' || artifact === 'rollback') && !ready)) return;
    const { id, worker } = current;
    setSaveStatus({ id });
    try {
      const { filename, bytes, mime } = await worker.request({ type: 'download', comparisonId: id, artifact });
      if (revision.current !== id) return;
      downloadFile(filename, bytes, mime);
      setSaveStatus(undefined);
    } catch (error) {
      if (revision.current === id) setSaveStatus({ id, error: errorText(error) });
    }
  }

  function getCliArguments() {
    if (!job || !targetLocation) return null;
    const args = ['--baseline', 'inventory.csv'];
    for (const [index, { file, sheetName, mapping }] of job.suppliers.entries()) {
      if (!mapping || (file.name.toLowerCase().endsWith('.xlsx') && !sheetName)) return null;
      args.push('--supplier', exampleSheetPath(`supplier-${index + 1}`, file.name));
      if (sheetName) args.push('--sheet-b64', encodeCliText(sheetName));
      args.push('--sku-column', String(mapping.skuColumn + 1), '--quantity-column', String(mapping.quantityColumn + 1));
    }
    args.push('--target-location-b64', encodeCliText(targetLocation), '--reserve-units', String(job.options.reserveUnits),
      '--zero-out-threshold', String(job.options.zeroOutThreshold));
    if (job.options.maxCap !== undefined) args.push('--max-cap', String(job.options.maxCap));
    return args;
  }

  let status = 'Add a Shopify inventory CSV and at least one supplier stock sheet.';
  if (reading) status = 'Reading local inventory files…';
  else if (locations.length > 1 && !targetLocation) status = 'Inventory CSVs held. Choose a Target Location.';
  else if (!options) status = 'Inventory CSVs held. Enter whole, nonnegative units.';
  else if (current?.error) status = 'Inventory comparison stopped.';
  else if (baseline.error || suppliers.some(({ error }) => error)) status = 'Inventory CSVs held. Check the file messages.';
  else if (ready) status = 'Inventory update and rollback ready for review.';
  else if (result?.status === 'no-changes') status = 'No inventory changes at this location.';
  else if (result?.status === 'blocked') status = 'Inventory CSVs held for review.';
  else if (job) status = 'Comparing inventory in this browser…';
  else if (baseline.inspection && suppliers.every(({ selection }) => selection)) status = 'Choose each supplier worksheet and map its SKU and quantity columns.';

  return (
    <div className="price-section inventory-sync">
      <header className="price-heading">
        <div>
          <h2>Sync inventory at one Shopify location</h2>
          <p className="field-help">Apply a safety buffer to supplier stock before updating Shopify. Files stay in this browser.</p>
        </div>
        <button className="button button-secondary inventory-demo" type="button" onClick={loadDemo}>Load Synthetic Multi-Location Demo</button>
      </header>
      <div className="price-files inventory-files" role="group" aria-label="Inventory sync files">
        <PriceFileInput side="inventory-baseline" field={BASELINE_FIELD} file={baseline.input} clearLabel="Clear Shopify Inventory CSV"
          message={{ reading: Boolean(baseline.input && !baseline.inspection && !baseline.error), error: baseline.error }}
          onLoad={(files) => {
            if (!files.length) return;
            if (files.length === 1 && /\.csv$/i.test(files[0].name)) void replaceBaseline({ file: files[0] });
            else void replaceBaseline(undefined, 'Choose one Shopify inventory file with a .csv extension.');
          }} onClear={() => void replaceBaseline()}>
          {!result && baseline.inspection?.issues.length ? <InventoryDiagnostics issues={baseline.inspection.issues} /> : null}
        </PriceFileInput>
        <div className="inventory-suppliers">
          {suppliers.map((slot, index) => {
            const position = index + 1;
            const label = `Supplier ${position}`;
            const { id: supplierId, selection, sheetNames, inspection, mapping, error } = slot;
            const prefix = `${id}-supplier-${supplierId}`;
            const worksheet = sheetNames?.length && selection ? (
              <div className="price-sheet">
                <label htmlFor={`${prefix}-sheet`}>{label} worksheet</label>
                <select id={`${prefix}-sheet`} value={selection.sheetName ?? ''} onChange={(event) =>
                  void replaceSupplier(supplierId, selection.input, event.currentTarget.value || undefined)}>
                  <option value="">Choose a visible worksheet</option>
                  {sheetNames.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
            ) : undefined;
            const sourceIssues = inspection?.issues.filter(({ code }) => code !== 'supplier-worksheet-required');
            return (
              <div key={supplierId} className="inventory-supplier-slot">
                <PriceFileInput side="inventory-supplier" position={position} field={SUPPLIER_FIELD} file={selection?.input} worksheet={worksheet}
                  message={{ reading: Boolean(selection && !inspection && !error), error }} clearLabel={`Clear supplier stock sheet${position > 1 ? ` ${position}` : ''}`}
                  onLoad={(files) => {
                    if (!files.length) return;
                    if (files.length === 1 && /\.(csv|xlsx)$/i.test(files[0].name)) void replaceSupplier(supplierId, { file: files[0] });
                    else void replaceSupplier(supplierId, undefined, undefined, undefined, 'Choose one supplier sheet with a .csv or .xlsx extension.');
                  }} onClear={() => void replaceSupplier(supplierId)}>
                  {inspection?.headers.length ? (
                    <fieldset className="price-fields inventory-mapping" aria-label={`${label} column mapping`}>
                      {MAPPINGS.map(({ field, label: role }) => (
                        <div key={field}>
                          <label htmlFor={`${prefix}-${field}`}>{label} {role}</label>
                          <select id={`${prefix}-${field}`} value={mapping?.[field] ?? ''} onChange={(event) => {
                            const value = event.currentTarget.value;
                            invalidate();
                            setSupplier(supplierId, (current) => ({
                              ...current, mapping: { ...current.mapping, [field]: value === '' ? undefined : Number(value) },
                            }));
                          }}>
                            <option value="">Choose a column</option>
                            {inspection.headers.map((header, column) => (
                              <option key={column} value={column}>{header || 'Unnamed column'} · column {column + 1}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </fieldset>
                  ) : null}
                  {!result && sourceIssues?.length ? <InventoryDiagnostics issues={sourceIssues} sourceLabel={label} /> : null}
                  {index > 0 ? <button type="button" className="text-button inventory-remove" onClick={() => {
                    invalidate();
                    setSuppliers((current) => current.filter(({ id }) => id !== supplierId));
                  }}>Remove supplier stock sheet {position}</button> : null}
                </PriceFileInput>
              </div>
            );
          })}
          {suppliers.length < 3 ? (
            <button type="button" className="button button-secondary button-small inventory-add" onClick={() => {
              invalidate();
              const supplierId = ++lastSupplierId.current;
              setSuppliers((current) => [...current, { id: supplierId }]);
            }}>+ Add another supplier sheet</button>
          ) : null}
        </div>
      </div>
      <fieldset className="inventory-settings">
        <legend>Location and safety buffer</legend>
        <div className="price-fields pricing-fields">
          <div>
            <label htmlFor={`${id}-location`}>Target Location</label>
            <select id={`${id}-location`} value={targetLocation} disabled={!locations.length} onChange={(event) => {
              invalidate();
              setLocation(event.currentTarget.value);
            }}>
              <option value="" disabled={locations.length === 1}>{locations.length ? 'Choose a location' : 'Add an inventory CSV first'}</option>
              {locations.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          {SETTINGS.map(({ field, label }) => (
            <div key={field}>
              <label htmlFor={`${id}-${field}`}>{label}</label>
              <input type="text" inputMode="numeric" id={`${id}-${field}`} value={settings[field]}
                aria-invalid={(field !== 'maxCap' || settings[field] !== '') && wholeUnits(settings[field]) === undefined || undefined}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  invalidate();
                  setSettings((current) => ({ ...current, [field]: value }));
                }} />
            </div>
          ))}
        </div>
        <p className="field-help">Supplier stock at or below the threshold goes to zero. Other rows subtract the reserve, then apply the cap if set.</p>
      </fieldset>
      <section className="inventory-review" aria-label="Inventory sync review">
        <h3>Review inventory changes</h3>
        <p className="delta-state" role="status" data-testid="inventory-sync-status" data-ready={ready} data-held={held}>{status}</p>
        {current?.error ? <p className="file-message file-error" role="alert">{current.error}</p> : null}
        {approvalCount ? (
          <div className="inventory-approval">
            <p id={`${id}-approval-help`}>{approval ? 'Stock drop approval applies to the current inputs and settings.'
              : <>{approvalCount.toLocaleString('en-US')} {approvalCount === 1 ? 'row would' : 'rows would'} lose more than 80% of their on-hand stock. Check the affected lines below before approving.</>}</p>
            <label className="checkbox-label">
              <input type="checkbox" checked={approval} aria-describedby={`${id}-approval-help`} onChange={(event) => {
                invalidate(false);
                setApproval(event.currentTarget.checked);
              }} />
              <span>Approve stock drops over 80% for this run</span>
            </label>
          </div>
        ) : null}
        {current?.summary ? (
          <InventoryResults key={current.id} id={current.id} worker={current.worker} summary={current.summary} characterKeys={characterKeys} />
        ) : null}
        <div className="export-buttons" role="group" aria-label="Inventory reports">
          {DOWNLOADS.map(({ artifact, label, native }) => (
            <button key={artifact} type="button" className={`button ${artifact === 'update' ? 'button-primary' : 'button-secondary'}`}
              disabled={!result || saving || (native && !ready)} onClick={() => void save(artifact)}>{label}</button>
          ))}
        </div>
        {result ? (
          <p className="field-help">{ready ? 'Review the update and keep the paired rollback before manually importing the update into Shopify.'
            : 'The audit and sign-off record this review. Inventory CSVs are available after a safe run with changes.'}</p>
        ) : null}
        {currentSave?.error ? <p className="file-message file-error" role="alert">{currentSave.error}</p> : null}
      </section>
      <LocalCliCommand mode="inventory-sync" getArguments={getCliArguments}
        unavailable="Choose a target location, valid settings, and each supplier mapping to prepare a command." />
    </div>
  );
}
