import { sha256 } from '../audit/custody';
import { signoffBrandSchema } from '../branding/signoff-brand';
import { currencyFractionDigits, formatMinorUnits, isKnownCurrency } from '../values';
import { exportLandedCostCsv, renderLandedCostSheet } from './output';
import { finiteDecimal, readInvoice, wholeNumber } from './source';
import { sharedCharges, type LandedCostIssue, type LandedCostOptions, type LandedCostProof, type LandedCostResult,
  type LandedCostRow, type LandedCostSource, type LandedCostTotals, type SharedAmounts } from './types';

export { landedCostFilenames } from './output';
export { inspectLandedCostSource } from './source';
export { allocationMethods, dutyBases } from './types';
export type { LandedCostIssue, LandedCostOptions, LandedCostProof, LandedCostResult, LandedCostRow, LandedCostSource, LandedCostTotals } from './types';

const utf8 = new TextEncoder();
const sum = (items: readonly bigint[]) => items.reduce((total, item) => total + item, 0n);
const json = (value: unknown) => JSON.stringify(value, (_, field) => typeof field === 'bigint' ? field.toString() : field, 2) + '\n';

function halfEven(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const twiceRemainder = numerator % denominator * 2n;
  return twiceRemainder > denominator || twiceRemainder === denominator && quotient % 2n !== 0n ? quotient + 1n : quotient;
}

function spread(total: bigint, weights: readonly { line: number; amount: bigint }[], denominator: bigint): bigint[] {
  const portions = weights.map(({ line, amount }, index) => {
    const numerator = total * amount;
    return { line, index, whole: numerator / denominator, remainder: numerator % denominator };
  });
  let unassigned = total - sum(portions.map(({ whole }) => whole));
  const allocated = portions.map(({ whole }) => whole);
  if (unassigned === 0n) return allocated;
  portions.sort((a, b) => a.remainder === b.remainder ? a.line - b.line : a.remainder > b.remainder ? -1 : 1);
  for (const { index } of portions) {
    if (unassigned === 0n) break;
    allocated[index]++;
    unassigned--;
  }
  return allocated;
}

const currencyCode = (value: string): string | null => {
  const code = value.trim().toUpperCase();
  return isKnownCurrency(code) && currencyFractionDigits(code) === 2 ? code : null;
};

function readCharges(options: LandedCostOptions, issues: LandedCostIssue[]): SharedAmounts {
  const charges: SharedAmounts = { freightCents: 0n, insuranceCents: 0n, handlingCents: 0n, otherChargesCents: 0n };
  for (const key of sharedCharges) {
    const value = options[key] ?? (key === 'otherChargesCents' ? 0n : '');
    const amount = typeof value === 'bigint' ? value
      : typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value)
        : typeof value === 'string' && wholeNumber.test(value) ? BigInt(value) : -1n;
    if (amount < 0n) issues.push({ code: 'invalid-shared-charge', column: key, value: String(value),
      message: 'Enter a nonnegative whole amount in target-currency cents.' });
    else charges[key] = amount;
  }
  return charges;
}

const proofOf = (expected: bigint, allocated: bigint) => ({ expected, allocated, drift: allocated - expected });

