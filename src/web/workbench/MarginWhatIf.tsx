import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { WhatIfResult, WhatIfScenario } from '../../core/whatif/simulator';
import { formatMarginPercent } from './priceDisplay';

const CURRENT = { id: 'current', label: 'Current Rule' };
const QUICK = [
  { id: 'markup', label: '+5% Markup', markupPercent: '5' },
  { id: 'fx', label: 'FX +3% Buffer', fxBufferPercent: '3' },
  { id: 'rounding', label: '.95 Rounding', rounding: 'ending-95' },
] as const satisfies readonly (WhatIfScenario & { label: string })[];
const MAX_SCENARIOS = 6;
const DECIMAL_PERCENT = /^-?\d+(?:\.\d{1,2})?$/;
const numberFormat = new Intl.NumberFormat('en-US');

type Comparison = WhatIfScenario & { label: string };
type Simulate = (scenarios: WhatIfScenario[]) => Promise<WhatIfResult[]>;

function formatRetailDelta(value: string | null) {
  if (value === null) return 'Unknown';
  const cents = BigInt(value);
  const magnitude = cents < 0n ? -cents : cents;
  const sign = cents < 0n ? '\u2212' : cents > 0n ? '+' : '';
  return `${sign}${numberFormat.format(magnitude / 100n)}.${String(magnitude % 100n).padStart(2, '0')}`;
}

