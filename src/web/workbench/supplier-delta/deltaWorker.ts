import type { buildSupplierDelta, inspectSupplierDeltaSource } from '../../../core/supplier-delta/engine';
import type { WorkerDownload, WorkerPage } from '../../../core/worker/protocol';

type DeltaResult = Awaited<ReturnType<typeof buildSupplierDelta>>;
type Inspection = ReturnType<typeof inspectSupplierDeltaSource>;
type CoreMappings = NonNullable<Parameters<typeof buildSupplierDelta>[2]>;
export type DeltaMapping = NonNullable<CoreMappings['previous']>;
export type DeltaSide = 'previous' | 'next';
export type DeltaRow = DeltaResult['rows'][number];
export type DeltaIssue = DeltaResult['issues'][number];
export type DeltaFilter = 'all' | 'cost-increased' | 'cost-decreased' | 'added-sku' | 'removed-sku' | 'blocked';
export type DeltaArtifact = 'csv' | 'audit' | 'signoff';
export type DeltaInspection = Pick<Inspection, 'sheetNames' | 'selectedSheet' | 'headers' | 'suggestions' | 'rowCount'> & { firstIssue?: string };
export type DeltaSummary = Pick<DeltaResult, 'status' | 'custody' | 'counts' | 'maxHikePercent'> & { rowCount: number; issueCount: number };

interface ComparisonSource {
  sourceId: number;
  mapping: DeltaMapping;
}

type Request =
  | { type: 'inspect'; side: DeltaSide; fileId: number; sourceId: number; file: File; sheetName?: string }
  | { type: 'clear'; side: DeltaSide }
  | { type: 'build'; comparisonId: number; sources: Record<DeltaSide, ComparisonSource> }
  | { type: 'rows'; comparisonId: number; filter: DeltaFilter; page: number; pageSize: number }
  | { type: 'issues'; comparisonId: number; page: number; pageSize: number }
  | { type: 'download'; comparisonId: number; artifact: DeltaArtifact };

interface Responses {
  inspect: DeltaInspection;
  clear: null;
  build: DeltaSummary;
  rows: WorkerPage<DeltaRow>;
  issues: WorkerPage<DeltaIssue>;
  download: WorkerDownload;
}

type Value = Responses[keyof Responses];
export type DeltaMessage = { id: number; request: Request };
export type DeltaReply = { id: number } & ({ value: Value } | { error: string });

export class DeltaWorker {
  private readonly worker = new Worker(new URL('./delta.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve: (value: Value) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private stopped?: Error;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<DeltaReply>) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if ('error' in data) request.reject(new Error(data.error));
      else request.resolve(data.value);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.terminate(new Error('The local supplier delta worker stopped. Reload the page to try again.'));
    };
    this.worker.onmessageerror = () => this.terminate(new Error('The local supplier delta worker returned an unreadable result.'));
  }

  request<R extends Request>(request: R): Promise<Responses[R['type']]> {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as Responses[R['type']]), reject });
      try {
        this.worker.postMessage({ id, request } satisfies DeltaMessage);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  terminate(error: Error = new DOMException('The supplier delta was closed.', 'AbortError')) {
    if (this.stopped) return;
    this.stopped = error;
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
