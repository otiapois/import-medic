import { useId, useRef } from 'react';
import type { WholesaleTier } from '../../../core/wholesale-pricelist/engine';
import type { StorePlatform } from '../../../core/shopify-price-diff/workspace-profile';
import { PriceFileInput } from '../PriceFileInput';
import { SignoffBrandingDrawer } from '../SignoffBranding';
import { STORE_PLATFORMS } from '../WorkspaceProfile';
import type { WholesaleSettings } from './wholesaleWorker';

type LocalFile = { file: File; synthetic?: boolean };
export type TierDraft = WholesaleTier & { id: number };

export interface WholesaleDraft extends Omit<WholesaleSettings, 'tiers' | 'shopifyTierName'> {
  platform: StorePlatform;
  baseline?: LocalFile;
  baselineError?: string;
  costSheet?: LocalFile;
  costError?: string;
  tiers: readonly TierDraft[];
  shopifyTierId: number;
}

export type WorksheetInspection = { file: File; names?: string[]; error?: string };

const baselineFormats: Record<StorePlatform, string> = {
  shopify: 'Drop a Shopify product CSV export',
  woocommerce: 'Drop a WooCommerce Products CSV export',
  bigcommerce: 'Drop a legacy BigCommerce Bulk Edit CSV export',
};

const costField = { title: 'Landed cost and MAP (optional)', formats: 'Drop a CSV or XLSX with exact SKUs and landed costs',
  label: 'Choose landed cost and MAP file', accept: '.csv,.xlsx' };

const rounding = {
  none: 'Round to cents', 'ending-99': 'End in .99', 'ending-95': 'End in .95', 'nearest-whole': 'Round to .00',
} satisfies Record<WholesaleTier['rounding'], string>;

