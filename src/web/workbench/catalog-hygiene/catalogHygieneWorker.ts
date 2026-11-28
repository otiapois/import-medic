import type { CatalogHygieneOptions, CatalogHygieneResult, CatalogHygieneSource } from '../../../core/catalog-hygiene/engine';

export interface CatalogHygieneInput {
  sources: { file: File; platform: CatalogHygieneSource['platform'] }[];
  options: CatalogHygieneOptions;
}

export type CatalogHygieneArtifact =
  | { kind: 'issuesCsv' | 'auditJson' | 'reportHtml' }
  | { kind: 'cleanedCsv' | 'rollbackCsv'; sourceIndex: number };

export type CatalogHygieneSummary = Pick<CatalogHygieneResult, 'status' | 'summary' | 'sources'> & {
  issueCount: number;
  issueTypes: { code: string; count: number }[];
};
export type CatalogHygieneIssue = CatalogHygieneResult['issues'][number];

type Request =
  | { type: 'audit'; input: CatalogHygieneInput }
  | { type: 'issues'; code: string; page: number; pageSize: number }
  | { type: 'download'; artifact: CatalogHygieneArtifact };

interface Response {
  audit: CatalogHygieneSummary;
  issues: { rows: readonly CatalogHygieneIssue[]; total: number; page: number };
  download: { filename: string; bytes: ArrayBuffer; mime: string };
}

type Value = Response[keyof Response];
export type CatalogHygieneMessage = { id: number; request: Request };
export type CatalogHygieneReply = { id: number } & ({ value: Value } | { error: string });

export class CatalogHygieneWorker {
  private readonly worker = new Worker(new URL('./catalog-hygiene.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve: (value: Value) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private stopped?: Error;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<CatalogHygieneReply>) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if ('error' in data) request.reject(new Error(data.error));
      else request.resolve(data.value);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.terminate(new Error('The local catalog audit stopped. Re-select a file or change a setting to run it again.'));
    };
    this.worker.onmessageerror = () => this.terminate(new Error('The local catalog audit returned an unreadable result.'));
  }

  request<R extends Request>(request: R): Promise<Response[R['type']]> {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as Response[R['type']]), reject });
      try {
        this.worker.postMessage({ id, request } satisfies CatalogHygieneMessage);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  terminate(error: Error = new DOMException('The catalog audit inputs changed.', 'AbortError')) {
    if (this.stopped) return;
    this.stopped = error;
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
