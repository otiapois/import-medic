import { brandSignoffHtml, type SignoffBrand } from '../branding/signoff-brand';
import { serializeCsv } from '../csv';
import { guardSpreadsheetRow, type FormulaGuardCell } from '../formula-guard';
import { custodyFooter, escapeReportText as escape, offlineReportCsp } from '../report-html';
import { formatMinorUnits } from '../values';
import type { LandedCostProof, LandedCostRow, LandedCostTotals } from './types';

export const landedCostFilenames = {
  csv: 'shipment-landed-cost.csv', audit: 'landed-cost-audit.json', html: 'landed-cost-sheet.html',
} as const;

const money = (value: bigint) => formatMinorUnits(value, 2);

export function exportLandedCostCsv(rows: readonly LandedCostRow[], currency: string, sourceCurrency: string) {
  const headers = ['SKU', 'Quantity', 'FOB Unit Cost', 'FOB Currency', 'Allocated Freight', 'Allocated Insurance',
    'Allocated Handling', 'Allocated Insurance & Handling', 'Allocated Other Charges', 'Customs Duty',
    'Landed Extended Cost', 'Landed Unit Cost', 'Cost', 'Currency', 'HS Code', 'Description'];
  const neutralized: FormulaGuardCell[] = [];
  const data = rows.map(row => guardSpreadsheetRow([
    row.sku, row.quantity.toString(), money(row.sourceFobUnitCents), sourceCurrency, money(row.freightCents),
    money(row.insuranceCents), money(row.handlingCents), money(row.insuranceCents + row.handlingCents),
    money(row.otherChargesCents), money(row.dutyCents), money(row.landedExtendedCents), row.landedUnitCost,
    row.wholesaleUnitCost, currency, row.hsCode, row.description,
  ], headers, row.line, neutralized));
  return { csv: serializeCsv(headers, data, 'landed-cost'), neutralized };
}

const proofLabels = {
  freightCents: 'Freight', insuranceCents: 'Insurance', handlingCents: 'Port / brokerage',
  otherChargesCents: 'Other charges', landedExtendedCents: 'Landed shipment',
} as const;
const cells = (values: readonly string[]) => values.map(value => '<td>' + escape(value) + '</td>').join('');