export async function allocateLandedCost({ source, options }: {
  source: LandedCostSource; options: LandedCostOptions;
}): Promise<LandedCostResult> {
  const currency = currencyCode(options.currency);
  const sourceCurrency = options.sourceCurrency === undefined ? currency : currencyCode(options.sourceCurrency);
  const invoice = readInvoice(source, options.method, sourceCurrency);
  const { issues } = invoice;
  const sourceSha256 = await sha256(source.bytes);
  const brand = signoffBrandSchema.optional().safeParse(options.branding);
  if (!brand.success) issues.push({ code: 'invalid-branding', message: 'Use valid Workspace Profile branding.' });
  if (currency === null) issues.push({ code: 'invalid-target-currency', column: 'currency', value: options.currency,
    message: 'Enter a target ISO currency with two decimal places.' });
  if (sourceCurrency === null && options.sourceCurrency !== undefined) {
    issues.push({ code: 'invalid-source-currency', column: 'sourceCurrency', value: options.sourceCurrency,
      message: 'Enter a FOB invoice ISO currency with two decimal places.' });
  }

  const fx = options.fxRate === undefined ? null : finiteDecimal(options.fxRate);
  if (currency && sourceCurrency && currency !== sourceCurrency && (!fx || fx.units === 0n)) {
    issues.push({ code: 'missing-or-invalid-fx-rate', column: 'fxRate', value: options.fxRate,
      message: 'Supply the confirmed positive manual rate in target currency per one unit of FOB currency.' });
  } else if (currency && currency === sourceCurrency && options.fxRate !== undefined) {
    issues.push({ code: 'unnecessary-fx-rate', column: 'fxRate', value: options.fxRate,
      message: 'Leave the manual FX rate empty when both currencies match.' });
  }

  const charges = readCharges(options, issues);
  const auditBase = {
    version: 1,
    source: { filename: source.name, byteLength: source.bytes.length, worksheetNames: invoice.worksheetNames,
      selectedWorksheet: invoice.selectedWorksheet, ...(source.sheetName === undefined ? {} : { requestedWorksheet: source.sheetName }) },
    options: { currency, sourceCurrency, method: options.method, dutyBase: options.dutyBase, fxRate: options.fxRate ?? null,
      freightCents: String(options.freightCents), insuranceCents: String(options.insuranceCents), handlingCents: String(options.handlingCents),
      otherChargesCents: String(options.otherChargesCents ?? 0n), branding: brand.data },
  };
  const blocked = (): LandedCostResult => ({
    status: 'blocked', issues, rows: [], totals: null,
    files: { audit: json({ ...auditBase, status: 'blocked', issues, custody: { sourceSha256 } }) },
  });
  if (issues.length || currency === null || sourceCurrency === null || !brand.success) return blocked();

  const scale = invoice.rows.reduce((max, row) => Math.max(max, row.driver.scale), 0);
  const inputRows = invoice.rows.map(row => ({ ...row, sourceFobCents: row.sourceFobUnitCents * row.quantity }));
  const weights = inputRows.map(row => ({
    line: row.line,
    amount: options.method === 'by-value' ? row.sourceFobCents
      : options.method === 'by-units' ? row.quantity
        : row.quantity * row.driver.units * 10n ** BigInt(scale - row.driver.scale),
  }));
  const totalWeight = sum(weights.map(({ amount }) => amount));
  if (totalWeight === 0n) {
    issues.push({ code: 'zero-allocation-basis', column: 'FOB Unit Cost', lines: inputRows.map(({ line }) => line),
      message: 'Value allocation requires a positive total FOB value. Choose another valid allocation method if all FOB costs are zero.' });
    return blocked();
  }

  const freight = spread(charges.freightCents, weights, totalWeight);
  const insurance = spread(charges.insuranceCents, weights, totalWeight);
  const handling = spread(charges.handlingCents, weights, totalWeight);
  const other = spread(charges.otherChargesCents, weights, totalWeight);
  const fxDenominator = fx ? 10n ** BigInt(fx.scale) : 1n;
  const rows = inputRows.map(({ driver: _, ...row }, index): LandedCostRow => {
    const { quantity, sourceFobCents, dutyRateBps } = row;
    const fobCents = fx ? halfEven(sourceFobCents * fx.units, fxDenominator) : sourceFobCents;
    const freightCents = freight[index];
    const insuranceCents = insurance[index];
    const handlingCents = handling[index];
    const otherChargesCents = other[index];
    const dutyBaseCents = options.dutyBase === 'CIF' ? fobCents + freightCents + insuranceCents : fobCents;
    const dutyCents = halfEven(dutyBaseCents * dutyRateBps, 10_000n);
    const landedExtendedCents = fobCents + freightCents + insuranceCents + handlingCents + otherChargesCents + dutyCents;
    const upliftPercent = fobCents === 0n ? null : formatMinorUnits(halfEven((landedExtendedCents - fobCents) * 10_000n, fobCents), 2);
    const unitRemainderCents = landedExtendedCents % quantity;
    return { ...row, allocationWeight: weights[index].amount, fobCents, freightCents, insuranceCents, handlingCents, otherChargesCents,
      dutyBaseCents, dutyCents, landedExtendedCents, landedUnitRatio: { numeratorCents: landedExtendedCents, denominator: quantity },
      landedUnitCost: formatMinorUnits(halfEven(landedExtendedCents * 100n, quantity), 4),
      landedUnitDisplay: formatMinorUnits(halfEven(landedExtendedCents, quantity), 2), unitRemainderCents,
      wholesaleUnitCost: formatMinorUnits((landedExtendedCents + quantity - 1n) / quantity, 2), upliftPercent };
  });

  const bucket = (key: keyof SharedAmounts) => proofOf(charges[key], sum(rows.map(row => row[key])));
  const fobCents = sum(rows.map(row => row.fobCents));
  const dutyCents = sum(rows.map(row => row.dutyCents));
  const landedExtendedCents = sum(rows.map(row => row.landedExtendedCents));
  const proof: LandedCostProof = { freightCents: bucket('freightCents'), insuranceCents: bucket('insuranceCents'),
    handlingCents: bucket('handlingCents'), otherChargesCents: bucket('otherChargesCents'),
    landedExtendedCents: proofOf(fobCents + sum(Object.values(charges)) + dutyCents, landedExtendedCents) };
  const totals: LandedCostTotals = { ...charges, fobCents, dutyCents, landedExtendedCents, driftCents: proof.landedExtendedCents.drift };
  if (Object.values(proof).some(({ drift }) => drift !== 0n)) {
    issues.push({ code: 'cent-conservation-failed', message: 'The shipment amounts did not reconcile. Review the invoice before exporting.' });
    return blocked();
  }

  const { csv, neutralized } = exportLandedCostCsv(rows, currency, sourceCurrency);
  const csvSha256 = await sha256(utf8.encode(csv));
  const html = renderLandedCostSheet(rows, totals, proof, {
    currency, sourceCurrency, filename: source.name, worksheet: invoice.selectedWorksheet, method: options.method, dutyBase: options.dutyBase,
    fxRate: options.fxRate, sourceSha256, csvSha256, branding: brand.data,
  });
  const htmlSha256 = await sha256(utf8.encode(html));
  const audit = json({ ...auditBase, status: 'ready', issues, rows, totals, proof,
    allocationBasis: { scale, totalWeight }, formulaGuard: { neutralized }, custody: { sourceSha256, csvSha256, htmlSha256 } });
  return { status: 'ready', currency, issues, rows, totals, proof, files: { csv, html, audit } };
}
