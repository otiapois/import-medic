import type { allocateLandedCost } from '../../../core/landed-cost/allocator';
import type { WorkerDownload, WorkerPage } from '../../../core/worker/protocol';

type Allocation = Awaited<ReturnType<typeof allocateLandedCost>>;
export type LandedCostOptions = Parameters<typeof allocateLandedCost>[0]['options'];
export type LandedCostRow = Allocation['rows'][number];
export type LandedCostIssue = Allocation['issues'][number];
export type LandedCostArtifact = 'csv' | 'audit' | 'html';
export type LandedCostSummary = Pick<Allocation, 'status' | 'totals'> & {
  rowCount: number;
  issueCount: number;
};

type Request =
  | { type: 'worksheets'; file: File }
  | { type: 'build'; file: File; sheetName?: string; options: LandedCostOptions }
  | { type: 'rows'; page: number; pageSize: number }
  | { type: 'issues'; page: number; pageSize: number }
  | { type: 'download'; artifact: LandedCostArtifact };

interface Responses {
  worksheets: string[];
  build: LandedCostSummary;
  rows: WorkerPage<LandedCostRow>;
  issues: WorkerPage<LandedCostIssue>;
  download: WorkerDownload;
}

type Value = Responses[keyof Responses];
export type LandedCostMessage = { id: number; request: Request };
export type LandedCostReply = { id: number } & ({ value: Value } | { error: string });

export class LandedCostWorker {
  private readonly worker = new Worker(new URL('./landed-cost.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve: (value: Value) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private stopped?: Error;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<LandedCostReply>) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if ('error' in data) request.reject(new Error(data.error));
      else request.resolve(data.value);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.terminate(new Error('The local landed-cost worker stopped. Replace the file or change a setting to try again.'));
    };
    this.worker.onmessageerror = () => this.terminate(new Error('The local landed-cost worker returned an unreadable result.'));
  }

  request<R extends Request>(request: R): Promise<Responses[R['type']]> {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as Responses[R['type']]), reject });
      try {
        this.worker.postMessage({ id, request } satisfies LandedCostMessage);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  terminate(error: Error = new DOMException('The landed-cost inputs changed.', 'AbortError')) {
    if (this.stopped) return;
    this.stopped = error;
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
