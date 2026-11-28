import type {
  PurchaseOrderInventoryInspection, PurchaseOrderIssue, PurchaseOrderOptions, PurchaseOrderResult,
  PurchaseOrderSupplierGroup, PurchaseOrderSupplierInspection,
} from '../../../core/purchase-order/types';
import type { WorkerDownload, WorkerPage } from '../../../core/worker/protocol';

export interface PurchaseOrderJob {
  inventory: File;
  suppliers: { file: File; label: string; sheetName?: string }[];
  options: PurchaseOrderOptions;
}

export type PurchaseOrderArtifact = 'summary' | 'audit' | 'html' | number;
export type PurchaseOrderReport = Pick<PurchaseOrderResult, 'status' | 'targetLocation' | 'quantityBasis' | 'currency' | 'summary'> & {
  suppliers: (Pick<PurchaseOrderSupplierGroup, 'supplierIndex' | 'label' | 'unitsOrdered' | 'totalSpend'> & { skuCount: number })[];
  issueCount: number;
};

type Request =
  | { type: 'inspectInventory'; file: File }
  | { type: 'inspectSupplier'; file: File; sheetName?: string }
  | { type: 'build'; runId: number; job: PurchaseOrderJob }
  | { type: 'clear' }
  | { type: 'issues'; runId: number; page: number; pageSize: number }
  | { type: 'download'; runId: number; artifact: PurchaseOrderArtifact };

interface Responses {
  inspectInventory: PurchaseOrderInventoryInspection;
  inspectSupplier: PurchaseOrderSupplierInspection;
  build: PurchaseOrderReport;
  clear: null;
  issues: WorkerPage<PurchaseOrderIssue>;
  download: WorkerDownload;
}

type Value = Responses[keyof Responses];
export type PurchaseOrderMessage = { id: number; request: Request };
export type PurchaseOrderReply = { id: number } & ({ value: Value } | { error: string });

export class PurchaseOrderWorker {
  private readonly worker = new Worker(new URL('./purchase-order.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve: (value: Value) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private stopped?: Error;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<PurchaseOrderReply>) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if ('error' in data) request.reject(new Error(data.error));
      else request.resolve(data.value);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.terminate(new Error('The local purchase order worker stopped. Reload the page to try again.'));
    };
    this.worker.onmessageerror = () => this.terminate(new Error('The purchase order worker returned an unreadable result.'));
  }

  request<R extends Request>(request: R): Promise<Responses[R['type']]> {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as Responses[R['type']]), reject });
      try {
        this.worker.postMessage({ id, request } satisfies PurchaseOrderMessage);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  terminate(error: Error = new DOMException('The purchase order planner was closed.', 'AbortError')) {
    if (this.stopped) return;
    this.stopped = error;
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
