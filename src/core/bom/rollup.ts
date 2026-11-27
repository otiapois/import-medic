import { mappingLabel } from '../shopify-price-diff/mapping';
import { readAmount, type Amount } from '../shopify-price-diff/prices';
import { parseSupplier, readCsvTable } from '../shopify-price-diff/source';
import { issue, type DiffIssue } from '../shopify-price-diff/types';
import type { FxConversion } from '../shopify-price-diff/pricing-rules';
import { isScientific } from '../xlsx';

const maxDepth = 5;
const optionalAmount = /^(?:[0-9]{1,64}(?:\.[0-9]{1,64})?|\.[0-9]{1,64})$/;
const quantityPattern = /^[0-9]{1,64}$/;

interface BomEdge { sku: string; line: number; quantity: bigint }
interface BomDefinition {
  sku: string;
  entries: BomEdge[];
  assembly: bigint;
  assemblyLine: number | null;
}
export interface BomSheet {
  filename: string;
  worksheet?: string;
  rowCount: number;
  definitions: ReadonlyMap<string, BomDefinition>;
  componentSkus: ReadonlySet<string>;
  issues: DiffIssue[];
}

export interface BomCostSource {
  kind: 'supplier' | 'baseline' | 'bundle';
  filename: string;
  worksheet?: string;
  line: number;
  column: string;
  supplierId?: string;
  currency?: string;
  fx?: FxConversion;
  raw?: string;
}
export interface BomCost { cents: bigint; source: BomCostSource }
export interface BomComponent {
  sku: string;
  line: number;
  quantity: string;
  unitCost: string | null;
  extendedCost: string | null;
  source: BomCostSource | null;
  previousUnitCost: string | null;
  previousSource: BomCostSource | null;
}
export interface BomKit {
  sku: string;
  baselineLine: number | null;
  lines: number[];
  depth: number;
  oldCost: string | null;
  oldCostSource: 'baseline' | 'recomputed' | null;
  oldCostEvidence: BomCostSource | null;
  newCost: string | null;
  assemblyCost: string;
  assemblyLine: number | null;
  newRetail: string | null;
  grossMarginPercent: string | null;
  pricingSupplierId?: string;
  components: BomComponent[];
}
export interface BomRollup {
  filename: string;
  worksheet?: string;
  kits: BomKit[];
  issues: DiffIssue[];
  currency?: string;
  pricingSuppliers?: { supplierId: string; label: string }[];
}

export interface BomInputs {
  sheet: BomSheet;
  pricingSupplierId?: string;
}

export function exactCostCents(amount: Amount | null): bigint | null {
  if (!amount || amount.units < 0n) return null;
  const units = amount.units * 100n;
  const divisor = 10n ** BigInt(amount.scale);
  return units % divisor === 0n ? units / divisor : null;
}

export function costText(cents: bigint): string {
  const digits = cents.toString().padStart(3, '0');
  return digits.slice(0, -2) + '.' + digits.slice(-2);
}