export default function MarginWhatIf({ compare, busy, onApply }: {
  compare: Simulate | null;
  busy: boolean;
  onApply: (result: WhatIfResult, label: string) => boolean;
}) {
  const [scenarios, setScenarios] = useState<Comparison[]>([CURRENT]);
  const [markup, setMarkup] = useState('');
  const [fx, setFx] = useState('');
  const [formError, setFormError] = useState('');
  const [applied, setApplied] = useState('');
  const nextCustom = useRef(0);
  const status = useRef<HTMLParagraphElement>(null);
  const [checked, setChecked] = useState<{
    compare: Simulate;
    scenarios: Comparison[];
    results?: WhatIfResult[];
    error?: string;
  }>();

  useEffect(() => {
    if (!compare) return;
    let current = true;
    void compare(scenarios.map(({ label, ...scenario }) => scenario)).then((results) => {
      if (current) setChecked({ compare, scenarios, results });
    }, (error: unknown) => {
      if (current) setChecked({ compare, scenarios, error: error instanceof Error ? error.message : 'The scenario comparison could not finish.' });
    });
    return () => { current = false; };
  }, [compare, scenarios]);

  const current = checked && checked.compare === compare && checked.scenarios === scenarios ? checked : undefined;
  const full = scenarios.length >= MAX_SCENARIOS;

  function toggle(scenario: Comparison) {
    setFormError('');
    setScenarios((items) => items.some(({ id }) => id === scenario.id)
      ? items.filter(({ id }) => id !== scenario.id)
      : items.length < MAX_SCENARIOS ? [...items, scenario] : items);
  }

  function addCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (full) return;
    if ([markup, fx].some((value) => value && (!DECIMAL_PERCENT.test(value) || Number(value) < -99.99 || Number(value) > 100))) {
      setFormError('Use plain percentages from −99.99 to 100 with at most two decimal places.');
      return;
    }
    if (!Number(markup) && !Number(fx)) {
      setFormError('Enter a nonzero markup or FX adjustment.');
      return;
    }
    const index = ++nextCustom.current;
    toggle({
      id: `custom-${index}`, label: `Custom ${index}`,
      ...(Number(markup) ? { markupPercent: markup } : {}),
      ...(Number(fx) ? { fxBufferPercent: fx } : {}),
    });
    setMarkup('');
    setFx('');
  }

  return (
    <div className="what-if-body">
      <p className="field-help">Compare up to six rules against the same baseline. Retail impact is the sum of price changes in store or market currency. Margin uses SKUs with known cost.</p>
      <div className="what-if-quick" role="group" aria-label="Quick scenarios">
        {QUICK.map((scenario) => {
          const included = scenarios.some(({ id }) => id === scenario.id);
          return (
            <button type="button" key={scenario.id} className="button button-secondary button-small" aria-pressed={included}
              disabled={full && !included} onClick={() => toggle(scenario)}>{scenario.label}</button>
          );
        })}
      </div>
      <form className="what-if-custom" onSubmit={addCustom}>
        <label>Custom markup (%)
          <input type="number" inputMode="decimal" min="-99.99" max="100" step="0.01" value={markup} onChange={(event) => setMarkup(event.currentTarget.value)} />
        </label>
        <label>Custom FX buffer (%)
          <input type="number" inputMode="decimal" min="-99.99" max="100" step="0.01" value={fx} onChange={(event) => setFx(event.currentTarget.value)} />
        </label>
        <button type="submit" className="button button-secondary button-small" disabled={full}>Add custom scenario</button>
      </form>
      <p className="field-help">Custom adjustments accept −99.99% to +100%. FX buffers use the confirmed manual rate.</p>
      {formError ? <p className="pricing-error" role="alert">{formError}</p> : null}
      <p className="what-if-status" role="status" ref={status} tabIndex={-1}>
        {full ? 'Six scenarios selected. Remove one to add another. ' : null}
        {applied ? `Applied ${applied}. ` : null}
        {!compare ? 'Waiting for the current files and confirmed columns.' : !current ? 'Comparing scenarios…' : current.error ?? 'Scenario comparison ready.'}
      </p>
      <div className="what-if-results" aria-label="Scenario comparisons">
        {scenarios.map((scenario) => {
          const { id, label, markupPercent, fxBufferPercent } = scenario;
          const result = current?.results?.find((candidate) => candidate.id === id);
          const custom = id.startsWith('custom-');
          const adjustedRates = fxBufferPercent ? result?.suppliers.flatMap(({ pricingRule }) => {
            const rate = pricingRule?.fx;
            return rate ? [`${rate.sourceCurrency} → ${rate.storeCurrency} @ ${rate.fxRate}`] : [];
          }) : undefined;
          return (
            <article key={id} className="what-if-result" aria-label={label}>
              <h3>{label}</h3>
              {custom ? (
                <p className="field-help">
                  {[markupPercent ? `Markup ${markupPercent}%` : '', fxBufferPercent ? `FX buffer ${fxBufferPercent}%` : ''].filter(Boolean).join(' · ')}
                </p>
              ) : null}
              {result && result.status !== 'invalid' ? (
                <dl className="what-if-metrics">
                  <div><dt>Avg Margin %</dt><dd title={result.averageMarginPercent === null ? undefined : `${result.averageMarginPercent}%`}>
                    {formatMarginPercent(result.averageMarginPercent)}
                  </dd></div>
                  <div><dt>Negative Margin SKUs</dt><dd>{numberFormat.format(result.negativeMarginSkuCount)}</dd></div>
                  <div><dt>Total Retail Impact</dt><dd data-retail-delta-cents={result.totalRetailDeltaCents ?? undefined}>{formatRetailDelta(result.totalRetailDeltaCents)}</dd></div>
                  <div><dt>Changed SKUs</dt><dd>{numberFormat.format(result.changedSkuCount)}</dd></div>
                  <div><dt>Sub-floor SKUs</dt><dd>{numberFormat.format(result.subFloorSkuCount)}</dd></div>
                  <div><dt>Lowest-margin SKU</dt><dd>{result.minMarginSku ?? 'Unknown'}</dd></div>
                </dl>
              ) : null}
              {result?.message ? <p className="field-help">{result.message}</p> : null}
              {adjustedRates?.length ? <p className="field-help">FX {adjustedRates.join(' · ')}</p> : null}
              {result?.status === 'review' && !result.message ? <p className="field-help">This scenario still requires review.</p> : null}
              {result?.status === 'no-changes' ? <p className="field-help">No update rows under this rule.</p> : null}
              {id !== CURRENT.id ? (
                <div className="what-if-result-actions">
                  <button type="button" className="button button-primary button-small" disabled={busy || !result?.canApply}
                    onClick={() => {
                      if (result?.canApply && onApply(result, label)) {
                        setApplied(label);
                        status.current?.focus({ preventScroll: true });
                      }
                    }}>Apply Scenario</button>
                  {custom ? <button type="button" className="text-button" onClick={() => toggle(scenario)}>Remove {label}</button> : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
