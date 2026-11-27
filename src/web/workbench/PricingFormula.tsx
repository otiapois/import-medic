import { useEffect, useId, useMemo, useState } from 'react';
import type { ShopifyMarket } from '../../core/shopify-price-diff/markets';
import { readAmount } from '../../core/shopify-price-diff/prices';
import { hasPricingInstructions, previewTierBrackets } from '../../core/shopify-price-diff/pricing-rules';
import type { PricingBracket, PricingRule } from '../../core/shopify-price-diff/pricing-rules';
import type { ColumnSelection } from '../../core/shopify-price-diff/types';
import type { WorkbenchWorker } from '../../core/worker/client';
import type { WorkerResult } from '../../core/worker/protocol';

const DIRECT_PRICE: PricingRule = { mode: 'direct' };
const DEFAULT_BRACKETS: PricingBracket[] = [
  { upTo: '20.00', mode: 'multiplier', multiplier: '2.5' },
  { upTo: '100.00', mode: 'multiplier', multiplier: '2.0' },
  { upTo: null, mode: 'multiplier', multiplier: '1.65' },
];

const MODES: Record<PricingRule['mode'], string> = {
  direct: 'Direct price',
  multiplier: 'Multiplier',
  'percent-markup': 'Markup %',
  'target-margin': 'Target margin %',
  'tiered-brackets': 'Tiered cost brackets',
};

const ROUNDING: Record<NonNullable<PricingRule['rounding']>, string> = {
  none: 'Exact 2 decimals',
  'ending-99': 'End in .99',
  'ending-95': 'End in .95',
  'nearest-whole': 'Nearest whole (.00)',
};

