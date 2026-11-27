import { sha256 } from '../audit/custody';
import { signoffBrandSchema } from '../branding/signoff-brand';
import { serializeCsv } from '../csv';
import { guardSpreadsheetCell } from '../formula-guard';
import { amountDelta, amountGreaterThan, baselinePrice, currenciesAgree, readAmount, resolvedCurrencyCode, type Amount } from '../shopify-price-diff/prices';
import { profileText } from '../shopify-price-diff/settings-validation';
import { costRange, displayPercent, relativeChange } from './math';
import { renderNegotiationBrief } from './signoff';
import { currencyCode, problem, projectSource } from './source';
import type { CostCreepCustody, CostCreepLifecycle, CostCreepMargin, CostCreepOptions, CostCreepPeriod, CostCreepResult,
  CostCreepRow, CostCreepSummary } from './types';

export * from './types';
export { inspectCostCreepSource } from './source';
export { costCreepSparkline } from './math';

type Projection = ReturnType<typeof projectSource>;
type Entry = NonNullable<ReturnType<Projection['entries']['get']>>;
type Ranked = { row: CostCreepRow; change: ReturnType<typeof relativeChange> };

const utf8 = new TextEncoder();
const validLabel = profileText(240);

function retailMargin(retail: Entry, first: Amount, latest: Amount): CostCreepMargin | null {
  if (retail.amount.units === 0n) return null;
  const scale = Math.max(retail.amount.scale, first.scale, latest.scale);
  const units = (amount: Amount) => amount.units * 10n ** BigInt(scale - amount.scale);
  const revenue = units(retail.amount);
  const oldCost = units(first);
  const newCost = units(latest);
  const [primary] = retail.sourceRows;
  return {
    retail: retail.amount.text, rawRetail: primary.rawCost, retailRow: primary.row,
    sourceRows: retail.sourceRows.map(({ row, rawCost }) => ({ row, rawRetail: rawCost })),
    oldGrossMarginPercent: displayPercent(revenue - oldCost, revenue),
    newGrossMarginPercent: displayPercent(revenue - newCost, revenue),
    compressionPoints: displayPercent(newCost - oldCost, revenue),
  };
}

function analyzeSku(sku: string, history: readonly (Entry | undefined)[], currency: string | null,
  threshold: Amount, retailer: Entry | undefined): Ranked {
  const available = history.filter((item): item is Entry => item !== undefined);
  const first = available[0].amount;
  const latest = available.at(-1)!.amount;
  const change = available.length > 1 ? relativeChange(first, latest) : null;
  const { minimum, maximum } = costRange(available.map(({ amount }) => amount));
  const firstIndex = history.findIndex((entry) => entry !== undefined);
  let run = 0;
  let consecutiveHikes = 0;
  let hikeCount = 0;
  let dropCount = 0;
  for (let index = 1; index < history.length; index++) {
    const before = history[index - 1]?.amount;
    const after = history[index]?.amount;
    if (before && after && amountGreaterThan(after, before)) {
      hikeCount++;
      consecutiveHikes = Math.max(consecutiveHikes, ++run);
    } else {
      if (before && after && amountGreaterThan(before, after)) dropCount++;
      run = 0;
    }
  }
  let lifecycle: CostCreepLifecycle = 'active-all-periods';
  if (history.at(-1) === undefined) lifecycle = 'discontinued';
  else if (history.slice(firstIndex).includes(undefined)) lifecycle = 'reappeared';
  else if (firstIndex > 0) lifecycle = 'added-later';
  const meetsThreshold = change !== null &&
    change.numerator * 100n * 10n ** BigInt(threshold.scale) >= threshold.units * change.denominator;
  const row: CostCreepRow = {
    sku,
    observations: history.map((entry) => entry ? { ...entry.sourceRows[0], cost: entry.amount.text, sourceRows: entry.sourceRows } : null),
    firstObservedCost: first.text, latestObservedCost: latest.text, cumulativeDelta: amountDelta(first, latest),
    cumulativeDeltaPercent: change === null ? null : displayPercent(change.numerator, change.denominator),
    hikeCount, dropCount, consecutiveHikes, lifecycle, currency, volatility: amountDelta(minimum, maximum), meetsThreshold,
    margin: retailer !== undefined && available.length > 1 ? retailMargin(retailer, first, latest) : null,
  };
  return { row, change };
}

