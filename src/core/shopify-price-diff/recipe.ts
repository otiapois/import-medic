import { z } from 'zod';
import { defaultDropPercent, defaultIncreasePercent } from './mapping';
import { hasPricingInstructions, legacyPricingRuleSchema, preTierPricingRuleSchema, tieredPricingRuleSchema, validatePricingRule } from './pricing-rules';
import { hasDuplicateKeys, profileText, thresholds } from './settings-validation';
import { conflictPolicies } from './types';
import type { ColumnSelection, SupplierFile } from './types';

export const MAX_RECIPE_BYTES = 64 * 1024;

const column = profileText(512);
const recipeFields = {
  supplierLabel: profileText(120),
  joinKey: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('sku'), skuColumn: column }),
    z.strictObject({ type: z.literal('handle-options'), handleColumn: column, optionColumns: z.array(column).min(1).max(3) }),
  ]),
  priceColumn: column,
  compareAtColumn: column.nullable(),
  sheetName: profileText(128).nullable(),
  dropThresholdPercent: thresholds(100),
  increaseThresholdPercent: thresholds(100_000),
  formulaGuard: z.boolean(),
};
const modernPricing = { pricingRule: preTierPricingRuleSchema, storeLabel: profileText(120).optional(), fxRateNeedsRecheck: z.literal(true).optional() };
const batchSettings = {
  inventoryColumn: column.optional(), inventoryDropThresholdPercent: thresholds(100).optional(), conflictPolicy: z.enum(conflictPolicies).optional(),
};
const recipeSchema = z.discriminatedUnion('version', [
  z.strictObject({ version: z.literal(1), ...recipeFields }),
  z.strictObject({ version: z.literal(2), ...recipeFields, pricingRule: legacyPricingRuleSchema, storeLabel: profileText(120).optional() }),
  z.strictObject({ version: z.literal(3), ...recipeFields, ...modernPricing }),
  z.strictObject({ version: z.literal(4), ...recipeFields, ...modernPricing, ...batchSettings }),
  z.strictObject({ version: z.literal(5), ...recipeFields, ...modernPricing, ...batchSettings, pricingRule: tieredPricingRuleSchema }),
]);

export type SupplierRecipe = z.infer<typeof recipeSchema>;
export interface RecipeDiagnostic {
  code: string;
  message: string;
  field?: string;
  expected?: string;
}
export type RecipeResult<T> = { ok: true; value: T } | { ok: false; diagnostics: RecipeDiagnostic[] };

const failure = (code: string, message: string): RecipeResult<never> => ({ ok: false, diagnostics: [{ code, message }] });
const headerKey = (header: string) => header.trim().toLowerCase();

function validateRecipe(input: unknown): RecipeResult<SupplierRecipe> {
  if (typeof input === 'object' && input !== null && 'version' in input &&
    input.version !== 1 && input.version !== 3 && input.version !== 4 && input.version !== 5 && (input.version !== 2 || !('pricingRule' in input))) {
    return failure('unsupported-version', 'Use an ImportMedic supplier recipe with version 1, 2, 3, 4, or 5 and its required fields.');
  }
  const parsed = recipeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, diagnostics: parsed.error.issues.map(({ path, message }) => {
      const field = path.join('.');
      return { code: 'invalid-recipe-schema', field, message: field ? `${field} — ${message}` : message };
    }) };
  }
  const recipe = parsed.data;
  if (recipe.version === 3 || recipe.version === 4 || recipe.version === 5) {
    const { fx, compareAtRule } = recipe.pricingRule;
    if (recipe.version === 3 && !fx && !compareAtRule) return failure('invalid-recipe-schema', 'Version 3 requires FX conversion or an automatic compare-at rule.');
    if ((recipe.fxRateNeedsRecheck === true) !== (fx !== undefined)) {
      return failure('invalid-recipe-schema', 'An FX recipe must mark the saved rate for rechecking before use.');
    }
    if (compareAtRule && recipe.compareAtColumn !== null) {
      return failure('conflicting-compare-at-rules', 'Choose either a mapped supplier compare-at column or an automatic compare-at rule.');
    }
  }
  const join = recipe.joinKey;
  if ((recipe.version === 4 || recipe.version === 5) && recipe.inventoryDropThresholdPercent !== undefined && recipe.inventoryColumn === undefined) {
    return failure('invalid-recipe-schema', 'An inventory drop threshold requires a mapped inventory column.');
  }
  const names = [recipe.priceColumn, recipe.compareAtColumn, ...((recipe.version === 4 || recipe.version === 5) && recipe.inventoryColumn ? [recipe.inventoryColumn] : []), ...(join.type === 'sku' ? [join.skuColumn] : [join.handleColumn, ...join.optionColumns])];
  const selected = names.filter((name) => name !== null).map(headerKey);
  if (new Set(selected).size !== selected.length) return failure('duplicate-recipe-column', 'A source column can serve only one recipe field. Choose distinct columns.');
  return { ok: true, value: recipe };
}

