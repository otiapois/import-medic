import type { PromoCampaign, PromoCampaignIssue, PromoCampaignOptions, PromoCampaignRow } from '../../../core/promo-campaign/types';
import type { SignoffBrand } from '../../../core/branding/signoff-brand';
import type { StorePlatform } from '../../../core/shopify-price-diff/workspace-profile';

export type CampaignSummary = Pick<PromoCampaign, 'canExport' | 'custody' | 'summary'> & { issueCount: number; rowCount: number };
export type CampaignArtifact = keyof PromoCampaign['fileNames'];

export interface CampaignDownload {
  filename: string;
  mime: string;
  bytes: ArrayBuffer;
}

interface Page<T> { rows: T[]; total: number; page: number }

type Request =
  | { type: 'build'; platform: StorePlatform; baseline: File; costSheet?: File; options: PromoCampaignOptions }
  | { type: 'rows' | 'issues'; page: number; pageSize: number }
  | { type: 'download'; artifact: CampaignArtifact; branding?: SignoffBrand };

interface Response {
  build: CampaignSummary;
  rows: Page<PromoCampaignRow>;
  issues: Page<PromoCampaignIssue>;
  download: CampaignDownload;
}

type Value = Response[keyof Response];

export type CampaignMessage = { id: number; request: Request };
export type CampaignReply = { id: number } & ({ value: Value } | { error: string });

export class CampaignWorker {
  private readonly worker = new Worker(new URL('./campaign.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve: (value: Value) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private stopped?: Error;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<CampaignReply>) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if ('error' in data) request.reject(new Error(data.error));
      else request.resolve(data.value);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.terminate(new Error('The local campaign worker stopped. Change a setting or reload the file to try again.'));
    };
    this.worker.onmessageerror = () => this.terminate(new Error('The local campaign worker returned an unreadable result.'));
  }

  request<R extends Request>(request: R): Promise<Response[R['type']]> {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.worker.postMessage({ id, request } satisfies CampaignMessage);
      this.pending.set(id, { resolve: (value) => resolve(value as Response[R['type']]), reject });
    });
  }

  terminate(error: Error = new DOMException('The campaign settings changed.', 'AbortError')) {
    if (this.stopped) return;
    this.stopped = error;
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
