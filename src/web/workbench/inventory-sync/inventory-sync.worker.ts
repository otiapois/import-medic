import { buildInventorySync, inspectInventoryBaseline, inspectInventorySupplier } from '../../../core/inventory-sync/engine';
import type { InventorySource, InventorySyncResult } from '../../../core/inventory-sync/types';
import type { InventoryArtifact, InventoryMessage, InventoryReply, InventorySummary } from './inventoryWorker';

const scope = self as unknown as {
  onmessage: (event: MessageEvent<InventoryMessage>) => void;
  postMessage: (reply: InventoryReply, transfer?: Transferable[]) => void;
};

const ARTIFACTS: Record<InventoryArtifact, { filename: string; mime: string; read: (result: InventorySyncResult) => Uint8Array<ArrayBuffer> | string | null }> = {
  update: { filename: 'inventory-update.csv', mime: 'text/csv;charset=utf-8', read: (result) => result.updateCsv },
  rollback: { filename: 'inventory-rollback.csv', mime: 'text/csv;charset=utf-8', read: (result) => result.rollbackCsv },
  audit: { filename: 'inventory-audit.json', mime: 'application/json;charset=utf-8', read: (result) => result.auditJson },
  signoff: { filename: 'inventory-sign-off.html', mime: 'text/html;charset=utf-8', read: (result) => result.signOffHtml },
};

let version = 0;
let comparison: { id: number; result: InventorySyncResult } | undefined;

async function input(file: File): Promise<InventorySource> {
  return { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

function readPage<T>(rows: readonly T[], page: number, pageSize: number) {
  const start = page * pageSize;
  return { rows: rows.slice(start, start + pageSize), total: rows.length, page };
}

scope.onmessage = ({ data: { id, request } }) => {
  void (async () => {
    try {
      if (request.type === 'clear') {
        version += 1;
        comparison = undefined;
        scope.postMessage({ id, value: null });
        return;
      }
      if (request.type === 'inspectBaseline') {
        scope.postMessage({ id, value: inspectInventoryBaseline(await input(request.file)) });
        return;
      }
      if (request.type === 'inspectSupplier') {
        const source = { ...await input(request.file), sheetName: request.sheetName };
        scope.postMessage({ id, value: inspectInventorySupplier(source) });
        return;
      }
      if (request.type === 'build') {
        const revision = ++version;
        comparison = undefined;
        const { baseline, suppliers, options } = request.job;
        const [baselineSource, supplierSources] = await Promise.all([
          input(baseline),
          Promise.all(suppliers.map(async ({ file, sheetName, mapping }) => ({ ...await input(file), sheetName, mapping }))),
        ]);
        if (revision !== version) throw new Error('Inventory inputs changed.');
        const result = await buildInventorySync(baselineSource, supplierSources, options);
        if (revision !== version) throw new Error('Inventory inputs changed.');
        comparison = { id: request.comparisonId, result };
        const { status, targetLocation, totals, custody, verification, issues, rows } = result;
        const value = {
          status, targetLocation, totals, custody, verification, rowCount: rows.length, issueCount: issues.length,
          approvalCount: issues.filter(({ code }) => code === 'large-stock-drop').length,
        } satisfies InventorySummary;
        scope.postMessage({ id, value });
        return;
      }
      if (comparison?.id !== request.comparisonId) throw new Error('Wait for the current inventory review.');
      const { result } = comparison;
      if (request.type === 'rows') {
        const search = request.search.trim().toLowerCase();
        const rows = request.filter === 'all' && !search ? result.rows : result.rows.filter(({ sku, status }) => (
          (request.filter === 'all' || (request.filter === 'review' ? status === 'blocked' || status === 'approval-required'
            : status === request.filter)) && sku.toLowerCase().includes(search)
        ));
        scope.postMessage({ id, value: readPage(rows, request.page, request.pageSize) });
        return;
      }
      if (request.type === 'issues') {
        scope.postMessage({ id, value: readPage(result.issues, request.page, request.pageSize) });
        return;
      }
      const { filename, mime, read } = ARTIFACTS[request.artifact];
      const content = read(result);
      if (content === null) throw new Error('The inventory CSV is held for review.');
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content).buffer : content.slice().buffer;
      scope.postMessage({ id, value: { filename, bytes, mime } }, [bytes]);
    } catch (error) {
      scope.postMessage({ id, error: error instanceof Error ? error.message : 'Inventory Sync could not finish.' });
    }
  })();
};