export function parseSupplierRecipe(bytes: Uint8Array): RecipeResult<SupplierRecipe> {
  if (bytes.byteLength > MAX_RECIPE_BYTES) return failure('recipe-too-large', 'Choose an ImportMedic recipe smaller than 64 KB.');
  let json: string;
  let value: unknown;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(json);
  } catch {
    return failure('invalid-recipe-json', 'This file is not valid UTF-8 recipe JSON. Choose an exported ImportMedic supplier recipe.');
  }
  if (hasDuplicateKeys(json)) return failure('duplicate-recipe-property', 'Each recipe property must occur exactly once. Remove repeated JSON properties or export a fresh recipe.');
  return validateRecipe(value);
}

export function createSupplierRecipe(
  supplierLabel: string, headers: readonly string[], selection: ColumnSelection, sheetName: string | null, storeLabel?: string,
): RecipeResult<SupplierRecipe> {
  if (!selection.confirmed) return failure('unconfirmed-mapping', 'Confirm all supplier columns before saving a recipe.');
  const rule = selection.pricingRule;
  const pricingError = validatePricingRule(rule);
  if (pricingError) return failure('invalid-pricing-rule', pricingError);
  const { fx, compareAtRule, ...legacy } = rule ?? { mode: 'direct' };
  const label = storeLabel?.trim();
  const store = label ? { storeLabel: label } : {};
  const selected = (index: number | null | undefined) => index == null ? undefined : headers[index];
  const inventory = selected(selection.inventoryColumn);
  if (selection.inventoryColumn != null && inventory === undefined) return failure('invalid-inventory-column', 'Choose an available inventory quantity column before saving the recipe.');
  const useBatchSettings = rule?.mode === 'tiered-brackets' || selection.inventoryColumn != null || selection.conflictPolicy !== undefined;
  const pricingFields = useBatchSettings
    ? { version: rule?.mode === 'tiered-brackets' ? 5 : 4, pricingRule: rule ?? { mode: 'direct' }, ...store, ...(fx ? { fxRateNeedsRecheck: true } : {}),
      ...(inventory === undefined ? {} : { inventoryColumn: inventory }),
      ...(inventory !== undefined && selection.inventoryDropThresholdPercent !== undefined ? { inventoryDropThresholdPercent: selection.inventoryDropThresholdPercent } : {}),
      ...(selection.conflictPolicy === undefined ? {} : { conflictPolicy: selection.conflictPolicy }) }
    : fx || compareAtRule
    ? { version: 3, pricingRule: rule, ...store, ...(fx ? { fxRateNeedsRecheck: true } : {}) }
    : hasPricingInstructions(rule) || label
      ? { version: 2, pricingRule: legacy, ...store }
      : { version: 1 };
  const optionColumns = [...selection.optionColumns ?? []];
  while (optionColumns.length && optionColumns.at(-1) === null) optionColumns.pop();
  const joinKey = selection.joinKey === 'sku' ? { type: 'sku', skuColumn: selected(selection.skuColumn) } :
    selection.joinKey === 'handle-options' ? { type: 'handle-options', handleColumn: selected(selection.handleColumn), optionColumns: optionColumns.map(selected) } : undefined;
  return validateRecipe({
    ...pricingFields, supplierLabel: supplierLabel.trim(), joinKey, priceColumn: selected(selection.priceColumn),
    compareAtColumn: selection.compareAtColumn == null ? null : selected(selection.compareAtColumn), sheetName,
    dropThresholdPercent: selection.dropThresholdPercent ?? defaultDropPercent,
    increaseThresholdPercent: selection.increaseThresholdPercent ?? defaultIncreasePercent,
    formulaGuard: selection.formulaGuard === true,
  });
}

