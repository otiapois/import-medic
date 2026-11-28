import { brandSignoffHtml, type SignoffBrand } from '../branding/signoff-brand';
import { parseCsv, serializeCsv } from '../csv';
import { guardSpreadsheetCell as guard } from '../formula-guard';
import { custodyFooter, escapeReportText as escape, offlineReportCsp } from '../report-html';
import type { PurchaseOrderResult, PurchaseOrderSupplierGroup } from './types';

export const orderFilenames = { audit: 'po-audit.json', summary: 'po-consolidated-summary.csv', html: 'purchase-order-pack.html' };

export function formatCents(cents: bigint): string {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export function supplierFilename(label: string, reserved: Set<string>): string {
  const slug = label.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '') || 'supplier';
  let filename = `po-${slug}.csv`;
  for (let suffix = 2; reserved.has(filename); suffix++) filename = `po-${slug}-${suffix}.csv`;
  reserved.add(filename);
  return filename;
}

function verifiedCsv(headers: string[], rows: string[][]): string | null {
  const content = serializeCsv(headers, rows, 'purchase-order');
  const expected = [headers, ...rows];
  const { records } = parseCsv(content);
  return records.length === expected.length && records.every(({ cells, parseError }, index) =>
    !parseError && cells.length === headers.length && cells.every((cell, position) => cell === expected[index][position])) ? content : null;
}

export function encodeOrderCsv(groups: readonly PurchaseOrderSupplierGroup[],
  { poReference, targetLocation, currency }: { poReference?: string; targetLocation: string | null; currency: string | null },
  filenameFor: (label: string) => string,
) {
  const supplierCsvs = [];
  const summaryRows: { inventoryLine: number; cells: string[] }[] = [];
  const headers = ['SKU', 'Supplier SKU', 'Current Qty', 'Reorder Point', 'Target Stock', 'Order Qty', 'MOQ', 'Case Pack',
    'Lead Time Days', 'Unit Cost', 'Line Total', 'Currency', 'Supplier', 'Location', 'PO Reference'];
  for (const { supplierIndex, label, lines } of groups) {
    const rows = lines.map(line => {
      const { sku, supplierSku, currentQty, reorderPoint, targetStock, orderQty, moq, casePack, leadTimeDays, unitCost, lineTotal } = line;
      summaryRows.push({ inventoryLine: line.inventoryLine,
        cells: [guard(sku), String(currentQty), String(reorderPoint), String(orderQty), guard(label), unitCost, lineTotal] });
      return [guard(sku), guard(supplierSku), String(currentQty), String(reorderPoint), String(targetStock), String(orderQty), String(moq),
        String(casePack), leadTimeDays === null ? '' : String(leadTimeDays), unitCost, lineTotal, currency ?? '', guard(label),
        guard(targetLocation ?? ''), guard(poReference ?? '')];
    });
    const content = verifiedCsv(headers, rows);
    if (content === null) return null;
    supplierCsvs.push({ supplierIndex, filename: filenameFor(label), content });
  }
  const content = verifiedCsv(['SKU', 'Current Qty', 'Reorder Point', 'Order Qty', 'Chosen Supplier', 'Unit Cost', 'Line Total'],
    summaryRows.sort((a, b) => a.inventoryLine - b.inventoryLine).map(row => row.cells));
  return content === null ? null : { supplierCsvs, summaryCsv: { filename: orderFilenames.summary, content } };
}

type Fingerprint = { filename: string; sha256: string };

