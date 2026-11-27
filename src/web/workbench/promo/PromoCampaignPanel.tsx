import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PromoCampaignOptions } from '../../../core/promo-campaign/types';
import { baselinePrice } from '../../../core/shopify-price-diff/prices';
import type { StorePlatform } from '../../../core/shopify-price-diff/workspace-profile';
import { encodeCliText, exampleSheetPath, LocalCliCommand } from '../LocalCliCommand';
import type { GeneratedPairSource } from '../PriceDiffWorkbench';
import { PriceFileInput } from '../PriceFileInput';
import { STORE_PLATFORMS } from '../WorkspaceProfile';
import { downloadFile } from '../downloads';
import { useSignoffBranding } from '../SignoffBranding';
import { CampaignExports, CampaignResults } from './CampaignResults';
import { CampaignWorker } from './campaignWorker';
import type { CampaignArtifact, CampaignSummary } from './campaignWorker';
import { campaignDemo } from './demo';

type CampaignRule = PromoCampaignOptions['rule'];
type LocalFile = { file: File; synthetic?: boolean };
type ScopeKind = 'all' | 'prefix' | 'list';

interface CampaignInputs {
  platform: StorePlatform;
  baseline?: LocalFile;
  baselineError?: string;
  costSheet?: LocalFile;
  costError?: string;
  rule: CampaignRule;
  scopeKind: ScopeKind;
  skuPrefix: string;
  skuList: string;
  handle: string;
  tag: string;
  costCheck: boolean;
  skipLineNumbers: number[];
}

const defaultRule: CampaignRule = { mode: 'percent-off', amount: '20', rounding: 'ending-99', minimumRetail: '', preserveHigherCompareAt: true };
const defaultFields = { scopeKind: 'all', skuPrefix: '', skuList: '', handle: '', tag: '', costCheck: false } as const;
const costField = { title: 'Cost sheet (optional)', formats: 'Drop a CSV or one-sheet XLSX with SKU and Cost columns', label: 'Choose cost sheet', accept: '.csv,.xlsx' };
const baselineFormats: Record<StorePlatform, string> = {
  shopify: 'Drop a Shopify product CSV export',
  woocommerce: 'Drop a WooCommerce Products CSV export',
  bigcommerce: 'Drop a legacy BigCommerce Bulk Edit CSV export',
};
const roundingOptions: Record<CampaignRule['rounding'], string> = {
  none: 'Round to cents', 'ending-99': 'End in .99', 'ending-95': 'End in .95', 'nearest-whole': 'Round to .00',
};

interface Completion {
  inputs: CampaignInputs;
  result?: { summary: CampaignSummary; worker: CampaignWorker };
  error?: string;
}