export const serializeSupplierRecipe = (recipe: SupplierRecipe): string => JSON.stringify(recipe, null, 2) + '\n';

export function applySupplierRecipe(
  recipe: SupplierRecipe, supplier: SupplierFile, preferredSheetIndex: number,
): RecipeResult<{ sheetIndex: number; selection: ColumnSelection }> {
  let sheetIndex = preferredSheetIndex;
  if (supplier.issues.some(({ blocking }) => blocking)) return failure('unsafe-supplier-file', 'Choose a valid supplier CSV or XLSX before applying this recipe.');
  if (recipe.sheetName !== null) {
    const name = recipe.sheetName;
    const sheets = /\.xlsx$/i.test(supplier.name) ? supplier.sheets : [];
    const matches = sheets.filter((sheet) => headerKey(sheet.name) === headerKey(name));
    if (matches.length !== 1 || matches[0].name !== name) {
      const code = matches.length > 1 ? 'recipe-ambiguous-sheet' : 'recipe-missing-sheet';
      const message = matches.length > 1 ? `The workbook has ambiguous matches for worksheet “${name}”.` : `This recipe requires the exact XLSX worksheet “${name}”.`;
      return { ok: false, diagnostics: [{ code, message, field: 'sheetName', expected: name }] };
    }
    sheetIndex = sheets.indexOf(matches[0]);
  }
  const sheet = supplier.sheets[sheetIndex];
  if (!sheet) return failure('missing-supplier-sheet', 'Choose a supplier worksheet before applying this recipe.');

  const diagnostics: RecipeDiagnostic[] = [];
  function match(field: string, name: string): number | undefined {
    const candidates = sheet.headers.flatMap((header, index) => headerKey(header) === headerKey(name) ? [index] : []);
    if (candidates.length === 1 && sheet.headers[candidates[0]] === name) return candidates[0];
    if (candidates.length > 1) {
      diagnostics.push({ code: 'recipe-ambiguous-column', field, expected: name, message: `Column “${name}” is ambiguous in worksheet “${sheet.name}”. Resolve duplicate headers and try again.` });
    } else {
      diagnostics.push({ code: 'recipe-missing-column', field, expected: name, message: `Column “${name}” is missing from worksheet “${sheet.name}”. Restore the exact header or choose and confirm a new mapping.` });
    }
  }
  const join = recipe.joinKey;
  const selection: ColumnSelection = {
    joinKey: join.type,
    ...(join.type === 'sku' ? { skuColumn: match('joinKey.skuColumn', join.skuColumn) } : {
      handleColumn: match('joinKey.handleColumn', join.handleColumn),
      optionColumns: join.optionColumns.map((name, index) => match(`joinKey.optionColumns.${index}`, name) ?? null),
    }),
    priceColumn: match('priceColumn', recipe.priceColumn),
    compareAtColumn: recipe.compareAtColumn === null ? null : match('compareAtColumn', recipe.compareAtColumn),
    dropThresholdPercent: recipe.dropThresholdPercent, increaseThresholdPercent: recipe.increaseThresholdPercent,
    formulaGuard: recipe.formulaGuard, confirmed: false, sameCurrencyConfirmed: false,
    ...(recipe.version !== 1 ? { pricingRule: recipe.pricingRule } : {}),
    ...(recipe.version === 3 || (recipe.version === 4 || recipe.version === 5) && recipe.pricingRule.fx ? { fxRateConfirmed: false } : {}),
    ...((recipe.version === 4 || recipe.version === 5) ? {
      inventoryColumn: recipe.inventoryColumn === undefined ? null : match('inventoryColumn', recipe.inventoryColumn),
      inventoryDropThresholdPercent: recipe.inventoryDropThresholdPercent,
      conflictPolicy: recipe.conflictPolicy,
    } : {}),
  };
  if (diagnostics.length) return { ok: false, diagnostics };
  const blocked = sheet.issues.find(({ blocking }) => blocking);
  if (blocked) return failure('unsafe-supplier-sheet', `Fix worksheet “${sheet.name}” before applying this recipe. ${blocked.message}`);
  return { ok: true, value: { sheetIndex, selection } };
}
