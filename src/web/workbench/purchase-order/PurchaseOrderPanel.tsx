import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { purchaseOrderPolicies } from '../../../core/purchase-order/types';
import type { PurchaseOrderInventoryInspection, PurchaseOrderPolicy, PurchaseOrderSupplierInspection } from '../../../core/purchase-order/types';
import { PriceFileInput } from '../PriceFileInput';
import { useSignoffBranding } from '../SignoffBranding';
import { downloadFile } from '../downloads';
import { PurchaseOrderResults } from './PurchaseOrderResults';
import { purchaseOrderDemo } from './demo';
import { PurchaseOrderWorker } from './purchaseOrderWorker';
import type { PurchaseOrderArtifact, PurchaseOrderJob, PurchaseOrderReport } from './purchaseOrderWorker';
import './purchase-order.css';

const INVENTORY_FIELD = {
  title: 'Store inventory', formats: 'Drop an inventory CSV with SKU and Available or On hand', label: 'Choose Inventory CSV', accept: '.csv',
};
const SUPPLIER_FIELD = {
  title: 'Supplier catalog', formats: 'Drop a supplier CSV or XLSX with SKU and Unit Cost', label: 'Choose supplier catalog', accept: '.csv,.xlsx',
};
const POLICY_LABELS: Record<PurchaseOrderPolicy, string> = {
  'lowest-landed-cost': 'Lowest PO subtotal',
  'prefer-first': 'Prefer first listed supplier',
  'block-ties': 'Hold on lowest-cost ties',
};
const DEFAULTS = [
  { name: 'reorderPoint', label: 'Reorder Point' },
  { name: 'targetStock', label: 'Target Stock' },
] as const;
const EMPTY_LOCATIONS: readonly string[] = [];
const INITIAL_SETTINGS = { reorderPoint: '', targetStock: '', poReference: '', policy: 'lowest-landed-cost' as PurchaseOrderPolicy };

type LocalFile = { file: File; synthetic?: boolean };
type SupplierSelection = { input: LocalFile; sheetName?: string };
interface InventorySlot {
  input?: LocalFile;
  inspection?: PurchaseOrderInventoryInspection;
  error?: string;
}
interface SupplierSlot {
  id: number;
  label: string;
  selection?: SupplierSelection;
  sheetNames?: string[];
  inspection?: PurchaseOrderSupplierInspection;
  error?: string;
}
type Run = { job: PurchaseOrderJob; id: number } & (
  { worker: PurchaseOrderWorker; report: PurchaseOrderReport; error?: never } | { report?: never; error: string }
);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The local purchase order operation could not finish.';
}

