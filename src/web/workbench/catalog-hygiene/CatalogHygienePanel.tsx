import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import demoCatalog from '../../../../fixtures/m25/shopify-hold.csv?raw';
import { PriceFileInput } from '../PriceFileInput';
import { SignoffBrandingDrawer, useSignoffBranding } from '../SignoffBranding';
import { STORE_PLATFORMS } from '../WorkspaceProfile';
import { downloadFile } from '../downloads';
import { CatalogHygieneResults } from './CatalogHygieneResults';
import { CatalogHygieneWorker } from './catalogHygieneWorker';
import type { CatalogHygieneArtifact, CatalogHygieneInput, CatalogHygieneSummary } from './catalogHygieneWorker';
import './catalog-hygiene.css';

type Platform = CatalogHygieneInput['sources'][number]['platform'];
type Source = 'primary' | 'secondary';
type FileChoice = { file: File; synthetic?: boolean } | { error: string };

interface Draft {
  primaryPlatform: Platform;
  secondaryPlatform?: Platform;
  primary?: FileChoice;
  secondary?: FileChoice;
  trimSkus: boolean;
  stripZeroWidth: boolean;
}

interface Report {
  worker: CatalogHygieneWorker;
  report: CatalogHygieneSummary;
}

const INITIAL_DRAFT: Draft = { primaryPlatform: 'shopify', trimSkus: false, stripZeroWidth: false };
const PLATFORMS = { ...STORE_PLATFORMS, bigcommerce: 'BigCommerce (legacy Bulk Edit)' } satisfies Record<Platform, string>;

