import { brandSupplierDeltaReports, buildSupplierDelta, inspectSupplierDeltaSource } from '../../../core/supplier-delta/engine';
import type { DeltaFilter, DeltaInspection, DeltaMessage, DeltaReply, DeltaRow, DeltaSide, DeltaSummary } from './deltaWorker';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<DeltaMessage>) => void;
  postMessage: (reply: DeltaReply, transfer?: Transferable[]) => void;
};

type DeltaInput = Parameters<typeof inspectSupplierDeltaSource>[0];
type Source = { fileId: number; sourceId: number; input: DeltaInput };
const sources = new Map<DeltaSide, Source>();
let comparison: { id: number; result: Awaited<ReturnType<typeof buildSupplierDelta>>; filters: Map<DeltaFilter, DeltaRow[]> } | undefined;

function readPage<T>(items: T[], page: number, pageSize: number) {
  const start = page * pageSize;
  return { rows: items.slice(start, start + pageSize), total: items.length, page };
}

let queue = Promise.resolve();
scope.onmessage = ({ data: { id, request } }) => {
  queue = queue.then(async () => {
    try {
      if (request.type === 'clear') {
        sources.delete(request.side);
        comparison = undefined;
        scope.postMessage({ id, value: null });
        return;
      }
      if (request.type === 'inspect') {
        comparison = undefined;
        const cached = sources.get(request.side);
        const bytes = cached?.fileId === request.fileId ? cached.input.bytes : new Uint8Array(await request.file.arrayBuffer());
        const input = { bytes, filename: request.file.name, sheetName: request.sheetName };
        const { sheetNames, selectedSheet, headers, suggestions, rowCount, issues } = inspectSupplierDeltaSource(input);
        sources.set(request.side, { fileId: request.fileId, sourceId: request.sourceId, input });
        const value = { sheetNames, selectedSheet, headers, suggestions, rowCount, firstIssue: issues[0]?.message } satisfies DeltaInspection;
        scope.postMessage({ id, value });
        return;
      }
      if (request.type === 'build') {
        comparison = undefined;
        const { previous, next } = request.sources;
        const previousSource = sources.get('previous');
        const newSource = sources.get('next');
        if (previousSource?.sourceId !== previous.sourceId || newSource?.sourceId !== next.sourceId) {
          throw new Error('The selected supplier sheets changed. Wait for the new comparison.');
        }
        const result = await buildSupplierDelta(previousSource.input, newSource.input, { previous: previous.mapping, next: next.mapping });
        const filters = new Map<DeltaFilter, DeltaRow[]>();
        for (const row of result.rows) {
          if (row.status === 'unchanged') continue;
          const filter = row.status.startsWith('blocked-') ? 'blocked' : row.status as DeltaFilter;
          const rows = filters.get(filter);
          if (rows) rows.push(row);
          else filters.set(filter, [row]);
        }
        comparison = { id: request.comparisonId, result, filters };
        const { status, custody, counts, maxHikePercent, issues, rows } = result;
        const value = { status, custody, counts, maxHikePercent, issueCount: issues.length, rowCount: rows.length } satisfies DeltaSummary;
        scope.postMessage({ id, value });
        return;
      }
      if (comparison?.id !== request.comparisonId) throw new Error('The selected supplier sheets changed. Wait for the new comparison.');
      const { result, filters } = comparison;
      if (request.type === 'rows') {
        const rows = request.filter === 'all' ? result.rows : filters.get(request.filter) ?? [];
        scope.postMessage({ id, value: readPage(rows, request.page, request.pageSize) });
        return;
      }
      if (request.type === 'issues') {
        scope.postMessage({ id, value: readPage(result.issues, request.page, request.pageSize) });
        return;
      }
      if (request.type === 'signoffFingerprint') {
        const branded = await brandSupplierDeltaReports(result, request.branding);
        scope.postMessage({ id, value: branded.signOffHtmlSha256 });
        return;
      }
      const reports = request.artifact === 'csv' || !request.branding ? result : await brandSupplierDeltaReports(result, request.branding);
      const artifact = {
        csv: { content: result.deltaCsv, filename: 'supplier-delta-report.csv', mime: 'text/csv;charset=utf-8' },
        audit: { content: reports.auditJson, filename: 'supplier-delta-audit.json', mime: 'application/json;charset=utf-8' },
        signoff: { content: reports.signOffHtml, filename: 'supplier-delta-sign-off.html', mime: 'text/html;charset=utf-8' },
      }[request.artifact];
      if (artifact.content === null || (request.artifact !== 'audit' && result.status !== 'ready')) {
        throw new Error('This report is held. Review the current supplier delta.');
      }
      const bytes = new TextEncoder().encode(artifact.content).buffer;
      scope.postMessage({ id, value: { bytes, filename: artifact.filename, mime: artifact.mime } }, [bytes]);
    } catch (error) {
      scope.postMessage({ id, error: error instanceof Error ? error.message : 'The supplier delta could not finish.' });
    }
  });
};
