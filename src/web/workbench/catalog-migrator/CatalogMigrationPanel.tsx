import { useEffect, useId, useRef, useState } from 'react';
import { PriceFileInput } from '../PriceFileInput';
import { STORE_PLATFORMS } from '../WorkspaceProfile';
import { downloadFile } from '../downloads';
import { catalogDemo } from './demo';
import { MigrationWorker } from './migrationWorker';
import type { CatalogArtifact, CatalogPlatform, CatalogRun } from './migrationWorker';
import { MigrationResults } from './MigrationResults';

const PLATFORMS = Object.keys(STORE_PLATFORMS) as CatalogPlatform[];
const CATALOG_FIELD = {
  title: 'Source catalog CSV', formats: 'Drop a catalog CSV here', label: 'Choose source catalog CSV', accept: '.csv,text/csv',
};
const DOWNLOADS = [
  { artifact: 'targetCsv', label: 'Target Import CSV' },
  { artifact: 'auditJson', label: 'Migration Audit JSON' },
  { artifact: 'signOffHtml', label: 'Migration Sign-Off (.html)' },
] as const;

export default function CatalogMigrationPanel() {
  const id = useId();
  const currentWorker = useRef<MigrationWorker | null>(null);
  const [source, setSource] = useState<CatalogPlatform>('shopify');
  const [target, setTarget] = useState<CatalogPlatform>('woocommerce');
  const [file, setFile] = useState<{ file: File; synthetic?: boolean }>();
  const [fileError, setFileError] = useState('');
  const [runError, setRunError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [report, setReport] = useState<{ worker: MigrationWorker; result: CatalogRun }>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!file) return;
    let worker: MigrationWorker;
    try {
      worker = new MigrationWorker();
    } catch {
      setRunError('The local migration worker could not start. Choose the file again to retry.');
      return;
    }
    currentWorker.current = worker;
    void worker.request({ type: 'build', file: file.file, source, target }).then((result) => {
      if (currentWorker.current === worker) setReport({ worker, result });
    }, (error: Error) => {
      if (currentWorker.current === worker) setRunError(error.message);
    });
    return () => {
      if (currentWorker.current === worker) currentWorker.current = null;
      worker.terminate();
    };
  }, [file, source, target]);

  function invalidate() {
    currentWorker.current?.terminate();
    currentWorker.current = null;
    setReport(undefined);
    setRunError('');
    setSaveError('');
    setSaving(false);
  }

  function replaceFile(next?: typeof file, message = '') {
    invalidate();
    setFile(next);
    setFileError(message);
  }

  function load(files: FileList) {
    if (!files.length) return;
    if (files.length !== 1 || !/\.csv$/i.test(files[0].name)) {
      replaceFile(undefined, 'Choose one catalog file with a .csv extension.');
      return;
    }
    replaceFile({ file: files[0] });
  }

  function chooseSource(next: CatalogPlatform) {
    if (next === source) return;
    invalidate();
    setFileError('');
    if (file?.synthetic) setFile(undefined);
    setSource(next);
    if (next === target) setTarget(source);
  }

  function chooseTarget(next: CatalogPlatform) {
    if (next === target) return;
    invalidate();
    setTarget(next);
  }

  async function download(artifact: CatalogArtifact) {
    if (!report || saving || (artifact === 'targetCsv' && !report.result.ready)) return;
    const { worker } = report;
    setSaving(true);
    setSaveError('');
    try {
      const { filename, bytes, mime } = await worker.request({ type: 'download', artifact });
      if (currentWorker.current === worker) downloadFile(filename, bytes, mime);
    } catch (error) {
      if (currentWorker.current === worker) setSaveError(error instanceof Error ? error.message : 'This migration file could not be saved.');
    } finally {
      if (currentWorker.current === worker) setSaving(false);
    }
  }

  const result = report?.result;
  const ready = result?.ready ?? false;
  const held = Boolean(result && !ready);
  const reading = Boolean(file && !report && !runError);
  const status = runError ? 'Migration stopped' : ready ? 'Target CSV ready for review' : held ? 'Target CSV held for review' :
    reading ? 'Checking source rows and building the local preview…' : 'Add a source catalog CSV to preview the migration.';

  return (
    <div className="price-section catalog-migration">
      <header className="price-heading">
        <div>
          <h2>Migrate a product catalog</h2>
          <p className="field-help">Convert products and variants for a new store. The source file stays in this browser.</p>
        </div>
      </header>
      <div className="migration-setup">
        <div className="migration-config">
          <h3>Migration direction</h3>
          <div className="price-fields migration-platforms">
            <div>
              <label htmlFor={`${id}-source`}>Source platform</label>
              <select id={`${id}-source`} value={source} onChange={(event) => chooseSource(event.currentTarget.value as CatalogPlatform)}>
                {PLATFORMS.map((platform) => <option key={platform} value={platform}>{STORE_PLATFORMS[platform]}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`${id}-target`}>Target platform</label>
              <select id={`${id}-target`} value={target} onChange={(event) => chooseTarget(event.currentTarget.value as CatalogPlatform)}
                aria-describedby={target === 'bigcommerce' ? `${id}-dialect` : undefined}>
                {PLATFORMS.filter((platform) => platform !== source).map((platform) => <option key={platform} value={platform}>{STORE_PLATFORMS[platform]}</option>)}
              </select>
            </div>
          </div>
          {target === 'bigcommerce' ? <p id={`${id}-dialect`} className="field-help">Output format: BigCommerce modern product CSV (Product and Variant rows).</p> : null}
          {result?.sourceDialect === 'bigcommerce-modern' || result?.sourceDialect === 'bigcommerce-legacy' ? (
            <p className="field-help">Source format: {result.sourceDialect === 'bigcommerce-modern' ? 'BigCommerce modern product CSV' : 'BigCommerce legacy Bulk Edit CSV'}.</p>
          ) : null}
        </div>
        <PriceFileInput side="migration-source" field={CATALOG_FIELD} file={file} message={{ error: fileError }}
          onLoad={load} onClear={() => replaceFile()} clearLabel="Clear source catalog CSV">
          <button type="button" className="button button-secondary button-small migration-demo"
            onClick={() => replaceFile({ file: catalogDemo(source), synthetic: true })}>Load Synthetic Multi-Variant Demo</button>
        </PriceFileInput>
      </div>
      <div className="migration-review">
        <p className="delta-state" data-testid="catalog-migration-status" data-ready={ready} data-held={held} role="status">{status}</p>
        {runError ? <p className="file-message file-error" role="alert">{runError}</p> : null}
        {report ? <MigrationResults report={report} /> : null}
        <section className="migration-downloads" aria-label="Migration downloads">
          {result ? <p className="field-help">{ready
            ? `Review the disclosed fields and preview before manually importing the creation CSV into ${STORE_PLATFORMS[target]}.`
            : 'Review the source issues. The audit and sign-off document why the target CSV is held.'}</p> : null}
          <div className="export-buttons">
            {DOWNLOADS.map(({ artifact, label }) => (
              <button key={artifact} type="button" className={`button ${artifact === 'targetCsv' ? 'button-primary' : 'button-secondary'}`}
                disabled={!report || saving || (artifact === 'targetCsv' && !ready)} onClick={() => void download(artifact)}>{label}</button>
            ))}
          </div>
          {saveError ? <p className="file-message file-error" role="alert">{saveError}</p> : null}
        </section>
      </div>
    </div>
  );
}