export default function PromoCampaignPanel({ initialPlatform, onPairAvailable, onVerify }: {
  initialPlatform: StorePlatform;
  onPairAvailable: (source: GeneratedPairSource | null) => void;
  onVerify: () => void;
}) {
  const id = useId();
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const activeWorker = useRef<CampaignWorker | undefined>(undefined);
  const { branding } = useSignoffBranding();
  const [inputs, setInputs] = useState<CampaignInputs>(() => ({ ...defaultFields, platform: initialPlatform, rule: defaultRule, skipLineNumbers: [] }));
  const [completion, setCompletion] = useState<Completion>();
  const [downloadError, setDownloadError] = useState('');
  const { platform, baseline, baselineError, costSheet, costError, costCheck, rule, scopeKind, skuPrefix, skuList, handle, tag, skipLineNumbers } = inputs;
  const isShopify = platform === 'shopify';
  const percent = rule.mode === 'percent-off';
  const skus = useMemo(() => skuList.split(/\r?\n/).filter((line) => line !== ''), [skuList]);
  const scopeReady = scopeKind === 'all' || (scopeKind === 'prefix' ? skuPrefix !== '' : skus.length > 0);
  const ready = Boolean(baseline && rule.amount.trim() && rule.minimumRetail.trim() && scopeReady && !(costCheck && costError));
  const current = completion?.inputs === inputs ? completion : undefined;
  const report = current?.result;
  const busy = ready && !current;

  useEffect(() => {
    const { baseline, platform, costCheck, costSheet, handle, tag, rule, scopeKind, skuPrefix, skipLineNumbers } = inputs;
    if (!ready || !baseline) return;
    let active = true;
    let worker: CampaignWorker | undefined;
    const timer = window.setTimeout(async () => {
      try {
        worker = new CampaignWorker();
        activeWorker.current = worker;
        const summary = await worker.request({ type: 'build', platform, baseline: baseline.file, costSheet: costCheck ? costSheet?.file : undefined,
          options: { rule, costCheck, skipLineNumbers, storeLabel: baseline.file.name.replace(/\.csv$/i, ''),
            scope: {
              ...(scopeKind === 'prefix' ? { skuPrefix } : scopeKind === 'list' ? { skus } : {}),
              ...(platform === 'shopify' && handle ? { handle } : {}), ...(platform === 'shopify' && tag ? { tag } : {}),
            },
          },
        });
        if (active && activeWorker.current === worker) setCompletion({ inputs, result: { summary, worker } });
      } catch (error) {
        if (active && (!worker || activeWorker.current === worker)) {
          setCompletion({ inputs, error: error instanceof Error ? error.message : 'The local campaign preview could not finish.' });
        }
      }
    }, 160);
    return () => {
      active = false;
      window.clearTimeout(timer);
      worker?.terminate();
      if (activeWorker.current === worker) activeWorker.current = undefined;
    };
  }, [inputs, ready, skus]);

  const pair = useMemo((): GeneratedPairSource | null => {
    if (!baseline || !report?.summary.canExport) return null;
    const { worker } = report;
    return {
      platform,
      baseline: baseline.file,
      async load() {
        const [update, rollback] = await Promise.all([
          worker.request({ type: 'download', artifact: 'launch' }),
          worker.request({ type: 'download', artifact: 'revert' }),
        ]);
        if (activeWorker.current !== worker) throw new Error('The campaign settings changed. Load the current pair.');
        return {
          update: new File([update.bytes], update.filename, { type: update.mime }),
          rollback: new File([rollback.bytes], rollback.filename, { type: rollback.mime }),
        };
      },
    };
  }, [baseline, platform, report]);

  useLayoutEffect(() => {
    if (!pair) return;
    onPairAvailable(pair);
    return () => onPairAvailable(null);
  }, [onPairAvailable, pair]);

  function change(patch: Partial<CampaignInputs>) {
    activeWorker.current?.terminate();
    activeWorker.current = undefined;
    setCompletion(undefined);
    setDownloadError('');
    onPairAvailable(null);
    setInputs({ ...inputs, ...patch });
  }

  function changeRule(patch: Partial<CampaignRule>) {
    change({ rule: { ...rule, ...patch } });
  }

  function changeScope(patch: Partial<Pick<CampaignInputs, 'scopeKind' | 'skuPrefix' | 'skuList' | 'handle' | 'tag'>>) {
    change({ ...patch, skipLineNumbers: [] });
  }

  function choosePlatform(next: StorePlatform) {
    if (next === platform) return;
    change({ platform: next, baseline: undefined, baselineError: undefined, costSheet: undefined, costError: undefined,
      handle: '', tag: '', skipLineNumbers: [] });
  }

  function loadBaseline(choices: FileList) {
    if (!choices.length) return;
    const file = choices.length === 1 && /\.csv$/i.test(choices[0].name) ? choices[0] : undefined;
    change({ baseline: file ? { file } : undefined, baselineError: file ? undefined : 'Choose one baseline file with a .csv extension.', skipLineNumbers: [] });
  }

  function loadCostSheet(choices: FileList) {
    if (!choices.length) return;
    const file = choices.length === 1 && /\.(csv|xlsx)$/i.test(choices[0].name) ? choices[0] : undefined;
    change({ costSheet: file ? { file } : undefined, costError: file ? undefined : 'Choose one cost sheet with a .csv or .xlsx extension.' });
  }

  function loadDemo() {
    change({ ...defaultFields, skipLineNumbers: [], baseline: { file: campaignDemo(platform), synthetic: true }, baselineError: undefined,
      costSheet: undefined, costError: undefined, rule: { ...defaultRule, minimumRetail: '10.00' } });
  }

  function toggleSkip(line: number, restore: boolean) {
    change({ skipLineNumbers: restore ? skipLineNumbers.filter((number) => number !== line) : [...skipLineNumbers, line] });
    reviewHeading.current?.focus();
  }

  async function download(artifact: CampaignArtifact) {
    if (!report) return;
    const { worker } = report;
    setDownloadError('');
    try {
      const file = await worker.request({ type: 'download', artifact, ...(artifact === 'signoff' && branding ? { branding } : {}) });
      if (activeWorker.current === worker) downloadFile(file.filename, file.bytes, file.mime);
    } catch (error) {
      if (activeWorker.current === worker) setDownloadError(error instanceof Error ? error.message : 'The download could not be prepared.');
    }
  }

  const previewStatus = busy ? 'Building the campaign preview locally…' : report
    ? report.summary.canExport ? 'Launch and revert passed local replay.' : 'Campaign CSVs held. Review the issues below.'
    : !baseline ? 'Choose a baseline CSV to preview a campaign.'
    : !rule.minimumRetail.trim() ? 'Enter a minimum retail floor to preview.'
    : !rule.amount.trim() ? 'Enter the discount amount to preview.'
    : !scopeReady ? 'Enter the SKU scope to preview.' : '';

  return (
    <section className="price-section campaign-panel" aria-labelledby={id} data-testid="campaign-panel">
      <div className="price-store-platform">
        <span id={`${id}-platform`}>Store platform</span>
        <div className="price-platform-toggle" role="group" aria-labelledby={`${id}-platform`}>
          {(Object.keys(STORE_PLATFORMS) as StorePlatform[]).map((option) => (
            <button key={option} type="button" data-platform={option} aria-pressed={platform === option}
              onClick={() => choosePlatform(option)}>{STORE_PLATFORMS[option]}</button>
          ))}
        </div>
      </div>
      <div className="price-heading">
        <div>
          <h2 id={id}>Sale Campaign Pack</h2>
          <p className="field-help">Create matching launch and revert CSVs from your current {STORE_PLATFORMS[platform]} export. Files stay in this browser.</p>
        </div>
        <button className="button button-secondary" type="button" onClick={loadDemo}>Load Synthetic Promo Demo</button>
      </div>
      {platform === 'bigcommerce' ? <p className="field-help catalog-import-note">Legacy Bulk Edit campaigns require standalone products with an existing numeric Sale Price. Enable <strong>Ignore blank values</strong> when importing the pair.</p> : null}
      <div className="price-files campaign-files">
        <PriceFileInput side="campaign-baseline" field={{ title: 'Campaign baseline CSV', formats: baselineFormats[platform], label: 'Choose campaign baseline CSV', accept: '.csv' }}
          file={baseline} message={{ error: baselineError }} onLoad={loadBaseline} clearLabel="Clear campaign baseline CSV"
          onClear={() => change({ baseline: undefined, baselineError: undefined, skipLineNumbers: [] })} />
        {costCheck ? <PriceFileInput side="campaign-cost" field={costField} file={costSheet} message={{ error: costError }}
          onLoad={loadCostSheet} onClear={() => change({ costSheet: undefined, costError: undefined })} /> : null}
      </div>
      {baseline?.synthetic ? <p className="field-help campaign-demo-note">The demo starts at 20% off with a 10.00 floor. Review DEMO-LOW, then change the floor or skip that row.</p> : null}
      <fieldset className="campaign-settings">
        <legend>Campaign settings</legend>
        <div className="price-fields">
          <div className="campaign-field">
            <label htmlFor={`${id}-discount-type`}>Discount type</label>
            <select id={`${id}-discount-type`} value={rule.mode} onChange={(event) => {
              const mode = event.currentTarget.value as CampaignRule['mode'];
              changeRule({ mode, amount: mode === 'percent-off' ? '20' : '' });
            }}>
              <option value="percent-off">Percent off</option>
              <option value="fixed-amount-off">Fixed amount off</option>
            </select>
          </div>
          <div className="campaign-field">
            <label htmlFor={`${id}-amount`}>{percent ? 'Percent off' : 'Fixed amount off'}</label>
            <input id={`${id}-amount`} type="text" inputMode="decimal" required value={rule.amount} aria-describedby={`${id}-amount-help`}
              onChange={(event) => changeRule({ amount: event.currentTarget.value })} />
            <p id={`${id}-amount-help`} className="field-help">{percent ? 'From 1% to 90%' : 'Store currency, up to two decimals'}</p>
          </div>
          <div className="campaign-field">
            <label htmlFor={`${id}-rounding`}>Rounding</label>
            <select id={`${id}-rounding`} value={rule.rounding}
              onChange={(event) => changeRule({ rounding: event.currentTarget.value as CampaignRule['rounding'] })}>
              {Object.entries(roundingOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div className="campaign-field">
            <label htmlFor={`${id}-floor`}>Minimum retail floor</label>
            <input id={`${id}-floor`} type="text" inputMode="decimal" required value={rule.minimumRetail}
              onChange={(event) => changeRule({ minimumRetail: event.currentTarget.value })} />
          </div>
        </div>
        <div className="campaign-options">
          {isShopify ? <label className="checkbox-label">
            <input type="checkbox" checked={Boolean(rule.preserveHigherCompareAt)} onChange={(event) => changeRule({ preserveHigherCompareAt: event.currentTarget.checked })} />
            <span>Preserve higher Shopify compare-at price</span>
          </label> : null}
          <label className="checkbox-label">
            <input type="checkbox" checked={costCheck} onChange={(event) => change({ costCheck: event.currentTarget.checked })} />
            <span>Check prices against cost</span>
          </label>
          {costCheck ? <p className="field-help">Flags promo prices below a known cost. A selected cost sheet can supply missing costs or replace baseline costs.</p> : null}
        </div>
      </fieldset>
      <fieldset className="campaign-settings">
        <legend>Campaign scope</legend>
        <div className="price-fields">
          <div className="campaign-field">
            <label htmlFor={`${id}-scope`}>SKU scope</label>
            <select id={`${id}-scope`} value={scopeKind} onChange={(event) => changeScope({ scopeKind: event.currentTarget.value as ScopeKind })}>
              <option value="all">All priced rows</option>
              <option value="prefix">SKU prefix</option>
              <option value="list">Exact SKU list</option>
            </select>
          </div>
          {scopeKind === 'prefix' ? <div className="campaign-field">
            <label htmlFor={`${id}-prefix`}>SKU prefix</label>
            <input id={`${id}-prefix`} type="text" value={skuPrefix} required onChange={(event) => changeScope({ skuPrefix: event.currentTarget.value })} />
          </div> : scopeKind === 'list' ? <div className="campaign-field">
            <label htmlFor={`${id}-sku-list`}>SKU list</label>
            <textarea id={`${id}-sku-list`} rows={2} value={skuList} required aria-describedby={`${id}-sku-help`} onChange={(event) => changeScope({ skuList: event.currentTarget.value })} />
            <p id={`${id}-sku-help`} className="field-help">One exact SKU per line</p>
          </div> : null}
          {isShopify ? <>
            <div className="campaign-field">
              <label htmlFor={`${id}-handle`}>Product handle</label>
              <input id={`${id}-handle`} type="text" value={handle} onChange={(event) => changeScope({ handle: event.currentTarget.value })} />
            </div>
            <div className="campaign-field">
              <label htmlFor={`${id}-tag`}>Product tag</label>
              <input id={`${id}-tag`} type="text" value={tag} onChange={(event) => changeScope({ tag: event.currentTarget.value })} />
            </div>
          </> : null}
        </div>
      </fieldset>
      <section className="campaign-review" aria-labelledby={`${id}-review`}>
        <h3 id={`${id}-review`} ref={reviewHeading} tabIndex={-1}>Campaign preview</h3>
        <p className="field-help" role="status">{previewStatus}</p>
        {current?.error ? <p className="file-message file-error" role="alert">{current.error}</p> : null}
        {report ? <CampaignResults {...report} platform={platform} onSkip={toggleSkip} /> : null}
        {baseline ? <CampaignExports report={report?.summary} onDownload={download} onVerify={onVerify} /> : null}
        {downloadError ? <p className="file-message file-error" role="alert">{downloadError}</p> : null}
      </section>
      <LocalCliCommand mode="promo"
        unavailable="Enter a discount and minimum retail as decimals, finish the selected scope, and clear any cost sheet error."
        getArguments={() => baselinePrice.test(rule.amount) && baselinePrice.test(rule.minimumRetail) && scopeReady && !(costCheck && costError)
          ? [
            '--platform', platform, '--baseline', 'baseline.csv',
            '--discount-mode', rule.mode, '--discount-amount', rule.amount,
            '--minimum-retail', rule.minimumRetail, '--rounding', rule.rounding,
            ...(isShopify && rule.preserveHigherCompareAt ? ['--preserve-higher-compare-at'] : []),
            ...(scopeKind === 'prefix' ? ['--sku-prefix-b64', encodeCliText(skuPrefix)] : scopeKind === 'list'
              ? skus.flatMap((sku) => ['--sku-b64', encodeCliText(sku)]) : []),
            ...(isShopify && handle ? ['--handle-b64', encodeCliText(handle)] : []),
            ...(isShopify && tag ? ['--tag-b64', encodeCliText(tag)] : []),
            ...skipLineNumbers.flatMap((line) => ['--skip-line', String(line)]),
            ...(costCheck ? ['--cost-check'] : []),
            ...(costCheck && costSheet ? ['--cost-sheet', exampleSheetPath('cost-sheet', costSheet.file.name)] : []),
          ] : null} />
    </section>
  );
}
