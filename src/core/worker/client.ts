import { invalidatesResult, resultScope, supersededResult } from './protocol';
import type { ResultScope, WorkerMessage, WorkerProgress, WorkerReply, WorkerRequest, WorkerResult } from './protocol';

interface Pending {
  resolve: (result: WorkerResult) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: WorkerProgress) => void;
  scope?: ResultScope;
}

export class WorkbenchWorker {
  private readonly worker = new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private stopped: Error | undefined;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      if (data.kind === 'progress') {
        pending.onProgress?.(data.progress);
      } else {
        this.pending.delete(data.id);
        if (data.kind === 'result') pending.resolve(data.value);
        else pending.reject(new Error(data.message));
      }
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.terminate(new Error('The local processing worker could not finish. Restart the job to try again.'));
    };
    this.worker.onmessageerror = () => this.terminate(new Error('The local processing worker returned an unreadable result.'));
  }

  request<R extends WorkerRequest>(request: R, onProgress?: (progress: WorkerProgress) => void): Promise<WorkerResult<R>> {
    if (this.stopped) return Promise.reject(this.stopped);
    const invalidated = invalidatesResult(request);
    if (invalidated) {
      for (const [id, pending] of this.pending) {
        if (pending.scope !== invalidated) continue;
        this.pending.delete(id);
        pending.reject(new DOMException(supersededResult, 'AbortError'));
      }
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (result) => resolve(result as WorkerResult<R>), reject, onProgress, scope: resultScope(request) });
      try {
        this.worker.postMessage({ id, request } satisfies WorkerMessage);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  terminate(reason: Error = new DOMException('Local processing was canceled.', 'AbortError')): void {
    if (this.stopped) return;
    this.stopped = reason;
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(reason);
    this.pending.clear();
  }
}
