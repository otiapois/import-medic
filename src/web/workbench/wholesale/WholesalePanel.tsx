import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { SignoffBrand } from '../../../core/branding/signoff-brand';
import type { StorePlatform } from '../../../core/shopify-price-diff/workspace-profile';
import { downloadFile } from '../downloads';
import { useSignoffBranding } from '../SignoffBranding';
import { wholesaleDemo } from './demo';
import { WholesaleBuyerExports, WholesaleBuyerPreview, WholesaleInternalReview } from './WholesaleResults';
import type { WholesaleRun } from './WholesaleResults';
import { WholesaleSetup } from './WholesaleSetup';
import type { TierDraft, WholesaleDraft, WorksheetInspection } from './WholesaleSetup';
import { WholesaleWorker } from './wholesaleWorker';
import type { WholesaleArtifact } from './wholesaleWorker';
import './wholesale.css';

type Completion = { draft: WholesaleDraft; branding?: SignoffBrand; run?: WholesaleRun; error?: string };

const bronze: TierDraft = { id: 1, tierName: 'Bronze', discountMode: 'percent-off-retail', value: '20', minOrderQty: '10', rounding: 'none' };

export default function WholesalePanel({ active, initialPlatform }: { active: boolean; initialPlatform: StorePlatform }) {
  const id = useId();
  const { branding } = useSignoffBranding();
  const nextTierId = useRef(1);
  const currentWorker = useRef<WholesaleWorker | undefined>(undefined);
  const buyerView = useRef(false);
  const [isBuyer, setIsBuyer] = useState(false);
  const [draft, setDraft] = useState<WholesaleDraft>(() => ({ platform: initialPlatform, brandLabel: '', currency: 'USD', effectiveDate: '',
    shopifyCatalogTitle: '', shopifyTierId: 1, tiers: [bronze] }));
  const [inspection, setInspection] = useState<WorksheetInspection>();
  const [completion, setCompletion] = useState<Completion>();
  const [downloadError, setDownloadError] = useState('');
  const { baseline, costSheet, costError, tiers, worksheetName } = draft;
  const workbook = costSheet && /\.xlsx$/i.test(costSheet.file.name) ? costSheet.file : undefined;
  const workbookInspection = workbook && inspection?.file === workbook ? inspection : undefined;
  const sheets = workbookInspection?.names;
  const sheetName = worksheetName ?? (sheets?.length === 1 ? sheets[0] : undefined);
  const ready = Boolean(active && baseline && !costError && (!workbook || (sheetName && sheets?.includes(sheetName))));
  const current = active && completion?.draft === draft && completion.branding === branding ? completion : undefined;
  const run = current?.run?.worker === currentWorker.current ? current?.run : undefined;

  useEffect(() => {
    if (!active || !workbook || workbookInspection) return;
    let current = true;
    let inspector: WholesaleWorker | undefined;
    async function inspect(file: File) {
      try {
        inspector = new WholesaleWorker();
        const names = await inspector.request({ type: 'worksheets', file });
        if (current) setInspection(names.length ? { file, names } : { file, error: 'This workbook has no visible worksheets.' });
      } catch (error) {
        if (current) setInspection({ file, error: error instanceof Error ? error.message : 'The workbook could not be read.' });
      } finally {
        inspector?.terminate();
      }
    }
    void inspect(workbook);
    return () => { current = false; inspector?.terminate(); };
  }, [active, workbook, workbookInspection]);

  useLayoutEffect(() => {
    if (!ready || !draft.baseline) return;
    const baselineFile = draft.baseline.file;
    let current = true;
    let worker: WholesaleWorker | undefined;
    const timer = window.setTimeout(async () => {
      try {
        worker = new WholesaleWorker();
        currentWorker.current = worker;
        const summary = await worker.request({ type: 'build', platform: draft.platform, baseline: baselineFile, costSheet: draft.costSheet?.file,
          branding, settings: {
            brandLabel: draft.brandLabel, currency: draft.currency, effectiveDate: draft.effectiveDate,
            minimumMarginPercent: draft.minimumMarginPercent || undefined, requireMap: draft.requireMap,
            shopifyCatalogTitle: draft.shopifyCatalogTitle, shopifyTierName: draft.tiers.find(({ id }) => id === draft.shopifyTierId)!.tierName,
            tiers: draft.tiers.map(({ id: _id, ...tier }) => tier), worksheetName: sheetName,
          } });
        if (current && currentWorker.current === worker) setCompletion({ draft, branding, run: { summary, worker } });
      } catch (error) {
        if (current && (!worker || currentWorker.current === worker)) {
          setCompletion({ draft, branding, error: error instanceof Error ? error.message : 'The local wholesale preview could not finish.' });
        }
      }
    }, 160);
    return () => {
      current = false;
      window.clearTimeout(timer);
      worker?.terminate();
      if (currentWorker.current === worker) currentWorker.current = undefined;
    };
  }, [branding, draft, ready, sheetName]);

  function change(patch: Partial<WholesaleDraft>) {
    currentWorker.current?.terminate();
    currentWorker.current = undefined;
    setDownloadError('');
    setDraft((previous) => ({ ...previous, ...patch }));
  }

  function loadDemo() {
    const { baseline, costSheet, settings } = wholesaleDemo();
    const tiers = settings.tiers.map((tier) => ({ ...tier, id: ++nextTierId.current }));
    const { shopifyTierName, ...terms } = settings;
    change({ ...terms, platform: 'shopify', baseline, baselineError: undefined, costSheet, costError: undefined, worksheetName: undefined, tiers,
      shopifyTierId: tiers.find(({ tierName }) => tierName === shopifyTierName)!.id });
  }

  function addTier() {
    change({ tiers: [...tiers, { id: ++nextTierId.current, tierName: '', discountMode: 'percent-off-retail', value: '', minOrderQty: '', rounding: 'none' }] });
  }

  function chooseView(buyer: boolean) {
    buyerView.current = buyer;
    setIsBuyer(buyer);
    setDownloadError('');
  }

  async function download(artifact: WholesaleArtifact) {
    if (!run) return;
    const { worker } = run;
    const merchantFile = artifact === 'audit' || artifact === 'internal';
    setDownloadError('');
    try {
      const file = await worker.request({ type: 'download', artifact });
      if (currentWorker.current === worker && (!merchantFile || !buyerView.current)) downloadFile(file.filename, file.bytes, file.mime);
    } catch {
      if (currentWorker.current === worker && (!merchantFile || !buyerView.current)) setDownloadError('This download could not be prepared.');
    }
  }

  const summary = run?.summary;
  const status = summary ? summary.canExport ? 'Buyer files are ready.' : 'Buyer downloads held. Review the wholesale checks.'
    : current?.error ? 'Wholesale preview could not finish.'
    : ready ? 'Preparing the wholesale preview locally…'
    : !baseline ? 'Choose a store catalog CSV or load the synthetic demo.'
    : workbook && !workbookInspection ? 'Reading visible worksheets locally…'
    : workbook && !sheetName && !workbookInspection?.error ? 'Select the cost and MAP worksheet to continue.'
    : 'Review the selected cost and MAP file to continue.';

  return (
    <section className="price-section wholesale-panel" aria-labelledby={id} data-testid="wholesale-panel">
      <div className="wholesale-heading">
        <div>
          <h2 id={id}>Wholesale B2B Line-Sheet</h2>
          <p className="field-help">Build tiered prices from a store catalog, then preview what buyers will see. Files stay in this browser.</p>
        </div>
        <div className="price-platform-toggle" role="group" aria-label="Wholesale preview view">
          <button type="button" aria-pressed={!isBuyer} onClick={() => chooseView(false)}>Internal margin review</button>
          <button type="button" aria-pressed={isBuyer} onClick={() => chooseView(true)}>Buyer-safe preview</button>
        </div>
      </div>
      {!isBuyer ? <WholesaleSetup draft={draft} workbook={workbook} inspection={workbookInspection} change={change} onDemo={loadDemo} onAddTier={addTier} /> : null}
      <div className="wholesale-review">
        <p className="wholesale-status" data-testid="wholesale-status" data-state={summary ? summary.canExport ? 'ready' : 'hold' : undefined} role="status">
          {isBuyer && !summary?.canExport ? (ready && !current?.error && !summary ? 'Preparing the buyer line sheet…' : 'Buyer prices are unavailable. Return to internal review to prepare the line sheet.') : status}
        </p>
        {!isBuyer && current?.error ? <p className="file-message file-error" role="alert">{current.error}</p> : null}
        {isBuyer ? (run?.summary.canExport ? <WholesaleBuyerPreview run={run} brandLabel={draft.brandLabel.trim()} currency={draft.currency}
          effectiveDate={draft.effectiveDate} branding={branding} /> : null)
          : <WholesaleInternalReview run={run} tierNames={tiers.map(({ tierName }, index) => tierName.trim() || `Tier ${index + 1}`)} onDownload={download} />}
        <WholesaleBuyerExports summary={summary} onDownload={download} />
        {downloadError ? <p className="file-message file-error" role="alert">{downloadError}</p> : null}
      </div>
    </section>
  );
}
