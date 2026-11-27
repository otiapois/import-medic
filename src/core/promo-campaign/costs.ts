import { currencyColumns, explicitlyWholesale, mappingLabel } from '../shopify-price-diff/mapping';
import { baselinePrice, readAmount } from '../shopify-price-diff/prices';
import { parseSupplier } from '../shopify-price-diff/source';
import type { Baseline, SourceCell, Variant } from '../shopify-price-diff/types';
import { isScientific } from '../shopify-price-diff/xlsx';
import type { PromoCampaignIssue, PromoCampaignRow } from './types';

const costAliases = (header: string) => explicitlyWholesale(header) || ['cost per item', 'cost price'].includes(mappingLabel(header));
type CostSource = NonNullable<PromoCampaignRow['costSource']>;
interface CostCell { cell: SourceCell | undefined; source: CostSource; hasCurrency?: boolean }

export function campaignCosts(baseline: Baseline, sheetBytes: Uint8Array | undefined, issues: PromoCampaignIssue[]) {
  const baselineColumns = baseline.headers.flatMap((header, index) => costAliases(header) ? [index] : []);
  const bySku = new Map<string, CostCell>();
  if (baselineColumns.length > 1) {
    issues.push({ code: 'ambiguous-baseline-cost', message: 'Use a baseline with a single cost column to check margins.', severity: 'hold', source: 'baseline' });
  }
  if (sheetBytes !== undefined) {
    const isWorkbook = sheetBytes[0] === 0x50 && sheetBytes[1] === 0x4b && sheetBytes[2] === 3 && sheetBytes[3] === 4;
    const parsed = parseSupplier(sheetBytes, isWorkbook ? 'Cost sheet.xlsx' : 'Cost sheet.csv');
    const [sheet] = parsed.sheets;
    for (const entry of [...parsed.issues, ...(sheet?.issues ?? [])]) {
      issues.push({ code: entry.code, message: entry.message, severity: 'hold', source: 'cost-sheet',
        ...(entry.row === null ? {} : { line: entry.row }), ...(entry.column === null ? {} : { column: entry.column }) });
    }
    if (parsed.sheets.length > 1) {
      issues.push({ code: 'multiple-cost-worksheets', message: 'Upload a cost workbook with exactly one worksheet.', severity: 'hold', source: 'cost-sheet' });
    } else if (sheet && !sheet.issues.length) {
      const skuColumn = sheet.headers.findIndex(header => mappingLabel(header) === 'sku');
      const costColumns = sheet.headers.flatMap((header, index) => costAliases(header) ? [index] : []);
      const currency = currencyColumns(sheet.headers);
      if (skuColumn < 0 || costColumns.length !== 1) {
        issues.push({ code: 'invalid-cost-sheet-columns', message: 'Use an SKU column and exactly one cost column.', severity: 'hold', source: 'cost-sheet' });
      } else {
        const index = costColumns[0];
        for (const { line, cells } of sheet.rows) {
          const sku = cells[skuColumn];
          if (sku?.kind !== 'text' || !sku.value?.trim() || isScientific(sku.value)) {
            issues.push({ code: 'invalid-cost-sku', message: 'Use a nonblank text SKU with its original characters and leading zeros.',
              severity: 'hold', source: 'cost-sheet', line, column: sheet.headers[skuColumn] });
          } else if (bySku.has(sku.value)) {
            issues.push({ code: 'duplicate-cost-sku', message: 'Supply only one cost per exact SKU.', severity: 'hold', source: 'cost-sheet', line,
              column: sheet.headers[skuColumn] });
          } else {
            bySku.set(sku.value, { cell: cells[index], source: { kind: 'cost-sheet', line, column: sheet.headers[index] },
              hasCurrency: currency.some(column => Boolean(cells[column]?.value)) });
          }
        }
      }
    }
  }

  const index = baselineColumns.length === 1 ? baselineColumns[0] : undefined;
  return (variant: Variant) => {
    const supplied = bySku.get(variant.sku);
    const original = index === undefined ? undefined : { cell: variant.source.cells[index],
      source: { kind: 'baseline' as const, line: variant.source.line, column: baseline.headers[index] } };
    const record: CostCell | undefined = supplied ?? original;
    const raw = record?.cell?.value ?? null;
    const known = record && !record.hasCurrency && (record.cell?.kind === 'text' || record.cell?.kind === 'number') &&
      !record.cell.scientific && raw !== null && baselinePrice.test(raw);
    return { amount: known ? readAmount(raw) : null, raw, source: record?.source ?? null };
  };
}