function rank(left: Ranked, right: Ranked): number {
  if (left.change === null) return right.change === null ? 0 : 1;
  if (right.change === null) return -1;
  const balance = right.change.numerator * left.change.denominator - left.change.numerator * right.change.denominator;
  return balance < 0n ? -1 : balance > 0n ? 1 : 0;
}

function historyCsv(periods: readonly CostCreepPeriod[], rows: readonly CostCreepRow[]): string {
  const headers = ['SKU', 'Lifecycle', 'Currency', 'First observed cost', 'Latest observed cost', 'Exact cumulative delta', 'Cumulative change %',
    'Meets threshold', 'Adjacent hikes', 'Adjacent drops', 'Longest consecutive hikes', 'Volatility (max minus min)',
    'Retail price (source)', 'Retail source line', 'Old gross margin %', 'New gross margin %', 'Margin compression (percentage points)',
    ...periods.flatMap(({ label }) => [label + ' source cost', label + ' source line']),
  ];
  return serializeCsv(headers.map(guardSpreadsheetCell), rows.map((row) => [
    row.sku, row.lifecycle, row.currency ?? '', row.firstObservedCost, row.latestObservedCost, row.cumulativeDelta,
    row.cumulativeDeltaPercent ?? '', row.meetsThreshold ? 'yes' : 'no', String(row.hikeCount), String(row.dropCount),
    String(row.consecutiveHikes), row.volatility,
    row.margin?.rawRetail ?? '', row.margin?.retailRow.toString() ?? '', row.margin?.oldGrossMarginPercent ?? '',
    row.margin?.newGrossMarginPercent ?? '', row.margin?.compressionPoints ?? '',
    ...row.observations.flatMap((observation) => [observation?.rawCost ?? '', observation?.row.toString() ?? '']),
  ].map(guardSpreadsheetCell)), 'cost-creep');
}

