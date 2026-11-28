import type { SignoffBrand } from '../../../core/branding/signoff-brand';
import type { ReconciliationResult } from '../../../core/reconciliation/payout-matcher';
import type { WorkerPage } from '../../../core/worker/protocol';

export interface ReconciliationJob {
  payouts: File;
  bank: File;
  maxLagDays: number;
  payoutCurrency?: string;
  bankCurrency?: string;
  branding?: SignoffBrand;
}

export type ReconciliationPreview = Pick<ReconciliationResult, 'status' | 'summary' | 'artifacts'>;
export type ReconciliationPair = ReconciliationResult['pairs'][number];
export type ReconciliationException = ReconciliationResult['exceptions'][number];
type Request = { type: 'reconcile'; job: ReconciliationJob }
  | { type: 'pairs' | 'exceptions'; page: number; pageSize: number };

interface Responses {
  reconcile: ReconciliationPreview;
  pairs: WorkerPage<ReconciliationPair>;
  exceptions: WorkerPage<ReconciliationException>;
}

type Value = Responses[keyof Responses];
export type ReconciliationMessage = { id: number; request: Request };
export type ReconciliationReply = { id: number } & ({ value: Value } | { error: string });

export class ReconciliationWorker {
  private readonly worker = new Worker(new URL('./payout-reconciliation.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve: (value: Value) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private stopped?: Error;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<ReconciliationReply>) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if ('error' in data) request.reject(new Error(data.error));
      else request.resolve(data.value);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.terminate(new Error('The local reconciliation worker stopped. Change the files or settings to try again.'));
    };
    this.worker.onmessageerror = () => this.terminate(new Error('The reconciliation worker returned an unreadable result.'));
  }

  request<R extends Request>(request: R): Promise<Responses[R['type']]> {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as Responses[R['type']]), reject });
      try {
        this.worker.postMessage({ id, request } satisfies ReconciliationMessage);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  terminate(error: Error = new DOMException('The reconciliation inputs changed.', 'AbortError')) {
    if (this.stopped) return;
    this.stopped = error;
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