export function parseBom(bytes: Uint8Array, filename: string): BomSheet {
  if (!/\.(?:csv|xlsx)$/i.test(filename)) return {
    filename, rowCount: 0, definitions: new Map(), componentSkus: new Set(),
    issues: [issue('bom', 'invalid-bom-file', 'Choose a bundle BOM CSV or XLSX file.')],
  };
  const parsed = /\.csv$/i.test(filename)
    ? { sheets: [readCsvTable(bytes, filename, 'bom', mappingLabel, { retainEmptyRecords: true })], issues: [] }
    : parseSupplier(bytes, filename);
  const [sheet] = parsed.sheets;
  const result: BomSheet = {
    filename, ...(/\.xlsx$/i.test(filename) && sheet ? { worksheet: sheet.name } : {}),
    rowCount: sheet?.rows.length ?? 0,
    definitions: new Map(), componentSkus: new Set(),
    issues: [...parsed.issues, ...(sheet?.issues ?? [])].map((entry) => ({ ...entry, source: 'bom' })),
  };
  const { issues } = result;
  if (parsed.sheets.length !== 1) {
    if (!issues.length) issues.push(issue('bom', 'invalid-bom-worksheets', 'Choose a BOM workbook with exactly one visible worksheet.'));
    return result;
  }
  const headers = sheet.headers.map(mappingLabel);
  const columns = ['Bundle SKU', 'Component SKU', 'Quantity', 'Assembly Cost'].map((column, index) => {
    const label = mappingLabel(column);
    const position = headers.indexOf(label);
    if (position === -1 && index < 3 || position !== -1 && position !== headers.lastIndexOf(label)) {
      issues.push(issue('bom', 'invalid-bom-header', 'Use exactly one ' + column + ' column.', { row: sheet.headerRow, column }));
    }
    return position;
  });
  if (columns.slice(0, 3).some((column) => column < 0)) return result;
  const [bundleColumn, componentColumn, quantityColumn, assemblyColumn] = columns;
  const definitions = new Map<string, BomDefinition>();
  const repeated = new Map<string, Map<string, number>>();
  for (const { line, cells } of sheet.rows) {
    const skuAt = (column: number, name: string) => {
      const cell = cells[column];
      if (cell?.kind === 'text' && cell.value?.trim() && !isScientific(cell.value)) return cell.value;
      issues.push(issue('bom', 'invalid-bom-sku', 'Use the original nonblank SKU as text, preserving all leading zeros.',
        { row: line, column: name, value: cell?.value ?? null }));
      return null;
    };
    const bundle = skuAt(bundleColumn, 'Bundle SKU');
    const component = skuAt(componentColumn, 'Component SKU');
    const qty = cells[quantityColumn];
    const qtyText = qty?.value?.trim() ?? '';
    const quantity = (qty?.kind === 'text' || qty?.kind === 'number') && quantityPattern.test(qtyText) ? BigInt(qtyText) : 0n;
    if (quantity === 0n) issues.push(issue('bom', 'invalid-bom-quantity', 'Enter a positive whole component quantity.',
      { row: line, column: 'Quantity', value: qty?.value ?? null }));
    const assembly = cells[assemblyColumn];
    const assemblyText = assembly?.value?.trim() ?? '';
    let cents: bigint | null = null;
    if (assemblyText || assembly?.kind === 'formula' || assembly?.kind === 'unsupported') {
      cents = (assembly?.kind === 'text' || assembly?.kind === 'number') && !assembly.currency && optionalAmount.test(assemblyText)
        ? exactCostCents(readAmount(assemblyText)) : null;
      if (cents === null) issues.push(issue('bom', 'invalid-bom-assembly-cost', 'Enter a nonnegative assembly cost in exact store-currency cents.',
        { row: line, column: 'Assembly Cost', value: assembly?.value ?? null }));
    }
    if (bundle === null || component === null || quantity === 0n) continue;
    let definition = definitions.get(bundle);
    if (!definition) {
      definition = { sku: bundle, entries: [], assembly: 0n, assemblyLine: null };
      definitions.set(bundle, definition);
      repeated.set(bundle, new Map());
    }
    if (cents !== null) {
      if (definition.assemblyLine !== null && definition.assembly !== cents) {
        const rows = [definition.assemblyLine, line];
        issues.push(issue('bom', 'conflicting-bom-assembly-cost', 'Assembly costs for ' + bundle + ' disagree on lines ' + rows.join(', ') + '.',
          { row: line, rows, column: 'Assembly Cost', value: assemblyText }));
      } else if (definition.assemblyLine === null) {
        definition.assembly = cents;
        definition.assemblyLine = line;
      }
    }
    const seen = repeated.get(bundle)!;
    const earlier = seen.get(component);
    if (earlier !== undefined) {
      const rows = [earlier, line];
      issues.push(issue('bom', 'duplicate-bom-component', 'Combine repeated quantities for ' + component + ' in ' + bundle + ' on lines ' + rows.join(', ') + '.',
        { row: line, rows, column: 'Component SKU', value: component }));
      continue;
    }
    seen.set(component, line);
    definition.entries.push({ sku: component, line, quantity });
  }
  if (!sheet.rows.length && !issues.length) issues.push(issue('bom', 'empty-bom', 'Add at least one bundle and component row.'));
  const componentSkus = new Set<string>();
  for (const { entries } of definitions.values()) {
    for (const { sku } of entries) if (!definitions.has(sku)) componentSkus.add(sku);
  }
  return { ...result, definitions, componentSkus };
}

type ComponentLookup = (sku: string) => { previous: BomCost | null; current: BomCost | null; reason?: string };
interface RollupValues {
  old: BomCost | null;
  current: BomCost | null;
  path: string[];
  lines: number[];
}

