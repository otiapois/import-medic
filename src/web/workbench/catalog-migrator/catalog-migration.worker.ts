import { brandCatalogMigrationReports, buildCatalogMigration } from '../../../core/catalog-migrator/engine';
import type { WorkerPage } from '../../../core/worker/protocol';
import type { CatalogArtifact, CatalogPreviewRow, CatalogRun, MigrationMessage, MigrationReply } from './migrationWorker';

type Migration = Awaited<ReturnType<typeof buildCatalogMigration>>;

const MIME: Record<CatalogArtifact, string> = {
  targetCsv: 'text/csv;charset=utf-8',
  auditJson: 'application/json;charset=utf-8',
  signOffHtml: 'text/html;charset=utf-8',
};

function readPage<T>(rows: T[], page: number, pageSize: number): WorkerPage<T> {
  const start = page * pageSize;
  return { rows: rows.slice(start, start + pageSize), total: rows.length, page };
}

function readRows(preview: Migration['preview'], dialect: CatalogRun['targetDialect'], page: number, pageSize: number): WorkerPage<CatalogPreviewRow> {
  if (!preview) return { rows: [], total: 0, page };
  const { rows, headers } = preview;
  const field = headers.indexOf(dialect === 'shopify' ? 'Handle' : dialect === 'woocommerce' ? 'Type' : 'Item');
  const result = readPage(rows, page, pageSize);
  return {
    ...result,
    rows: result.rows.map((cells, index) => {
      const rowIndex = page * pageSize + index;
      const marker = cells[field];
      const nextMarker = rows[rowIndex + 1]?.[field];
      let kind = 'Product';
      if (dialect === 'shopify') {
        if (rowIndex > 0 && rows[rowIndex - 1][field] === marker) kind = 'Variant';
        else if (nextMarker === marker) kind = 'Parent + variant';
      } else if (marker === 'variation' || marker === 'Variant') kind = 'Variant';
      else if (marker === 'variable' || nextMarker === 'Variant') kind = 'Parent';
      return { kind, cells };
    }),
  };
}

const scope = self as unknown as {
  onmessage: (event: MessageEvent<MigrationMessage>) => void;
  postMessage: (reply: MigrationReply, transfer?: Transferable[]) => void;
};

let migration: Migration | undefined;
let issues: Migration['issues'] = [];

scope.onmessage = ({ data: { id, request } }) => {
  void (async () => {
    try {
      if (request.type === 'build') {
        const { source, target, file } = request;
        const result = await buildCatalogMigration(source, target, new Uint8Array(await file.arrayBuffer()), file.name);
        migration = result;
        const blocked = result.issues.filter(({ level }) => level === 'blocked');
        issues = [...blocked, ...result.issues.filter(({ level }) => level !== 'blocked')];
        const { sourceFilename, sourceDialect, targetDialect, mapping, unmappedColumns, summary, custody, preview, artifacts } = result;
        const value: CatalogRun = {
          sourceFilename, sourceDialect, targetDialect, mapping, unmappedColumns, summary, custody,
          ready: artifacts.targetCsv !== null, headers: preview?.headers ?? [], rowCount: preview?.rows.length ?? 0,
          issueCount: issues.length, blockedIssueCount: blocked.length,
        };
        scope.postMessage({ id, value });
        return;
      }
      if (!migration) throw new Error('Wait for the migration review.');
      if (request.type === 'rows') {
        scope.postMessage({ id, value: readRows(migration.preview, migration.targetDialect, request.page, request.pageSize) });
        return;
      }
      if (request.type === 'issues') {
        scope.postMessage({ id, value: readPage(issues, request.page, request.pageSize) });
        return;
      }
      if (request.type === 'signoffFingerprint') {
        const branded = await brandCatalogMigrationReports(migration, request.branding);
        scope.postMessage({ id, value: branded.signOffSha256 });
        return;
      }
      if (request.type === 'download') {
        const key = request.artifact;
        const artifact = key === 'targetCsv' || !request.branding
          ? migration.artifacts[key]
          : (await brandCatalogMigrationReports(migration, request.branding))[key];
        if (!artifact) throw new Error('Review the source issues before downloading the target CSV.');
        const bytes = artifact.bytes.slice().buffer as ArrayBuffer;
        scope.postMessage({ id, value: { filename: artifact.filename, mime: MIME[request.artifact], bytes } }, [bytes]);
      }
    } catch (error) {
      scope.postMessage({ id, error: error instanceof Error ? error.message : 'The catalog migration could not finish.' });
    }
  })();
};