export function PricingFormula({ selection, error, worker, supplierId, sheetIndex, workspaceCurrency, market, secondaryPriceLabel, canAutoCompareAt, onChange }: {
  selection: ColumnSelection;
  error: string | null;
  worker: WorkbenchWorker | null;
  supplierId: string;
  sheetIndex: number;
  workspaceCurrency?: string;
  market?: ShopifyMarket;
  secondaryPriceLabel: string;
  canAutoCompareAt: boolean;
  onChange: (rule: PricingRule) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const { priceColumn, confirmed, pricingRule } = selection;
  const rule = pricingRule ?? DIRECT_PRICE;
  const request = useMemo(() => ({
    type: 'priceFormulaPreview' as const,
    supplierId,
    sheetIndex,
    selection,
    ...(market ? { market: market.name } : {}),
  }), [selection, sheetIndex, supplierId, market]);
  const [preview, setPreview] = useState<{ request: typeof request; value?: WorkerResult<typeof request> }>();
  const canPreview = Boolean(open && worker && !error && priceColumn !== undefined);
  useEffect(() => {
    if (!worker || !canPreview) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void worker.request(request).then((value) => {
        if (current) setPreview({ request, value });
      }, () => {
        if (current) setPreview({ request });
      });
    }, 120);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [worker, canPreview, request]);

  const result = preview?.request === request ? preview : undefined;
  const { fx, ...ruleWithoutFx } = rule;
  const { compareAtRule, ...ruleWithoutCompareAt } = rule;
  const { retailAdjustmentPercent, ...ruleWithoutRetailAdjustment } = rule;
  const canKeepPrecision = rule.mode === 'direct' && rule.minimumRetail === undefined && retailAdjustmentPercent === undefined && !fx;
  const rounding = rule.rounding ?? (canKeepPrecision ? '' : 'none');

  function changeMode(mode: PricingRule['mode']) {
    const options = {
      rounding: rule.rounding, minimumRetail: rule.minimumRetail,
      ...(retailAdjustmentPercent === undefined ? {} : { retailAdjustmentPercent }),
      ...(fx ? { fx } : {}), ...(compareAtRule ? { compareAtRule } : {}),
    };
    switch (mode) {
      case 'direct': onChange({ ...options, mode }); break;
      case 'multiplier': onChange({ ...options, mode, multiplier: '' }); break;
      case 'percent-markup': onChange({ ...options, mode, markupPercent: '' }); break;
      case 'target-margin': onChange({ ...options, mode, marginPercent: '' }); break;
      case 'tiered-brackets': onChange({ ...options, mode, brackets: DEFAULT_BRACKETS }); break;
    }
  }

  return (
    <details className="pricing-formula" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><span>Pricing formula &amp; rounding</span>
        {hasPricingInstructions(rule) ? <span className={`issue-badge pricing-active ${confirmed ? 'badge-fixed' : 'badge-review'}`}>
          {confirmed ? 'Active' : 'Needs confirmation'} · {MODES[rule.mode]}{rounding ? ` · ${ROUNDING[rounding]}` : ''}
          {retailAdjustmentPercent === undefined ? '' : ` · Retail adjustment ${retailAdjustmentPercent}%`}
        </span> : null}
      </summary>
      <p id={`${id}-help`} className="field-help">Use plain decimals with a period, such as 2.2 or 3.00. Changes clear row decisions. Select Confirm columns to apply these settings.</p>
      <fieldset className="pricing-fields" aria-label="Pricing settings" aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}>
        <label><span id={`${id}-mode`}>Pricing mode</span>
          <select aria-labelledby={`${id}-mode`} value={rule.mode} onChange={(event) => changeMode(event.currentTarget.value as PricingRule['mode'])}>
            {Object.entries(MODES).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
          </select>
        </label>
        {rule.mode === 'multiplier' ? (
          <>
            <PricingAmount label="Multiplier" value={rule.multiplier} placeholder="2.2" onChange={(multiplier) => onChange({ ...rule, multiplier })} />
            <PricingAmount label="Fixed fee (optional)" value={rule.fixedFee ?? ''} placeholder="3.00" onChange={(fixedFee) => onChange({ ...rule, fixedFee: fixedFee || undefined })} />
          </>
        ) : null}
        {rule.mode === 'percent-markup' ? <PricingAmount label="Markup (%)" value={rule.markupPercent} placeholder="35" onChange={(markupPercent) => onChange({ ...rule, markupPercent })} /> : null}
        {rule.mode === 'target-margin' ? <PricingAmount label="Target margin (%)" value={rule.marginPercent} placeholder="45" onChange={(marginPercent) => onChange({ ...rule, marginPercent })} /> : null}
        <label><span id={`${id}-rounding`}>Rounding</span>
          <select aria-labelledby={`${id}-rounding`} value={rounding} onChange={(event) => onChange({ ...rule, rounding: (event.currentTarget.value || undefined) as PricingRule['rounding'] })}>
            {canKeepPrecision ? <option value="">Keep supplier precision</option> : null}
            {Object.entries(ROUNDING).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
          </select>
        </label>
        <PricingAmount label="Minimum retail price (optional)" value={rule.minimumRetail ?? ''} placeholder="9.99" onChange={(minimumRetail) => onChange({ ...rule, minimumRetail: minimumRetail || undefined })} />
        {retailAdjustmentPercent === undefined ? null : (
          <PricingAmount label="Retail adjustment (%)" value={retailAdjustmentPercent} placeholder="5"
            onChange={(value) => onChange(value ? { ...rule, retailAdjustmentPercent: value } : ruleWithoutRetailAdjustment)} />
        )}
      </fieldset>
      {rule.mode === 'tiered-brackets' ? <TierBrackets rule={rule} error={error} onChange={(brackets) => onChange({ ...rule, brackets })} /> : null}
      <div className="pricing-option">
        <label className="checkbox-label">
          <input type="checkbox" checked={Boolean(fx)} aria-describedby={`${id}-fx-help`} onChange={(event) => onChange(event.currentTarget.checked
            ? { ...rule, fx: { sourceCurrency: '', storeCurrency: market ? '' : workspaceCurrency ?? '', fxRate: '' } } : ruleWithoutFx)} />
          <span>Convert supplier currency (manual rate)</span>
        </label>
        {fx ? (
          <fieldset className="pricing-fields" aria-label="Manual FX settings" aria-describedby={`${id}-fx-help`}>
            <label>Source currency code
              <input type="text" value={fx.sourceCurrency} placeholder="EUR" maxLength={3} spellCheck={false} autoCapitalize="characters"
                onChange={(event) => onChange({ ...rule, fx: { ...fx, sourceCurrency: event.currentTarget.value.toUpperCase() } })} />
            </label>
            <label>{market ? 'Target market currency code' : 'Store currency code'}
              <input type="text" value={fx.storeCurrency} placeholder={market ? 'Market currency' : 'USD'} maxLength={3} spellCheck={false} autoCapitalize="characters"
                onChange={(event) => onChange({ ...rule, fx: { ...fx, storeCurrency: event.currentTarget.value.toUpperCase() } })} />
            </label>
            <PricingAmount label="Exact rate" value={fx.fxRate} placeholder="1.0850" onChange={(fxRate) => onChange({ ...rule, fx: { ...fx, fxRate } })} />
          </fieldset>
        ) : null}
        <p id={`${id}-fx-help`} className="field-help">{market
          ? <>Enter currency units for <code>{market.priceHeader}</code> per one supplier currency unit.</>
          : 'Enter store currency units per one supplier currency unit.'}{' '}ImportMedic applies your rate locally before pricing and rounding. No exchange rates are fetched.
          {fx && typeof selection.compareAtColumn === 'number' ? <> A mapped {market ? <code>{secondaryPriceLabel}</code> : secondaryPriceLabel.toLowerCase()} amount uses the same rate and rounds to cents.</> : null}
        </p>
      </div>
      {canAutoCompareAt ? (
        <div className="pricing-option">
          <label className="checkbox-label">
            <input type="checkbox" checked={Boolean(compareAtRule)} aria-describedby={`${id}-compare-help`} onChange={(event) => onChange(event.currentTarget.checked
              ? { ...rule, compareAtRule: { multiplier: '' } } : ruleWithoutCompareAt)} />
            <span>Calculate compare-at price automatically</span>
          </label>
          {compareAtRule ? (
            <div className="pricing-fields">
              <PricingAmount label="Compare-at multiplier" value={compareAtRule.multiplier} placeholder="1.25"
                onChange={(multiplier) => onChange({ ...rule, compareAtRule: { multiplier } })} />
            </div>
          ) : null}
          <p id={`${id}-compare-help`} className="field-help">Multiplies the final retail price and applies the selected rounding. The result must be higher than the retail price.</p>
        </div>
      ) : null}
      {error ? <p className="pricing-error" id={`${id}-error`} role="alert">{error}</p> : null}
      {!error ? (
        <p className="pricing-preview" role="status">
          {canPreview && result?.value ? (
            <>
              Supplier row {result.value.supplierRow}{' '}
              {result.value.fxApplied ? (
                <span data-testid="fx-pricing-preview">
                  <code>{readAmount(result.value.supplierPrice)?.text ?? result.value.supplierPrice} {result.value.fxApplied.sourceCurrency} × {result.value.fxApplied.fxRate}</code> →{' '}
                  <strong><code>{result.value.computedPrice} {result.value.fxApplied.storeCurrency}</code></strong>
                </span>
              ) : <><code>{result.value.supplierPrice}</code> → <strong><code>{result.value.computedPrice}</code></strong></>}
              {result.value.matchedTier ? <span className="pricing-compare-preview">{result.value.matchedTier}</span> : null}
              {result.value.computedCompareAtPrice ? <span className="pricing-compare-preview" data-testid="compare-at-pricing-preview">
                {secondaryPriceLabel} <strong><code>{result.value.computedCompareAtPrice}{result.value.fxApplied ? ` ${result.value.fxApplied.storeCurrency}` : ''}</code></strong>
              </span> : null}
            </>
          ) : priceColumn === undefined ? 'Choose a supplier price column to preview its price.'
            : !canPreview || !result ? 'Reading the supplier price preview…'
              : result.value === null ? 'No matching supplier price can be previewed with these settings.'
                : 'The supplier price preview could not be read.'}
        </p>
      ) : null}
    </details>
  );
}

function TierBrackets({ rule, error, onChange }: {
  rule: Extract<PricingRule, { mode: 'tiered-brackets' }>;
  error: string | null;
  onChange: (brackets: PricingBracket[]) => void;
}) {
  const id = useId();
  const { brackets } = rule;
  const examples = !error ? previewTierBrackets(rule) : [];
  function changeTier(index: number, tier: PricingBracket) {
    onChange(brackets.map((current, position) => position === index ? tier : current));
  }
  return (
    <fieldset className="pricing-brackets" aria-describedby={`${id}-help`}>
      <legend>Cost brackets</legend>
      <p id={`${id}-help`} className="field-help">Set 2 to 6 tiers in ascending order. Upper costs are inclusive and in store currency after FX. The last tier covers all higher costs.</p>
      {brackets.map((tier, index) => {
        const label = `Tier ${index + 1}`;
        const example = examples[index];
        const last = index === brackets.length - 1;
        return (
          <fieldset className="pricing-bracket" key={index}>
            <legend>{label}</legend>
            <div className="pricing-fields pricing-bracket-fields">
              {last ? <p className="field-help pricing-catch-all">All costs above the previous tier</p> : (
                <PricingAmount label={`${label} upper cost (inclusive)`} value={tier.upTo ?? ''} placeholder="20.00"
                  onChange={(upTo) => changeTier(index, { ...tier, upTo })} />
              )}
              <label>{label} calculation
                <select aria-label={`${label} calculation`} value={tier.mode} onChange={(event) => {
                  const { upTo, fixedFee } = tier;
                  changeTier(index, event.currentTarget.value === 'multiplier'
                    ? { upTo, fixedFee, mode: 'multiplier', multiplier: '' }
                    : { upTo, fixedFee, mode: 'percent-markup', markupPercent: '' });
                }}>
                  <option value="multiplier">Multiplier</option>
                  <option value="percent-markup">Markup %</option>
                </select>
              </label>
              {tier.mode === 'multiplier' ? (
                <PricingAmount label={`${label} multiplier`} value={tier.multiplier} placeholder="2.5"
                  onChange={(multiplier) => changeTier(index, { ...tier, multiplier })} />
              ) : (
                <PricingAmount label={`${label} markup (%)`} value={tier.markupPercent} placeholder="35"
                  onChange={(markupPercent) => changeTier(index, { ...tier, markupPercent })} />
              )}
              <PricingAmount label={`${label} fixed fee (optional)`} value={tier.fixedFee ?? ''} placeholder="3.00"
                onChange={(fixedFee) => changeTier(index, { ...tier, fixedFee: fixedFee || undefined })} />
              <button type="button" className="button button-secondary button-small" disabled={brackets.length <= 2}
                onClick={() => {
                  const remaining = brackets.filter((_, position) => index !== position);
                  onChange(remaining.map((current, position) => position === remaining.length - 1 ? { ...current, upTo: null } : current));
                }}>Remove {label.toLowerCase()}</button>
            </div>
            {example ? <p className="pricing-preview" role="status">
              {example.matchedTier} · Example cost <code>{example.sampleCost}</code> → <strong><code>{example.computedPrice ?? 'No valid retail price'}</code></strong>
            </p> : null}
          </fieldset>
        );
      })}
      <button type="button" className="button button-secondary button-small" disabled={brackets.length >= 6} onClick={() => onChange([
        ...brackets.slice(0, -1), { upTo: '', mode: 'multiplier', multiplier: '' }, brackets[brackets.length - 1],
      ])}>Add tier</button>
    </fieldset>
  );
}

function PricingAmount({ label, placeholder, value, onChange }: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return <label>{label}<input type="text" inputMode="decimal" placeholder={placeholder} value={value} onChange={(event) => onChange(event.currentTarget.value)} /></label>;
}
