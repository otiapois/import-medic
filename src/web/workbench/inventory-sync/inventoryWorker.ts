import type {
  InventoryBaselineInspection, InventoryIssue, InventoryMapping, InventorySupplierInspection, InventorySyncOptions,
  InventorySyncResult, InventorySyncRow,
} from '../../../core/inventory-sync/types';
import type { WorkerDownload, WorkerPage } from '../../../core/worker/protocol';

export type InventoryArtifact = 'update' | 'rollback' | 'audit' | 'signoff';
export type InventoryFilter = 'all' | 'changed' | 'review' | 'no-supplier-match';
export type InventorySummary = Pick<InventorySyncResult, 'status' | 'targetLocation' | 'totals' | 'custody' | 'verification'> & {
  rowCount: number;
  issueCount: number;
  approvalCount: number;
};

export interface InventoryJob {
  baseline: File;
  suppliers: { file: File; sheetName?: string; mapping?: InventoryMapping }[];
  options: InventorySyncOptions;
}

type PageQuery = { comparisonId: number; page: number; pageSize: number };
type Request =
  | { type: 'inspectBaseline'; file: File }
  | { type: 'inspectSupplier'; file: File; sheetName?: string }
  | { type: 'build'; comparisonId: number; job: InventoryJob }
  | { type: 'clear' }
  | ({ type: 'rows'; filter: InventoryFilter; search: string } & PageQuery)
  | ({ type: 'issues' } & PageQuery)
  | { type: 'download'; comparisonId: number; artifact: InventoryArtifact };

interface Responses {
  inspectBaseline: InventoryBaselineInspection;
  inspectSupplier: InventorySupplierInspection;
  build: InventorySummary;
  clear: null;
  rows: WorkerPage<InventorySyncRow>;
  issues: WorkerPage<InventoryIssue>;
  download: WorkerDownload;
}

type Value = Responses[keyof Responses];
export type InventoryMessage = { id: number; request: Request };
export type InventoryReply = { id: number } & ({ value: Value } | { error: string });

export class InventoryWorker {
  private readonly worker = new Worker(new URL('./inventory-sync.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve: (value: Value) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private stopped?: Error;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<InventoryReply>) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if ('error' in data) request.reject(new Error(data.error));
      else request.resolve(data.value);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.terminate(new Error('The local inventory worker stopped. Reload the page to try again.'));
    };
    this.worker.onmessageerror = () => this.terminate(new Error('The local inventory worker returned an unreadable result.'));
  }

  request<R extends Request>(request: R): Promise<Responses[R['type']]> {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as Responses[R['type']]), reject });
      try {
        this.worker.postMessage({ id, request } satisfies InventoryMessage);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  terminate(error: Error = new DOMException('Inventory Sync was closed.', 'AbortError')) {
    if (this.stopped) return;
    this.stopped = error;
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
