import type { SignoffBrand } from '../../../core/branding/signoff-brand';
import type { StorePlatform } from '../../../core/shopify-price-diff/workspace-profile';
import type { WholesaleBuyerRow, WholesaleIssue, WholesaleOptions, WholesalePriceList } from '../../../core/wholesale-pricelist/engine';

export type WholesaleArtifact = keyof WholesalePriceList['fileNames'];
export type WholesaleSettings = Omit<WholesaleOptions, 'costSheet'>;
export type WholesaleSummary = Pick<WholesalePriceList, 'canExport' | 'custody'> & {
  buyerCount: number;
  internalCount: number;
  issueCount: number;
  hasInternalCsv: boolean;
};

interface Page<T> { rows: readonly T[]; total: number; page: number }

type Request =
  | { type: 'worksheets'; file: File }
  | { type: 'build'; platform: StorePlatform; baseline: File; costSheet?: File; settings: WholesaleSettings; branding?: SignoffBrand }
  | { type: 'buyerRows' | 'internalRows' | 'issues'; page: number; pageSize: number }
  | { type: 'download'; artifact: WholesaleArtifact };

interface Response {
  worksheets: string[];
  build: WholesaleSummary;
  buyerRows: Page<WholesaleBuyerRow>;
  internalRows: Page<WholesalePriceList['rows'][number]>;
  issues: Page<WholesaleIssue>;
  download: { filename: string; mime: string; bytes: ArrayBuffer };
}

type Value = Response[keyof Response];

export type WholesaleMessage = { id: number; request: Request };
export type WholesaleReply = { id: number } & ({ value: Value } | { error: string });

export class WholesaleWorker {
  private readonly worker = new Worker(new URL('./wholesale.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve: (value: Value) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private stopped?: Error;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<WholesaleReply>) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if ('error' in data) request.reject(new Error(data.error));
      else request.resolve(data.value);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.terminate(new Error('The local wholesale worker stopped. Change a setting or reload a file to try again.'));
    };
    this.worker.onmessageerror = () => this.terminate(new Error('The local wholesale worker returned an unreadable result.'));
  }

  request<R extends Request>(request: R): Promise<Response[R['type']]> {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.worker.postMessage({ id, request } satisfies WholesaleMessage);
      this.pending.set(id, { resolve: (value) => resolve(value as Response[R['type']]), reject });
    });
  }

  terminate(error: Error = new DOMException('The wholesale inputs changed.', 'AbortError')) {
    if (this.stopped) return;
    this.stopped = error;
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
