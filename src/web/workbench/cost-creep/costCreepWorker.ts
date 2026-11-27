import type {
  CostCreepIssue, CostCreepMapping, CostCreepOptions, CostCreepResult, CostCreepRow, CostCreepSourceInspection, costCreepFilenames,
} from '../../../core/cost-creep/types';
import type { WorkerDownload, WorkerPage } from '../../../core/worker/protocol';

export interface BrowserCostSource {
  key: number | 'retail';
  fileId: number;
  file: File;
  sheetName?: string;
}

type MappedSource = BrowserCostSource & { mapping?: CostCreepMapping };
export type CostCreepArtifact = keyof typeof costCreepFilenames;
export type CostCreepFilter = 'all' | 'threshold' | 'consecutive' | 'lifecycle' | 'margin';
export type CostCreepRunSummary = Pick<CostCreepResult, 'status' | 'summary' | 'custody'> & { issueCount: number };
export type BrowserCostSourceInspection = Omit<CostCreepSourceInspection, 'issues'> & { firstIssue?: string };

export interface CostCreepRun {
  periods: (MappedSource & { label: string })[];
  retail?: MappedSource & { currency?: string };
  currency?: string;
  threshold: string;
  branding?: CostCreepOptions['branding'];
}

type Request =
  | { type: 'inspect'; source: BrowserCostSource }
  | { type: 'clear'; key: BrowserCostSource['key'] }
  | { type: 'build'; runId: number; run: CostCreepRun }
  | { type: 'rows'; runId: number; filter: CostCreepFilter; search: string; page: number; pageSize: number }
  | { type: 'issues'; runId: number; page: number; pageSize: number }
  | { type: 'download'; runId: number; artifact: CostCreepArtifact };

interface Responses {
  inspect: BrowserCostSourceInspection;
  clear: null;
  build: CostCreepRunSummary;
  rows: WorkerPage<CostCreepRow>;
  issues: WorkerPage<CostCreepIssue>;
  download: WorkerDownload;
}

type Value = Responses[keyof Responses];
export type CostCreepMessage = { id: number; request: Request };
export type CostCreepReply = { id: number } & ({ value: Value } | { error: string });

export class CostCreepWorker {
  private readonly worker = new Worker(new URL('./cost-creep.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve: (value: Value) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private stopped?: Error;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<CostCreepReply>) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if ('error' in data) request.reject(new Error(data.error));
      else request.resolve(data.value);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.terminate(new Error('The local cost creep worker stopped. Reload the page to try again.'));
    };
    this.worker.onmessageerror = () => this.terminate(new Error('The local cost creep worker returned an unreadable result.'));
  }

  request<R extends Request>(request: R): Promise<Responses[R['type']]> {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as Responses[R['type']]), reject });
      try {
        this.worker.postMessage({ id, request } satisfies CostCreepMessage);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  terminate(error: Error = new DOMException('The cost creep watchlist was closed.', 'AbortError')) {
    if (this.stopped) return;
    this.stopped = error;
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