export default function CatalogHygienePanel({ active }: { active: boolean }) {
  const id = useId();
  const { branding } = useSignoffBranding();
  const [draft, setDraft] = useState(INITIAL_DRAFT);
  const [outcome, setOutcome] = useState<{ input: CatalogHygieneInput } & (Report | { error: string })>();
  const [saveError, setSaveError] = useState<{ report: Report; message: string }>();
  const latest = useRef<Report | undefined>(undefined);

  const input = useMemo<CatalogHygieneInput | undefined>(() => {
    const { primary, secondary, primaryPlatform, secondaryPlatform, trimSkus, stripZeroWidth } = draft;
    if (!primary || 'error' in primary || (secondary && 'error' in secondary)) return undefined;
    const sources = [{ file: primary.file, platform: primaryPlatform }];
    if (secondary) sources.push({ file: secondary.file, platform: secondaryPlatform ?? primaryPlatform });
    return { sources, options: { trimSkus, stripZeroWidth, branding } };
  }, [draft, branding]);
  const current = input && outcome?.input === input ? outcome : undefined;
  const run = current && 'report' in current ? current : undefined;
  const error = current && 'error' in current ? current.error : undefined;

  useEffect(() => {
    if (!input) return;
    let current = true;
    let worker: CatalogHygieneWorker | undefined;

    async function scan(input: CatalogHygieneInput) {
      try {
        worker = new CatalogHygieneWorker();
        const report = await worker.request({ type: 'audit', input });
        if (current) setOutcome({ input, worker, report });
      } catch (cause) {
        if (current) setOutcome({ input, error: cause instanceof Error ? cause.message : 'The local catalog audit could not finish.' });
      }
    }

    const timer = window.setTimeout(() => { void scan(input); }, 120);
    return () => {
      current = false;
      window.clearTimeout(timer);
      worker?.terminate();
    };
  }, [input]);

  useLayoutEffect(() => {
    latest.current = active ? run : undefined;
    return () => { latest.current = undefined; };
  }, [active, run]);

  function change(patch: Partial<Draft>) {
    setDraft((previous) => ({ ...previous, ...patch }));
  }

  function replace(source: Source, files: FileList) {
    if (!files.length) return;
    change({ [source]: files.length === 1 && /\.csv$/i.test(files[0].name) ? { file: files[0] } : { error: 'Choose one file with a .csv extension.' } });
  }

  function loadDemo() {
    const file = new File([demoCatalog], 'shopify-hold.csv', { type: 'text/csv' });
    setDraft({ ...INITIAL_DRAFT, primary: { file, synthetic: true } });
  }

  async function save(artifact: CatalogHygieneArtifact) {
    if (!run || latest.current !== run) return;
    setSaveError(undefined);
    try {
      const { bytes, filename, mime } = await run.worker.request({ type: 'download', artifact });
      if (latest.current === run) downloadFile(filename, bytes, mime);
    } catch (cause) {
      if (latest.current === run) setSaveError({ report: run, message: cause instanceof Error ? cause.message : 'The catalog file could not be saved.' });
    }
  }

  const status = run?.report.status;
  const statusMessage = status === 'READY' ? 'READY · Catalog audit complete.'
    : status === 'HOLD' ? 'HOLD · Resolve the blocking issues before downloading cleaned catalog and rollback CSVs.'
    : error ? 'The local catalog audit stopped.'
    : input ? 'Scanning catalogs locally…' : 'Choose a primary catalog CSV to start the audit.';
  const platforms = Object.entries(PLATFORMS).map(([value, label]) => <option key={value} value={value}>{label}</option>);

  return (
    <section className="price-section catalog-hygiene" aria-labelledby={id} data-testid="catalog-hygiene-panel">
      <div className="price-heading">
        <div>
          <h2 id={id}>Catalog &amp; Barcode Hygiene</h2>
          <p className="field-help">Check catalog SKUs, GS1 barcodes, and retail prices. Compare two stores for collisions. Files stay in this browser.</p>
        </div>
        <button className="button button-secondary" type="button" onClick={loadDemo}>Load Synthetic GS1 &amp; Duplicate SKU Audit Demo</button>
      </div>
      <div className="price-files catalog-hygiene-sources">
        <div>
          <div className="price-sheet">
            <label htmlFor={`${id}-primary-platform`}>Primary catalog platform</label>
            <select id={`${id}-primary-platform`} value={draft.primaryPlatform} onChange={(event) => change({ primaryPlatform: event.currentTarget.value as Platform })}>
              {platforms}
            </select>
          </div>
          <PriceFileInput side="hygiene-primary" inputTestId="catalog-hygiene-primary-input"
            field={{ title: 'Primary catalog CSV', formats: 'Drop a native product CSV export', label: 'Choose primary catalog CSV', accept: '.csv' }}
            file={draft.primary && 'file' in draft.primary ? draft.primary : undefined}
            message={{ error: draft.primary && 'error' in draft.primary ? draft.primary.error : undefined }}
            onLoad={(files) => replace('primary', files)} onClear={() => change({ primary: undefined })} clearLabel="Clear primary catalog CSV" />
        </div>
        <div>
          <div className="price-sheet">
            <label htmlFor={`${id}-secondary-platform`}>Secondary catalog platform</label>
            <select id={`${id}-secondary-platform`} value={draft.secondaryPlatform ?? ''}
              onChange={(event) => change({ secondaryPlatform: (event.currentTarget.value || undefined) as Platform | undefined })}>
              <option value="">Same as primary</option>
              {platforms}
            </select>
          </div>
          <PriceFileInput side="hygiene-secondary" inputTestId="catalog-hygiene-secondary-input"
            field={{ title: 'Secondary catalog CSV (optional)', formats: 'Drop a second native product CSV export', label: 'Choose secondary catalog CSV', accept: '.csv' }}
            file={draft.secondary && 'file' in draft.secondary ? draft.secondary : undefined}
            message={{ error: draft.secondary && 'error' in draft.secondary ? draft.secondary.error : undefined }}
            onLoad={(files) => replace('secondary', files)} onClear={() => change({ secondary: undefined })} clearLabel="Clear secondary catalog CSV" />
        </div>
      </div>
      <fieldset className="catalog-hygiene-options" aria-describedby={`${id}-cleanup-help`}>
        <legend>Optional cleanup</legend>
        <div>
          <label className="checkbox-label"><input type="checkbox" checked={draft.trimSkus}
            onChange={(event) => change({ trimSkus: event.currentTarget.checked })} /><span>Trim outer SKU whitespace</span></label>
          <label className="checkbox-label"><input type="checkbox" checked={draft.stripZeroWidth}
            onChange={(event) => change({ stripZeroWidth: event.currentTarget.checked })} /><span>Remove allowlisted zero-width characters</span></label>
        </div>
        <p className="field-help" id={`${id}-cleanup-help`}>Both options start off. Review the exact cell changes before downloading the CSVs.</p>
      </fieldset>
      <SignoffBrandingDrawer allowProfileLoad />
      <p className="catalog-hygiene-status" role="status" data-testid="catalog-hygiene-status" data-state={status?.toLowerCase()}>
        {statusMessage}
      </p>
      {error ? <p className="file-message file-error" role="alert">{error}</p> : null}
      {run ? <CatalogHygieneResults worker={run.worker} report={run.report} onDownload={save} /> : null}
      {run && saveError?.report === run ? <p className="file-message file-error" role="alert">{saveError.message}</p> : null}
    </section>
  );
}