export function renderLandedCostSheet(rows: readonly LandedCostRow[], totals: LandedCostTotals, proof: LandedCostProof, details: {
  currency: string; sourceCurrency: string; filename: string; worksheet: string | null; method: string; dutyBase: string;
  fxRate?: string; sourceSha256: string; csvSha256: string; branding?: SignoffBrand;
}): string {
  const { currency, sourceCurrency, filename, worksheet, method, dutyBase, fxRate, sourceSha256, csvSha256, branding } = details;
  const summary = [
    ['Total FOB', totals.fobCents],
    ['Shared freight & fees', totals.freightCents + totals.insuranceCents + totals.handlingCents + totals.otherChargesCents],
    ['Total customs duty', totals.dutyCents],
    ['Grand landed total', totals.landedExtendedCents],
    ['Exact penny check', totals.driftCents],
  ] as const;
  const summaryHtml = summary.map(([label, value]) => '<div><dt>' + escape(label) + '</dt><dd>' +
    money(value) + (label === 'Exact penny check' ? ' drift' : '') + '</dd></div>').join('');
  const proofHtml = Object.entries(proof).map(([charge, { expected, allocated, drift }]) => '<tr><th scope="row">' +
    escape(proofLabels[charge as keyof LandedCostProof]) + '</th>' + cells([money(expected), money(allocated), money(drift)]) + '</tr>').join('');
  const rowsHtml = rows.map(row => '<tr><th scope="row"><code>' + escape(row.sku) + '</code></th>' + cells([
    row.description, row.hsCode, row.line.toString(), row.quantity.toString(), money(row.fobCents), money(row.freightCents),
    money(row.insuranceCents), money(row.handlingCents), money(row.otherChargesCents), money(row.dutyCents),
    money(row.landedExtendedCents), row.landedUnitCost, row.landedUnitDisplay,
    row.unitRemainderCents.toString(), row.upliftPercent === null ? '—' : row.upliftPercent + '%',
  ]) + '</tr>').join('');
  const headers = ['SKU', 'Description', 'HS code', 'Source line', 'Quantity', 'FOB total', 'Freight', 'Insurance',
    'Port / brokerage', 'Other fees', 'Duty', 'Landed total', 'Unit cost (4 dp)', 'Unit display', 'Undivided cents', 'Uplift'];
  const printHeaders = ['SKU', 'Description', 'HS code', 'Line', 'Qty', 'FOB total', 'Freight', 'Ins.',
    'Port fees', 'Other fees', 'Duty', 'Landed total', 'Unit (4 dp)', 'Unit (2 dp)', 'Rem. (¢)', 'Uplift'];
  return brandSignoffHtml('<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="' + offlineReportCsp + '">' +
    '<title>Landed-Cost Breakdown</title><style>' +
    '*{box-sizing:border-box}body{margin:0;padding:1rem;color:#172337;background:#fff;font:16px/1.5 system-ui,sans-serif}' +
    'main{max-width:1120px;margin:auto;min-width:0}h1,h2{line-height:1.2}dl{margin:0}dt{font-weight:650}dd{margin:0;overflow-wrap:anywhere}' +
    '.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr));gap:.7rem;margin:1rem 0}' +
    '.summary div{padding:.75rem;background:#eef3f8;border-radius:.35rem}.scroll{overflow-x:auto;margin:1rem 0}' +
    '.scroll:focus-visible{outline:3px solid #1a365d;outline-offset:2px}table{width:100%;border-collapse:collapse;text-align:left;font-variant-numeric:tabular-nums}' +
    'th,td{padding:.45rem .55rem;border:1px solid #a8b3c2;vertical-align:top;white-space:nowrap}th{background:#eef3f8}' +
    'code,p{overflow-wrap:anywhere}td:nth-child(2){white-space:normal;min-width:8rem;max-width:18rem;overflow-wrap:anywhere}' +
    '.print-label{display:none}' +
    '@media print{body{padding:0;font-size:10pt;line-height:1.4}.scroll{overflow:visible}' +
    '.summary{grid-template-columns:repeat(5,minmax(0,1fr));gap:5pt}.summary div{padding:5pt}' +
    'table{table-layout:fixed;font-size:8pt;line-height:1.25}thead{display:table-header-group}' +
    'h1,h2{break-after:avoid}tr,footer{break-inside:avoid}' +
    'th,td{padding:2pt 1pt;white-space:normal;overflow-wrap:anywhere}td:nth-child(2){min-width:0;max-width:none}' +
    '[aria-label="Shipment lines"] thead th:nth-child(2){width:12%}' +
    '[aria-label="Shipment lines"] thead th:is(:nth-child(3),:nth-child(6),:nth-child(7),:nth-child(12)){width:6.5%}' +
    '[aria-label="Shipment lines"] thead th:is(:nth-child(13),:last-child){width:8%}' +
    '.screen-label{display:none}.print-label{display:inline}}' +
    '</style></head><body><main><h1>Landed-Cost Breakdown</h1><p>Invoice <strong>' + escape(filename) + '</strong>' +
    (worksheet === null ? '' : ' · Worksheet <strong>' + escape(worksheet) + '</strong>') + '</p><p>Allocation ' +
    escape(method) + ' · Duty base ' + escape(dutyBase) + ' · Target currency ' + escape(currency) +
    (fxRate === undefined ? '' : ' · Manual FX ' + escape(fxRate) + ' ' + escape(currency) + ' per ' + escape(sourceCurrency)) +
    '</p><dl class="summary">' + summaryHtml + '</dl><h2>Shipment lines</h2>' +
    '<div class="scroll" role="region" aria-label="Shipment lines" tabindex="0"><table><thead><tr>' +
    headers.map((label, index) => '<th scope="col">' + (printHeaders[index] === label ? escape(label)
      : '<span class="screen-label">' + escape(label) + '</span><span class="print-label">' + escape(printHeaders[index]) + '</span>') +
      '</th>').join('') + '</tr></thead><tbody>' + rowsHtml +
    '</tbody></table></div><p>Unit costs are rounded half to even to four decimals. The two-decimal display is rounded separately. ' +
    'Undivided cents are the remainder after dividing landed extended cents by quantity. The landed extended totals carry the exact cents.</p>' +
    '<h2>Exact penny proof</h2><div class="scroll" role="region" aria-label="Exact penny proof" tabindex="0"><table><thead><tr>' +
    '<th scope="col">Amount</th><th scope="col">Expected</th><th scope="col">Allocated</th><th scope="col">Drift</th></tr></thead><tbody>' +
    proofHtml + '</tbody></table></div>' + custodyFooter([['Original invoice', sourceSha256], ['Landed cost CSV', csvSha256]]) +
    '</main></body></html>', branding).replace(/\/(?=\/)/g, '&#47;');
}