/** Evaluate each exact SKU once. The explicit stack handles deep malformed input without recursion. */
export function rollupBom(sheet: BomSheet, lookup: ComponentLookup): BomRollup {
  const { definitions, filename, worksheet } = sheet;
  const issues = [...sheet.issues];
  const kits = new Map<string, BomKit>();
  const costs = new Map<string, RollupValues>();
  const positions = new Map<string, number>();
  const cyclic = new Set<string>();
  const stack: { definition: BomDefinition; index: number; incoming: number | null }[] = [];
  const push = (definition: BomDefinition, incoming: number | null) => {
    positions.set(definition.sku, stack.length);
    stack.push({ definition, index: 0, incoming });
  };
  for (const root of definitions.values()) {
    if (costs.has(root.sku)) continue;
    push(root, null);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const { definition } = frame;
      const { sku, entries, assembly, assemblyLine } = definition;
      if (frame.index < entries.length) {
        const edge = entries[frame.index++];
        const dependency = definitions.get(edge.sku);
        if (!dependency || costs.has(edge.sku)) continue;
        const start = positions.get(edge.sku);
        if (start === undefined) {
          push(dependency, edge.line);
        } else {
          const frames = stack.slice(start);
          const cycle = frames.map(({ definition }) => definition.sku);
          for (const member of cycle) cyclic.add(member);
          cycle.push(edge.sku);
          const rows = [...frames.slice(1).map(({ incoming }) => incoming!), edge.line];
          issues.push(issue('bom', 'bom-cycle', 'Bundle cycle ' + cycle.join(' → ') + ' on lines ' + rows.join(', ') + '.',
            { row: rows[0], rows, column: 'Component SKU', value: edge.sku, bomPath: cycle }));
        }
        continue;
      }

      let old: bigint | null = assembly;
      let current: bigint | null = cyclic.has(sku) ? null : assembly;
      let path = [sku];
      let pathLines: number[] = [];
      const components = entries.map(({ sku: component, quantity, line }): BomComponent => {
        let previous: BomCost | null;
        let next: BomCost | null;
        if (definitions.has(component)) {
          const nested = costs.get(component);
          previous = nested?.old ?? null;
          next = nested?.current ?? null;
          if (nested && !cyclic.has(sku) && nested.path.length + 1 > path.length) {
            path = [sku, ...nested.path].slice(0, maxDepth + 1);
            pathLines = [line, ...nested.lines].slice(0, maxDepth);
          }
        } else {
          const source = lookup(component);
          previous = source.previous;
          next = source.current;
          if (!next) issues.push(issue('bom', 'orphan-component',
            (source.reason ?? 'Missing or unpriced component ' + component + '.') + ' Bundle ' + sku + ', line ' + line + '.',
            { row: line, column: 'Component SKU', value: component }));
        }
        const extended = next ? next.cents * quantity : null;
        old = old === null || !previous ? null : old + previous.cents * quantity;
        current = current === null || extended === null ? null : current + extended;
        return { sku: component, line, quantity: quantity.toString(), unitCost: next && costText(next.cents),
          extendedCost: extended === null ? null : costText(extended), source: next?.source ?? null,
          previousUnitCost: previous && costText(previous.cents), previousSource: previous?.source ?? null };
      });
      if (path.length > maxDepth) {
        current = null;
        issues.push(issue('bom', 'bom-depth-limit', 'Use at most five bundle levels. Found ' + path.join(' → ') + ' on lines ' + pathLines.join(', ') + '.',
          { row: pathLines[0], rows: pathLines, column: 'Component SKU', value: sku, bomPath: path }));
      }
      const baseline = lookup(sku).previous;
      const source: BomCostSource = { kind: 'bundle', filename, ...(worksheet ? { worksheet } : {}), line: entries[0].line, column: 'Bundle SKU' };
      costs.set(sku, { old: baseline ?? (old === null ? null : { cents: old, source }),
        current: current === null ? null : { cents: current, source }, path, lines: pathLines });
      kits.set(sku, { sku, baselineLine: null, lines: entries.map(({ line }) => line), depth: path.length,
        oldCost: baseline ? costText(baseline.cents) : old === null ? null : costText(old),
        oldCostSource: baseline ? 'baseline' : old === null ? null : 'recomputed',
        oldCostEvidence: baseline?.source ?? (old === null ? null : source),
        newCost: current === null ? null : costText(current), assemblyCost: costText(assembly), assemblyLine,
        newRetail: null, grossMarginPercent: null, components });
      positions.delete(sku);
      stack.pop();
    }
  }
  return { filename, ...(worksheet ? { worksheet } : {}), issues, kits: [...definitions.keys()].map((sku) => kits.get(sku)!) };
}
