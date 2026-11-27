import type { buildCatalogMigration } from '../../../core/catalog-migrator/engine';
import type { WorkerDownload, WorkerPage } from '../../../core/worker/protocol';

type Migration = Awaited<ReturnType<typeof buildCatalogMigration>>;
export type CatalogPlatform = Migration['sourcePlatform'];
export type CatalogArtifact = keyof Migration['artifacts'];
export type CatalogIssue = Migration['issues'][number];
export type CatalogPreviewRow = { kind: string; cells: string[] };
export type CatalogRun = Pick<Migration, 'sourceFilename' | 'sourceDialect' | 'targetDialect' | 'mapping' | 'unmappedColumns' | 'summary' | 'custody'> & {
  ready: boolean;
  headers: string[];
  rowCount: number;
  issueCount: number;
  blockedIssueCount: number;
};

interface PageRequest { page: number; pageSize: number }

type Request =
  | { type: 'build'; source: CatalogPlatform; target: CatalogPlatform; file: File }
  | ({ type: 'rows' | 'issues' } & PageRequest)
  | { type: 'download'; artifact: CatalogArtifact };

interface Responses {
  build: CatalogRun;
  rows: WorkerPage<CatalogPreviewRow>;
  issues: WorkerPage<CatalogIssue>;
  download: WorkerDownload;
}

type Value = Responses[keyof Responses];
export type MigrationMessage = { id: number; request: Request };
export type MigrationReply = { id: number } & ({ value: Value } | { error: string });

export class MigrationWorker {
  private readonly worker = new Worker(new URL('./catalog-migration.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve: (value: Value) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private stopped?: Error;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<MigrationReply>) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if ('error' in data) request.reject(new Error(data.error));
      else request.resolve(data.value);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.terminate(new Error('The local migration worker stopped. Choose the file again to retry.'));
    };
    this.worker.onmessageerror = () => this.terminate(new Error('The local migration worker returned an unreadable result.'));
  }

  request<R extends Request>(request: R): Promise<Responses[R['type']]> {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as Responses[R['type']]), reject });
      try {
        this.worker.postMessage({ id, request } satisfies MigrationMessage);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  terminate(error: Error = new DOMException('The migration selection changed.', 'AbortError')) {
    if (this.stopped) return;
    this.stopped = error;
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
