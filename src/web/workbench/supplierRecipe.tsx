import { useId, useState } from 'react';
import type { ColumnSelection } from '../../core/shopify-price-diff/types';
import type { SupplierRecipe } from '../../core/shopify-price-diff/recipe';

export type MappingField = 'skuColumn' | 'handleColumn' | 'option1' | 'option2' | 'option3' | 'priceColumn' | 'compareAtColumn' | 'inventoryColumn';

export function recipeRemapping(recipe: SupplierRecipe, headers: readonly string[]) {
  const missing: MappingField[] = [];
  function match(field: MappingField, header: string) {
    const index = headers.indexOf(header);
    const key = header.trim().toLowerCase();
    if (index !== -1 && headers.filter((candidate) => candidate.trim().toLowerCase() === key).length === 1) return index;
    missing.push(field);
    return undefined;
  }

  const join = recipe.joinKey;
  const selection: ColumnSelection = {
    joinKey: join.type,
    priceColumn: match('priceColumn', recipe.priceColumn),
    compareAtColumn: recipe.compareAtColumn === null ? null : match('compareAtColumn', recipe.compareAtColumn),
    dropThresholdPercent: recipe.dropThresholdPercent,
    increaseThresholdPercent: recipe.increaseThresholdPercent,
    formulaGuard: recipe.formulaGuard,
    ...(recipe.version !== 1 ? { pricingRule: recipe.pricingRule } : {}),
    ...(recipe.version === 4 || recipe.version === 5 ? {
      inventoryColumn: recipe.inventoryColumn == null ? null : match('inventoryColumn', recipe.inventoryColumn),
      inventoryDropThresholdPercent: recipe.inventoryDropThresholdPercent,
      conflictPolicy: recipe.conflictPolicy,
    } : {}),
    confirmed: false,
    sameCurrencyConfirmed: false,
    fxRateConfirmed: false,
  };
  if (join.type === 'sku') {
    selection.skuColumn = match('skuColumn', join.skuColumn);
  } else {
    selection.handleColumn = match('handleColumn', join.handleColumn);
    const fields = ['option1', 'option2', 'option3'] as const;
    selection.optionColumns = join.optionColumns.map((name, index) => match(fields[index], name) ?? null);
  }
  return { selection, missing };
}

export function SupplierRecipeBar({ recipe, status, diagnostics, defaultLabel, busy, canSave, onLoad, onClear, onSave }: {
  recipe: SupplierRecipe | null;
  status: string;
  diagnostics: readonly string[];
  defaultLabel?: string;
  busy: boolean;
  canSave: boolean;
  onLoad: (file: File) => void;
  onClear: () => void;
  onSave: (label: string, storeLabel?: string) => void;
}) {
  const id = useId();
  const [labelEdit, setLabel] = useState<string>();
  const [storeLabel, setStoreLabel] = useState(recipe && recipe.version !== 1 ? recipe.storeLabel ?? '' : '');
  const label = labelEdit ?? recipe?.supplierLabel ?? defaultLabel ?? '';
  const hasRecipe = recipe || diagnostics.length > 0;
  return (
    <section className="recipe-bar" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>Supplier recipe</h3>
      <div className="recipe-controls">
        <div className="file-picker">
          <input className="sr-only" id={`${id}-load`} type="file" accept=".json,application/json" disabled={busy} onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) onLoad(file);
          }} />
          <label className="button button-secondary button-small" htmlFor={`${id}-load`}>Load Supplier Recipe (.json)</label>
        </div>
        <form className="recipe-save" onSubmit={(event) => {
          event.preventDefault();
          onSave(label.trim(), storeLabel.trim() || undefined);
        }}>
          <label>Supplier label<input value={label} maxLength={120} onChange={(event) => setLabel(event.currentTarget.value)} required /></label>
          <label>Store label (optional)<input value={storeLabel} maxLength={120} onChange={(event) => setStoreLabel(event.currentTarget.value)} /></label>
          <button type="submit" className="button button-secondary button-small" disabled={busy || !canSave || !label.trim()}>Save Supplier Recipe (.json)</button>
        </form>
        {hasRecipe ? <button type="button" className="text-button" disabled={busy} onClick={onClear}>Use manual mapping</button> : null}
      </div>
      <p className="field-help" role="status">{status || 'Recipes save column names, pricing settings, and safeguards in a local JSON file.'}</p>
      {diagnostics.length ? <ul className="recipe-diagnostics" role="alert">{diagnostics.map((message, index) => <li key={index}>{message}</li>)}</ul> : null}
    </section>
  );
}
