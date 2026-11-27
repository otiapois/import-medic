import { useEffect, useId, useRef, useState } from 'react';
import type { ColumnSelection } from '../../core/shopify-price-diff/types';
import {
  createWorkspaceProfile, serializeWorkspaceProfile,
} from '../../core/shopify-price-diff/workspace-profile';
import type { StorePlatform, WorkspaceProfile } from '../../core/shopify-price-diff/workspace-profile';
import { downloadFile } from './downloads';
import { SignoffBrandingDrawer, useSignoffBranding } from './SignoffBranding';
import { readWorkspaceProfileFile } from './workspaceProfileFile';

export const STORE_PLATFORMS = { shopify: 'Shopify', woocommerce: 'WooCommerce', bigcommerce: 'BigCommerce' } as const satisfies Record<StorePlatform, string>;

export function withWorkspaceDefaults(selection: ColumnSelection, profile: WorkspaceProfile): ColumnSelection {
  const { dropThresholdPercent, increaseThresholdPercent, inventoryDropThresholdPercent, pricingRule: tiered } = profile;
  if (!tiered && dropThresholdPercent === undefined && increaseThresholdPercent === undefined && inventoryDropThresholdPercent === undefined) return selection;
  const rule = selection.pricingRule;
  const fx = rule?.fx;
  const compareAtRule = rule?.compareAtRule;
  const pricingRule = tiered ? {
    ...tiered,
    ...(fx ? { fx: fx.storeCurrency === profile.storeCurrency ? fx : { ...fx, storeCurrency: profile.storeCurrency, fxRate: '' } } : {}),
    ...(compareAtRule ? { compareAtRule } : {}),
  } : rule;
  return {
    ...selection,
    dropThresholdPercent: dropThresholdPercent ?? selection.dropThresholdPercent,
    increaseThresholdPercent: increaseThresholdPercent ?? selection.increaseThresholdPercent,
    inventoryDropThresholdPercent: inventoryDropThresholdPercent ?? selection.inventoryDropThresholdPercent,
    ...(pricingRule ? { pricingRule } : {}),
    confirmed: false,
    sameCurrencyConfirmed: false,
    fxRateConfirmed: false,
  };
}

export function WorkspaceProfileControls({ platform, profile, selection, onApply }: {
  platform: StorePlatform;
  profile: WorkspaceProfile | null;
  selection: ColumnSelection | undefined;
  onApply: (value: WorkspaceProfile) => void;
}) {
  const id = useId();
  const attempt = useRef(0);
  const [open, setOpen] = useState(false);
  const [storeName, setStoreName] = useState(profile?.storeName ?? '');
  const [currencyEdit, setCurrency] = useState<string>();
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const { branding, restoreBranding } = useSignoffBranding();
  const storeCurrency = currencyEdit ?? selection?.pricingRule?.fx?.storeCurrency ?? profile?.storeCurrency ?? '';
  const label = STORE_PLATFORMS[platform];

  useEffect(() => () => { attempt.current += 1; }, []);

  async function load(file: File) {
    const current = ++attempt.current;
    setError('');
    setStatus('');
    let incoming: WorkspaceProfile;
    try {
      incoming = await readWorkspaceProfileFile(file);
    } catch (error) {
      if (current === attempt.current) setError(error instanceof Error ? error.message : 'The local workspace profile could not be read.');
      return;
    }
    if (current !== attempt.current) return;
    if (incoming.platform !== platform) {
      const incomingLabel = STORE_PLATFORMS[incoming.platform];
      setError(`This profile is for ${incomingLabel}. Select ${incomingLabel} in Store platform to use it.`);
      return;
    }
    onApply(incoming);
    restoreBranding(incoming.branding);
    setStoreName(incoming.storeName);
    setCurrency(incoming.storeCurrency);
    setStatus(`Workspace profile loaded: ${incoming.storeName} · ${label} · ${incoming.storeCurrency}.`);
  }

  function save() {
    attempt.current += 1;
    setStatus('');
    setError('');
    const rule = selection?.pricingRule ?? profile?.pricingRule;
    const pricingRule = rule?.mode === 'tiered-brackets' ? {
      mode: rule.mode, brackets: rule.brackets, rounding: rule.rounding, minimumRetail: rule.minimumRetail,
    } : undefined;
    const result = createWorkspaceProfile({
      version: 1,
      storeName: storeName.trim(),
      platform,
      storeCurrency,
      dropThresholdPercent: selection?.dropThresholdPercent ?? profile?.dropThresholdPercent ?? 50,
      increaseThresholdPercent: selection?.increaseThresholdPercent ?? profile?.increaseThresholdPercent ?? 200,
      inventoryDropThresholdPercent: selection?.inventoryDropThresholdPercent ?? profile?.inventoryDropThresholdPercent ?? 80,
      ...(pricingRule ? { pricingRule } : {}),
      ...(branding ? { branding } : {}),
    });
    if (!result.ok) {
      setError(result.diagnostics.map(({ message }) => message).join(' '));
      return;
    }
    const slug = result.value.storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    downloadFile(`${slug || platform}-workspace-profile.json`, serializeWorkspaceProfile(result.value), 'application/json');
    setStatus('Workspace profile saved as a local JSON file.');
  }

  return (
    <details className="workspace-profile recipe-bar" onToggle={(event) => {
      if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
    }}>
      <summary>Workspace profile</summary>
      {open ? (
        <>
          <p className="field-help">Save {label} store defaults and the first supplier sheet’s guardrails and tiered pricing. Supplier recipes keep their own settings. Files and rates stay out of the profile.</p>
          <div className="recipe-controls">
            <div className="file-picker">
              <input className="sr-only" id={`${id}-load`} type="file" accept=".json,application/json" onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) void load(file);
              }} />
              <label className="button button-secondary button-small" htmlFor={`${id}-load`}>Load Workspace Profile (.json)</label>
            </div>
            <form className="recipe-save" onSubmit={(event) => { event.preventDefault(); save(); }}>
              <label>Store name<input required value={storeName} maxLength={120} onChange={(event) => setStoreName(event.currentTarget.value)} /></label>
              <label>Workspace store currency<input required value={storeCurrency} maxLength={3} placeholder="USD" autoCapitalize="characters" spellCheck={false}
                onChange={(event) => setCurrency(event.currentTarget.value.toUpperCase())} /></label>
              <button type="submit" className="button button-secondary button-small">Save Workspace Profile (.json)</button>
            </form>
          </div>
          <SignoffBrandingDrawer />
          {status ? <p className="field-help" role="status">{status}</p> : null}
          {error ? <p className="recipe-diagnostics" role="alert">{error}</p> : null}
        </>
      ) : null}
    </details>
  );
}
