import { buildPurchaseOrder, inspectPurchaseOrderInventory, inspectPurchaseOrderSupplier } from '../../../core/purchase-order/engine';
import type { PurchaseOrderResult, PurchaseOrderSource } from '../../../core/purchase-order/types';
import type { PurchaseOrderMessage, PurchaseOrderReply, PurchaseOrderReport } from './purchaseOrderWorker';

const scope = self as unknown as {
  onmessage: (event: MessageEvent<PurchaseOrderMessage>) => void;
  postMessage: (reply: PurchaseOrderReply, transfer?: Transferable[]) => void;
};

let revision = 0;
let report: { id: number; result: PurchaseOrderResult } | undefined;

async function readFile(file: File): Promise<PurchaseOrderSource> {
  return { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

scope.onmessage = ({ data: { id, request } }) => {
  void (async () => {
    try {
      if (request.type === 'clear') {
        revision += 1;
        report = undefined;
        scope.postMessage({ id, value: null });
        return;
      }
      if (request.type === 'inspectInventory') {
        scope.postMessage({ id, value: inspectPurchaseOrderInventory(await readFile(request.file)) });
        return;
      }
      if (request.type === 'inspectSupplier') {
        const source = await readFile(request.file);
        scope.postMessage({ id, value: inspectPurchaseOrderSupplier({ ...source, sheetName: request.sheetName }) });
        return;
      }
      if (request.type === 'build') {
        const current = ++revision;
        report = undefined;
        const { inventory, suppliers, options } = request.job;
        const [stock, catalogs] = await Promise.all([
          readFile(inventory),
          Promise.all(suppliers.map(async ({ file, label, sheetName }) => ({ ...await readFile(file), label, sheetName }))),
        ]);
        if (current !== revision) throw new Error('The purchase order inputs changed.');
        const result = await buildPurchaseOrder(stock, catalogs, options);
        if (current !== revision) throw new Error('The purchase order inputs changed.');
        report = { id: request.runId, result };
        const { status, targetLocation, quantityBasis, currency, summary, groups, issues } = result;
        const value = {
          status, targetLocation, quantityBasis, currency, summary, issueCount: issues.length,
          suppliers: groups.map(({ supplierIndex, label, lines, unitsOrdered, totalSpend }) => ({
            supplierIndex, label, skuCount: lines.length, unitsOrdered, totalSpend,
          })),
        } satisfies PurchaseOrderReport;
        scope.postMessage({ id, value });
        return;
      }
      if (report?.id !== request.runId) throw new Error('Wait for the current purchase order review.');
      const { result } = report;
      if (request.type === 'issues') {
        const start = request.page * request.pageSize;
        scope.postMessage({ id, value: { rows: result.issues.slice(start, start + request.pageSize), total: result.issues.length, page: request.page } });
        return;
      }
      const { artifact } = request;
      const download = artifact === 'audit' ? result.auditJson : artifact === 'summary' ? result.summaryCsv
        : artifact === 'html' ? result.packHtml : result.supplierCsvs.find(({ supplierIndex }) => supplierIndex === artifact);
      if (!download) throw new Error('This purchase order file is held for review.');
      const mime = artifact === 'audit' ? 'application/json;charset=utf-8' : artifact === 'html' ? 'text/html;charset=utf-8' : 'text/csv;charset=utf-8';
      const bytes = new TextEncoder().encode(download.content).buffer;
      scope.postMessage({ id, value: { filename: download.filename, bytes, mime } }, [bytes]);
    } catch (error) {
      scope.postMessage({ id, error: error instanceof Error ? error.message : 'The local purchase order operation could not finish.' });
    }
  })();
};