export function renderOrderPack({ summary, groups, quantityBasis, targetLocation, currency }:
  Pick<PurchaseOrderResult, 'summary' | 'groups' | 'quantityBasis' | 'targetLocation' | 'currency'>,
  { poReference, branding }: { poReference?: string; branding?: SignoffBrand },
  custody: { inventory: Fingerprint; suppliers: (Fingerprint & { label: string; selectedSheet: string | null })[]; workspaceProfile?: Fingerprint },
  outputFingerprints: Fingerprint[],
): string {
  const currencyLabel = currency ? escape(currency) + ' ' : '';
  const reference = poReference === undefined ? '' : `<p>PO reference <strong>${escape(poReference)}</strong></p>`;
  const location = targetLocation === null ? '' : `<p>Target location <strong>${escape(targetLocation)}</strong></p>`;
  const sections = groups.map(({ label, lines, unitsOrdered, totalSpend }, index) => `<section class="supplier" aria-labelledby="supplier-${index + 1}">
<h2 id="supplier-${index + 1}">${escape(label)}</h2><p>${unitsOrdered} units · Supplier subtotal <strong>${currencyLabel}${totalSpend}</strong></p>
<div class="order-table" tabindex="0" role="region" aria-labelledby="supplier-${index + 1}"><table>
<thead><tr><th scope="col">SKU</th><th scope="col">Supplier SKU</th><th scope="col">Order Qty</th><th scope="col">Lead Time Days</th><th scope="col">Unit Cost</th><th scope="col">Line Total</th></tr></thead>
<tbody>${lines.map(line => `<tr><th scope="row">${escape(line.sku)}</th><td>${escape(line.supplierSku)}</td><td>${line.orderQty}</td><td>${line.leadTimeDays ?? '—'}</td><td>${line.unitCost}</td><td>${line.lineTotal}</td></tr>`).join('\n')}</tbody>
</table></div></section>`).join('\n');
  const fingerprints = [[`Inventory · ${custody.inventory.filename}`, custody.inventory.sha256] as const,
    ...custody.suppliers.map(({ label, filename, selectedSheet, sha256 }) =>
      [`${label} · ${filename}${selectedSheet === null ? '' : ` · ${selectedSheet}`}`, sha256] as const),
    ...(custody.workspaceProfile ? [[`Workspace Profile · ${custody.workspaceProfile.filename}`, custody.workspaceProfile.sha256] as const] : []),
    ...outputFingerprints.map(({ filename, sha256 }) => [filename, sha256] as const),
  ];
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${offlineReportCsp}"><title>Purchase Order Pack</title>
<style>
*{box-sizing:border-box}body{max-width:72rem;margin:auto;padding:clamp(1rem,4vw,3rem);background:#f4f7f7;color:#152b2b;font:1rem/1.5 system-ui,sans-serif;overflow-wrap:anywhere}
h1{margin:0;font-size:clamp(1.8rem,5vw,2.8rem);line-height:1.1}h2{margin:0 0 .4rem}p{margin:.45rem 0 .8rem}
header{padding:1rem 0;border-top:.35rem solid #176252}section,footer{margin-top:1.25rem;border:1px solid #829b95;border-radius:.4rem;padding:1rem;background:#fff}
.order-table{overflow:auto}.order-table:focus-visible{outline:3px solid #176252;outline-offset:2px}table{width:100%;border-collapse:collapse}
th,td{text-align:left;vertical-align:top;padding:.5rem;border-bottom:1px solid #b7c6c4}thead{background:#e8f0ee}td:nth-child(n+3){white-space:nowrap;font-variant-numeric:tabular-nums}
dt{font-weight:650;margin-top:.5rem}dd{margin:0}footer code{overflow-wrap:anywhere}
@media screen and (max-width:40rem){.order-table table{min-width:36rem}.order-table :is(th,td:first-of-type){white-space:nowrap}}
@media print{body{margin:0;padding:0;background:#fff}section,footer{border:0;padding:0}.supplier+.supplier{break-before:page;page-break-before:always}.order-table{overflow:visible}th,td{padding:.3rem}tr{break-inside:avoid}}
</style></head><body><header><h1>Purchase Order Pack</h1>${reference}${location}
${quantityBasis === null ? '' : `<p>Inventory quantity basis <strong>${escape(quantityBasis)}</strong></p>`}
<p>${summary.belowReorder} SKUs below reorder · ${summary.unitsOrdered} units · ${summary.supplierCount} suppliers</p>
<p>Total PO Spend <strong>${currencyLabel}${summary.totalSpend}</strong></p></header>
<main>${sections || '<p>No replenishment lines to order.</p>'}</main>${custodyFooter(fingerprints)}</body></html>`;
  return brandSignoffHtml(html, branding).replaceAll('//', '&#47;/');
}