export default function PurchaseOrderPanel({ active }: { active: boolean }) {
  const id = useId();
  const { branding } = useSignoffBranding();
  const workerRef = useRef<PurchaseOrderWorker | null>(null);
  const getWorker = useCallback(() => workerRef.current ??= new PurchaseOrderWorker(), []);
  const revision = useRef(0);
  const lastSupplierId = useRef(1);
  const supplierFiles = useRef<HTMLDivElement>(null);
  const focusSupplier = useRef<number | undefined>(undefined);
  const [inventory, setInventory] = useState<InventorySlot>({});
  const [suppliers, setSuppliers] = useState<SupplierSlot[]>([{ id: 1, label: '' }]);
  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const [location, setLocation] = useState('');
  const [checked, setChecked] = useState<Run>();
  const [saveStatus, setSaveStatus] = useState<{ id: number; error?: string }>();
  const locations = inventory.inspection?.locations ?? EMPTY_LOCATIONS;
  const targetLocation = location || (locations.length === 1 ? locations[0] : '');

  const job = useMemo<PurchaseOrderJob | null>(() => {
    if (!active || !inventory.input || !inventory.inspection) return null;
    const sources: PurchaseOrderJob['suppliers'] = [];
    for (const { selection, label, inspection } of suppliers) {
      if (!selection || !inspection) return null;
      sources.push({ file: selection.input.file, sheetName: selection.sheetName, label });
    }
    return {
      inventory: inventory.input.file, suppliers: sources,
      options: {
        targetLocation: targetLocation || undefined, branding, policy: settings.policy,
        reorderPoint: settings.reorderPoint || undefined, targetStock: settings.targetStock || undefined,
        poReference: settings.poReference || undefined,
      },
    };
  }, [active, inventory, suppliers, settings, targetLocation, branding]);

  const current = checked?.job === job ? checked : undefined;
  const result = current?.report;
  const currentSave = saveStatus?.id === current?.id ? saveStatus : undefined;
  const saving = Boolean(currentSave && !currentSave.error);
  const ready = result?.status === 'ready';
  const missingLocation = locations.length > 1 && !targetLocation;
  const missingWorksheet = suppliers.some(({ sheetNames, selection }) => sheetNames?.length && !selection?.sheetName);
  const fileError = Boolean(inventory.error || suppliers.some(({ error }) => error));
  const held = Boolean(missingLocation || missingWorksheet || fileError || current?.error || result?.status === 'blocked');
  const reading = (inventory.input && !inventory.inspection && !inventory.error)
    || suppliers.some(({ selection, inspection, error }) => selection && !inspection && !error);

  useEffect(() => () => {
    revision.current += 1;
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  useEffect(() => {
    const index = focusSupplier.current;
    if (index === undefined) return;
    focusSupplier.current = undefined;
    supplierFiles.current?.querySelectorAll<HTMLInputElement>('input[type="file"]')[index]?.focus();
  }, [suppliers.length]);

  useEffect(() => {
    if (!job) return;
    const runId = ++revision.current;
    const plan = async () => {
      try {
        const worker = getWorker();
        const report = await worker.request({ type: 'build', runId, job });
        if (runId === revision.current) setChecked({ job, id: runId, worker, report });
      } catch (error) {
        if (runId === revision.current) setChecked({ job, id: runId, error: errorText(error) });
      }
    };
    const timer = window.setTimeout(() => void plan(), 100);
    return () => {
      window.clearTimeout(timer);
      if (runId === revision.current) revision.current += 1;
    };
  }, [job, getWorker]);

  function invalidate() {
    revision.current += 1;
    setChecked(undefined);
    setSaveStatus(undefined);
    void workerRef.current?.request({ type: 'clear' }).catch(() => undefined);
  }

  async function inspectInventory(input?: LocalFile, error?: string) {
    setInventory({ input, error });
    if (!input) return;
    try {
      const inspection = await getWorker().request({ type: 'inspectInventory', file: input.file });
      setInventory((slot) => slot.input === input ? { input, inspection } : slot);
    } catch (cause) {
      setInventory((slot) => slot.input === input ? { input, error: errorText(cause) } : slot);
    }
  }

  function replaceInventory(input?: LocalFile, error?: string) {
    invalidate();
    setLocation('');
    void inspectInventory(input, error);
  }

  function updateSupplier(supplierId: number, update: (slot: SupplierSlot) => SupplierSlot) {
    setSuppliers((slots) => slots.map((slot) => slot.id === supplierId ? update(slot) : slot));
  }

  async function inspectSupplier(supplierId: number, selection: SupplierSelection) {
    try {
      const inspection = await getWorker().request({ type: 'inspectSupplier', file: selection.input.file, sheetName: selection.sheetName });
      updateSupplier(supplierId, (slot) => slot.selection === selection ? { ...slot, inspection, sheetNames: inspection.sheetNames } : slot);
    } catch (cause) {
      updateSupplier(supplierId, (slot) => slot.selection === selection ? { ...slot, error: errorText(cause) } : slot);
    }
  }

  function replaceSupplier(supplierId: number, input?: LocalFile, sheetName?: string, error?: string) {
    invalidate();
    const selection = input ? { input, sheetName } : undefined;
    updateSupplier(supplierId, (slot) => ({
      id: supplierId, selection, error,
      label: input && input === slot.selection?.input ? slot.label : input?.file.name.replace(/\.(csv|xlsx)$/i, '') ?? '',
      sheetNames: input === slot.selection?.input ? slot.sheetNames : undefined,
    }));
    if (selection) void inspectSupplier(supplierId, selection);
  }

  function loadDemo() {
    const demo = purchaseOrderDemo();
    invalidate();
    setLocation(demo.targetLocation);
    setSettings({ reorderPoint: demo.reorderPoint, targetStock: demo.targetStock, poReference: demo.poReference, policy: 'lowest-landed-cost' });
    const slots = demo.suppliers.map((file) => ({
      id: ++lastSupplierId.current, label: file.name.slice(0, -4), selection: { input: { file, synthetic: true } },
    }));
    setSuppliers(slots);
    void inspectInventory({ file: demo.inventory, synthetic: true });
    for (const slot of slots) void inspectSupplier(slot.id, slot.selection);
  }

  async function save(artifact: PurchaseOrderArtifact) {
    if (!current?.report || saving || (!ready && artifact !== 'audit')) return;
    const { id: runId, worker } = current;
    setSaveStatus({ id: runId });
    try {
      const { filename, bytes, mime } = await worker.request({ type: 'download', runId, artifact });
      if (revision.current !== runId) return;
      downloadFile(filename, bytes, mime);
      setSaveStatus(undefined);
    } catch (error) {
      if (revision.current === runId) setSaveStatus({ id: runId, error: errorText(error) });
    }
  }

  let status = 'Add an inventory CSV and one to three supplier catalogs.';
  if (reading) status = 'Reading local purchase order files…';
  else if (fileError) status = 'Purchase orders held. Check the file messages.';
  else if (missingLocation) status = 'Purchase orders held. Choose a Target Location.';
  else if (missingWorksheet) status = 'Purchase orders held. Choose a visible worksheet for each workbook.';
  else if (current?.error) status = 'Purchase order planning stopped.';
  else if (ready) status = result.summary.supplierCount ? 'Purchase order pack ready for review.' : 'No purchase order lines to send. Review the summary and audit.';
  else if (held) status = 'Purchase orders held for review.';
  else if (job) status = 'Planning purchases in this browser…';

  return (
    <div className="price-section purchase-order">
      <header className="price-heading">
        <div>
          <h2>Plan reorder purchase orders</h2>
          <p className="field-help">Plan replenishment from inventory and supplier pack sizes. Files stay in this browser.</p>
        </div>
        <button type="button" className="button button-secondary inventory-demo" onClick={loadDemo}>Load Synthetic Multi-Supplier PO Demo</button>
      </header>
      <div className="price-files inventory-files" role="group" aria-label="Purchase order source files">
        <PriceFileInput side="po-inventory" field={INVENTORY_FIELD} inputTestId="po-inventory-file" file={inventory.input}
          clearLabel="Clear Inventory CSV" message={{ reading: Boolean(inventory.input && !inventory.inspection && !inventory.error), error: inventory.error }}
          onLoad={(files) => {
            if (!files.length) return;
            if (files.length === 1 && /\.csv$/i.test(files[0].name)) replaceInventory({ file: files[0] });
            else replaceInventory(undefined, 'Choose one inventory file with a .csv extension.');
          }} onClear={() => replaceInventory()} />
        <div className="inventory-suppliers" ref={supplierFiles}>
          {suppliers.map(({ id: supplierId, label, selection, sheetNames, inspection, error }, index) => {
            const position = index + 1;
            const worksheet = sheetNames?.length && selection ? (
              <label className="price-sheet">Supplier {position} worksheet
                <select value={selection.sheetName ?? ''} onChange={(event) =>
                  replaceSupplier(supplierId, selection.input, event.currentTarget.value || undefined)}>
                  <option value="">Choose a visible worksheet</option>
                  {sheetNames.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
            ) : undefined;
            return (
              <PriceFileInput key={supplierId} side="po-supplier" position={position} field={SUPPLIER_FIELD} inputTestId={`po-supplier-file-${position}`}
                file={selection?.input} worksheet={worksheet} message={{ reading: Boolean(selection && !inspection && !error), error }}
                clearLabel={`Clear supplier catalog${position > 1 ? ` ${position}` : ''}`} onClear={() => replaceSupplier(supplierId)}
                onLoad={(files) => {
                  if (!files.length) return;
                  if (files.length === 1 && /\.(csv|xlsx)$/i.test(files[0].name)) replaceSupplier(supplierId, { file: files[0] });
                  else replaceSupplier(supplierId, undefined, undefined, 'Choose one supplier catalog with a .csv or .xlsx extension.');
                }}>
                {selection ? (
                  <label className="price-supplier-label">Supplier {position} name
                    <input value={label} maxLength={120} onChange={(event) => {
                      const label = event.currentTarget.value;
                      invalidate();
                      updateSupplier(supplierId, (slot) => ({ ...slot, label }));
                    }} />
                  </label>
                ) : null}
                {index > 0 ? <button type="button" className="text-button inventory-remove" onClick={() => {
                  invalidate();
                  focusSupplier.current = index - 1;
                  setSuppliers((slots) => slots.filter(({ id }) => id !== supplierId));
                }}>Remove supplier catalog {position}</button> : null}
              </PriceFileInput>
            );
          })}
          {suppliers.length < 3 ? (
            <button type="button" className="button button-secondary button-small inventory-add" onClick={() => {
              invalidate();
              focusSupplier.current = suppliers.length;
              const supplierId = ++lastSupplierId.current;
              setSuppliers((slots) => [...slots, { id: supplierId, label: '' }]);
            }}>+ Add another supplier catalog</button>
          ) : null}
        </div>
      </div>
      <fieldset className="inventory-settings po-settings">
        <legend>Replenishment settings</legend>
        <div className="price-fields pricing-fields">
          <label className="po-wide">Target Location
            <select value={targetLocation} disabled={!locations.length} onChange={(event) => {
              invalidate();
              setLocation(event.currentTarget.value);
            }}>
              <option value="" disabled={locations.length === 1}>{locations.length ? 'Choose a location'
                : inventory.inspection ? 'No location in inventory' : 'Add an inventory CSV first'}</option>
              {locations.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          {DEFAULTS.map(({ name, label }) => (
            <label key={name}>{label}
              <input type="text" inputMode="numeric" value={settings[name]} aria-describedby={`${id}-defaults`}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  invalidate();
                  setSettings((previous) => ({ ...previous, [name]: value }));
                }} />
            </label>
          ))}
          <label className="po-wide">Supplier Policy
            <select value={settings.policy} aria-describedby={`${id}-policy`} onChange={(event) => {
              const policy = event.currentTarget.value as PurchaseOrderPolicy;
              invalidate();
              setSettings((previous) => ({ ...previous, policy }));
            }}>
              {purchaseOrderPolicies.map((policy) => <option key={policy} value={policy}>{POLICY_LABELS[policy]}</option>)}
            </select>
          </label>
          <label className="po-wide">PO Reference
            <input type="text" value={settings.poReference} maxLength={120} placeholder="Optional" onChange={(event) => {
              const poReference = event.currentTarget.value;
              invalidate();
              setSettings((previous) => ({ ...previous, poReference }));
            }} />
          </label>
        </div>
        <p className="field-help" id={`${id}-defaults`}>A SKU’s reorder point and target override these defaults. Reorder starts at or below the point.</p>
        <p className="field-help" id={`${id}-policy`}>Lowest subtotal includes minimum order quantities and case packs. Equal lowest totals hold the order unless you choose supplier list order.</p>
      </fieldset>
      <section className="inventory-review" aria-label="Purchase order review">
        <h3>Review purchase orders</h3>
        <p className="delta-state" role="status" data-testid="purchase-order-status" data-ready={ready} data-held={held}>{status}</p>
        {current?.error ? <p className="file-message file-error" role="alert">{current.error}</p> : null}
        {current?.report ? (
          <PurchaseOrderResults key={current.id} runId={current.id} worker={current.worker} result={current.report}
            labels={current.job.suppliers.map(({ label }) => label)} saving={saving} onDownload={(artifact) => void save(artifact)} />
        ) : null}
        {currentSave?.error ? <p className="file-message file-error" role="alert">{currentSave.error}</p> : null}
      </section>
    </div>
  );
}