export function WholesaleSetup({ draft, workbook, inspection, change, onDemo, onAddTier }: {
  draft: WholesaleDraft;
  workbook?: File;
  inspection?: WorksheetInspection;
  change: (patch: Partial<WholesaleDraft>) => void;
  onDemo: () => void;
  onAddTier: () => void;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const { platform, baseline, baselineError, costSheet, costError, tiers, shopifyTierId, worksheetName } = draft;
  const sheet = worksheetName ?? (inspection?.names?.length === 1 ? inspection.names[0] : '');

  function choosePlatform(value: StorePlatform) {
    if (platform !== value) change({ platform: value, baseline: undefined, baselineError: undefined });
  }

  function replaceFile(source: 'baseline' | 'costSheet', files: FileList) {
    if (!files.length) return;
    const isBaseline = source === 'baseline';
    const file = files.length === 1 && (isBaseline ? /\.csv$/i : /\.(csv|xlsx)$/i).test(files[0].name) ? { file: files[0] } : undefined;
    change(isBaseline ? { baseline: file, baselineError: file ? undefined : 'Choose one catalog CSV.' }
      : { costSheet: file, costError: file ? undefined : 'Choose one landed cost and MAP file with a .csv or .xlsx extension.', worksheetName: undefined });
  }

  function updateTier(id: number, patch: Partial<WholesaleTier>) {
    change({ tiers: tiers.map((tier) => tier.id === id ? { ...tier, ...patch } : tier) });
  }

  function removeTier(id: number) {
    const remaining = tiers.filter((tier) => tier.id !== id);
    change({ tiers: remaining, shopifyTierId: shopifyTierId === id ? remaining[0].id : shopifyTierId });
    heading.current?.focus();
  }

  return (
    <div className="wholesale-setup" aria-label="Wholesale setup">
      <div className="wholesale-tools">
        <div className="price-store-platform">
          <span id={`${id}-platform`}>Store platform</span>
          <div className="price-platform-toggle" role="group" aria-labelledby={`${id}-platform`}>
            {Object.entries(STORE_PLATFORMS).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={platform === value} onClick={() => choosePlatform(value as StorePlatform)}>{label}</button>
            ))}
          </div>
        </div>
        <button className="button button-secondary" type="button" onClick={onDemo}>Load Synthetic 3-Tier Wholesale Demo</button>
      </div>
      {baseline?.synthetic ? <p className="field-help wholesale-demo-note">Synthetic 3-Tier Wholesale Demo · Northstar Supply · 3 sample SKUs</p> : null}
      <div className="price-files wholesale-files">
        <PriceFileInput side="wholesale-baseline" field={{ title: 'Store catalog CSV', formats: baselineFormats[platform],
          label: 'Choose store catalog CSV', accept: '.csv' }} inputTestId="wholesale-baseline-input" file={baseline}
          message={{ error: baselineError }} clearLabel="Clear store catalog CSV" onLoad={(files) => replaceFile('baseline', files)}
          onClear={() => change({ baseline: undefined, baselineError: undefined })} />
        <PriceFileInput side="wholesale-cost" field={costField} inputTestId="wholesale-cost-input" file={costSheet}
          message={{ reading: Boolean(workbook && !inspection), error: costError ?? inspection?.error }}
          clearLabel="Clear landed cost and MAP file" onLoad={(files) => replaceFile('costSheet', files)}
          onClear={() => change({ costSheet: undefined, costError: undefined, worksheetName: undefined })}
          worksheet={inspection?.names?.length ? <div className="price-sheet">
            <label htmlFor={`${id}-worksheet`}>Cost and MAP worksheet</label>
            <select id={`${id}-worksheet`} value={sheet} onChange={(event) => change({ worksheetName: event.currentTarget.value || undefined })}>
              {inspection.names.length > 1 ? <option value="">Choose a visible worksheet</option> : null}
              {inspection.names.map((name) => <option key={name}>{name}</option>)}
            </select>
          </div> : undefined} />
      </div>
      <fieldset className="wholesale-fieldset">
        <legend>Commercial terms</legend>
        <div className="price-fields wholesale-commercial">
          <label>Seller name<input required maxLength={120} value={draft.brandLabel} onChange={(event) => change({ brandLabel: event.currentTarget.value })} /></label>
          <label>Currency (ISO code)<input required maxLength={3} autoCapitalize="characters" spellCheck={false} value={draft.currency}
            onChange={(event) => change({ currency: event.currentTarget.value.toUpperCase() })} /></label>
          <label>Effective date<input type="date" required value={draft.effectiveDate} onChange={(event) => change({ effectiveDate: event.currentTarget.value })} /></label>
          <label>Minimum margin percent<input inputMode="decimal" value={draft.minimumMarginPercent ?? ''}
            onChange={(event) => change({ minimumMarginPercent: event.currentTarget.value })} /></label>
        </div>
        <label className="checkbox-label wholesale-map"><input type="checkbox" checked={Boolean(draft.requireMap)}
          onChange={(event) => change({ requireMap: event.currentTarget.checked })} /><span>Require MAP for every SKU</span></label>
        <p className="field-help">Minimum margin requires landed costs. Case pack and SKU minimums in the cost sheet are optional.</p>
      </fieldset>
      <section className="wholesale-fieldset" aria-labelledby={`${id}-tiers`}>
        <div className="wholesale-tier-heading">
          <div><h3 id={`${id}-tiers`} ref={heading} tabIndex={-1}>Wholesale tiers</h3>
            <p className="field-help">List tiers from the smallest minimum order to the largest. Unit prices must stay flat or decrease.</p></div>
          <button className="button button-secondary button-small" type="button" disabled={tiers.length >= 5} onClick={onAddTier}>Add tier</button>
        </div>
        <div className="wholesale-tier-stack">
          {tiers.map((tier, index) => {
            const fieldId = `${id}-tier-${tier.id}`;
            const position = index + 1;
            return <fieldset className="wholesale-tier" key={tier.id}>
              <legend>Tier {position}</legend>
              <div className="price-fields wholesale-tier-fields">
                <label>Tier {position} name<input required value={tier.tierName} maxLength={80} onChange={(event) => updateTier(tier.id, { tierName: event.currentTarget.value })} /></label>
                <div className="wholesale-field">
                  <label htmlFor={`${fieldId}-mode`}>Tier {position} pricing mode</label>
                  <select id={`${fieldId}-mode`} value={tier.discountMode} onChange={(event) => updateTier(tier.id, { discountMode: event.currentTarget.value as WholesaleTier['discountMode'] })}>
                    <option value="percent-off-retail">Percent off retail</option><option value="cost-plus-percent">Cost plus percent</option>
                  </select>
                </div>
                <label>Tier {position} percent<input inputMode="decimal" required value={tier.value} onChange={(event) => updateTier(tier.id, { value: event.currentTarget.value })} /></label>
                <label>Tier {position} minimum order<input inputMode="numeric" required value={tier.minOrderQty} onChange={(event) => updateTier(tier.id, { minOrderQty: event.currentTarget.value })} /></label>
                <div className="wholesale-field">
                  <label htmlFor={`${fieldId}-rounding`}>Tier {position} rounding</label>
                  <select id={`${fieldId}-rounding`} value={tier.rounding} onChange={(event) => updateTier(tier.id, { rounding: event.currentTarget.value as WholesaleTier['rounding'] })}>
                    {Object.entries(rounding).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </div>
                <button className="button button-secondary button-small" type="button" disabled={tiers.length === 1}
                  aria-label={`Remove tier ${position}`} onClick={() => removeTier(tier.id)}>Remove</button>
              </div>
            </fieldset>;
          })}
        </div>
      </section>
      <fieldset className="wholesale-fieldset">
        <legend>Shopify B2B destination</legend>
        <div className="price-fields wholesale-destination">
          <label>Shopify catalog title<input required maxLength={120} value={draft.shopifyCatalogTitle}
            onChange={(event) => change({ shopifyCatalogTitle: event.currentTarget.value })} /></label>
          <div className="wholesale-field">
            <label htmlFor={`${id}-shopify-tier`}>Shopify B2B tier</label>
            <select id={`${id}-shopify-tier`} value={shopifyTierId} onChange={(event) => change({ shopifyTierId: Number(event.currentTarget.value) })}>
              {tiers.map((tier, index) => <option key={tier.id} value={tier.id}>{tier.tierName.trim() || `Tier ${index + 1}`}</option>)}
            </select>
          </div>
        </div>
        <p className="field-help">Use the exact title of the destination catalog and choose the one tier to import into it.</p>
      </fieldset>
      <SignoffBrandingDrawer allowProfileLoad />
    </div>
  );
}