export async function buildCostCreep(periods: readonly CostCreepPeriod[], options: CostCreepOptions = {}): Promise<CostCreepResult> {
  const thresholdPercent = options.creepThresholdPercent ?? '10';
  const threshold = baselinePrice.test(thresholdPercent) ? readAmount(thresholdPercent) : null;
  const issues = [];
  if (periods.length < 2 || periods.length > 6) issues.push(problem('invalid-period-count', 'Provide two to six ordered historical periods.'));
  if (!threshold) issues.push(problem('invalid-creep-threshold', 'Use a nonnegative plain decimal percentage.', { value: thresholdPercent }));
  if (options.branding !== undefined && !signoffBrandSchema.safeParse(options.branding).success) {
    issues.push(problem('invalid-branding', 'Use valid M16 branding settings.'));
  }
  const labels = new Set<string>();
  const projected = periods.map((period) => {
    if (!validLabel.safeParse(period.label).success || labels.has(period.label)) {
      issues.push(problem('invalid-period-label', 'Provide distinct nonblank period labels without control or direction override characters.',
        { source: 'period', periodLabel: period.label, value: period.label }));
    }
    labels.add(period.label);
    return projectSource(period, 'period', period.label, options.currency);
  });
  const baseline = options.retail && projectSource(options.retail, 'retail', null, options.retail.currency);
  for (const [source, currency] of [['period', options.currency], ['retail', options.retail?.currency]] as const) {
    if (currency !== undefined && !currencyCode.test(currency)) {
      issues.push(problem('invalid-currency', 'Use a three-letter uppercase currency code.', { source, value: currency }));
    }
  }
  for (const projection of [...projected, ...(baseline ? [baseline] : [])]) {
    for (const issue of projection.issues) issues.push(issue);
  }
  const supplierEvidence = projected.flatMap(({ evidence }) => [...evidence.values()]);
  const retailEvidence = baseline ? [...baseline.evidence.values()] : [];
  const allEvidence = [...supplierEvidence, ...retailEvidence];
  const supplierUnits = supplierEvidence.map(({ unit }) => unit);
  const retailUnits = retailEvidence.map(({ unit }) => unit);
  // Different denominations anywhere in the report cannot share a procurement watchlist.
  if (!currenciesAgree([...supplierUnits, ...retailUnits])) {
    for (const { unit, row, ...details } of allEvidence) {
      issues.push(problem('incomparable-currency', 'Declared currencies must be comparable across the selected sources. No exchange rates are applied.',
        { ...details, row, rows: row === null ? [] : [row], value: unit }));
    }
  }

  const custody: CostCreepCustody = {
    periods: await Promise.all(periods.map(async ({ filename, label, bytes }, index) => ({
      filename, label, bytes: bytes.byteLength, selectedSheet: projected[index].inspection.selectedSheet, sha256: await sha256(bytes),
    }))),
  };
  if (options.retail) {
    const { filename, bytes } = options.retail;
    custody.retail = { filename, bytes: bytes.byteLength, sha256: await sha256(bytes) };
  }

  const status = issues.some(({ blocking }) => blocking) ? 'blocked' : 'ready';
  const summary: CostCreepSummary = { trackedSkus: 0, thresholdSkus: 0, worstCumulativeHikePercent: null, consecutiveMultiHikeSkus: 0 };
  let rows: CostCreepRow[] = [];
  let csv: string | null = null;
  let briefHtml: string | null = null;
  if (status === 'ready' && threshold) {
    const supplierCurrency = resolvedCurrencyCode(supplierUnits);
    const currency = supplierCurrency ?? supplierUnits[0] ?? null;
    const retailCurrency = resolvedCurrencyCode(retailUnits);
    const skuOrder = new Set<string>();
    const periodCurrencies = projected.map(({ entries, evidence }) => {
      for (const sku of entries.keys()) skuOrder.add(sku);
      return resolvedCurrencyCode([...evidence.keys()]);
    });
    const ranked = [...skuOrder].map((sku) => {
      const history = projected.map(({ entries }) => entries.get(sku));
      // Both observed endpoints must have evidence independent of the retail price.
      const observed = history.flatMap((entry, index) => entry === undefined ? [] : [index]);
      const firstCurrency = periodCurrencies[observed[0]];
      const lastCurrency = periodCurrencies[observed.at(-1)!];
      const retailer = retailCurrency !== null && firstCurrency === retailCurrency && lastCurrency === retailCurrency
        ? baseline?.entries.get(sku) : undefined;
      return analyzeSku(sku, history, currency, threshold, retailer);
    }).sort(rank);
    rows = ranked.map(({ row }) => row);
    summary.trackedSkus = rows.length;
    summary.thresholdSkus = rows.filter(({ meetsThreshold }) => meetsThreshold).length;
    summary.worstCumulativeHikePercent = (ranked[0]?.change?.numerator ?? 0n) > 0n ? rows[0].cumulativeDeltaPercent : null;
    summary.consecutiveMultiHikeSkus = rows.filter(({ consecutiveHikes }) => consecutiveHikes >= 2).length;
    csv = historyCsv(periods, rows);
    custody.historyCsvSha256 = await sha256(utf8.encode(csv));
    briefHtml = renderNegotiationBrief(rows, summary, thresholdPercent, custody, options.branding);
    custody.briefHtmlSha256 = await sha256(utf8.encode(briefHtml));
  }

  const sourceDetails = ({ inspection, mapping, requestedMapping, evidence }: Projection) => ({
    headers: inspection.headers, mapping, requestedMapping, currencyEvidence: [...evidence.values()],
  });
  const sources = {
    periods: custody.periods.map((sheet, index) => ({ ...sheet, ...sourceDetails(projected[index]) })),
    ...(baseline ? { retail: { ...custody.retail, ...sourceDetails(baseline) } } : {}),
  };
  const auditJson = JSON.stringify({ version: 1, status, thresholdPercent, summary, sources, rows, issues, custody }, null, rows.length > 10_000 ? 0 : 2) + '\n';
  return { status, thresholdPercent, summary, rows, issues, auditJson, historyCsv: csv, briefHtml, custody };
}
