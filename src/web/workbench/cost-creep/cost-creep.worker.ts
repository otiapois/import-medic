import { buildCostCreep, inspectCostCreepSource } from '../../../core/cost-creep/engine';
import { costCreepFilenames } from '../../../core/cost-creep/types';
import type { CostCreepResult, CostCreepRow } from '../../../core/cost-creep/types';
import type { BrowserCostSource, CostCreepFilter, CostCreepMessage, CostCreepReply, CostCreepRunSummary } from './costCreepWorker';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<CostCreepMessage>) => void;
  postMessage: (reply: CostCreepReply, transfer?: Transferable[]) => void;
};

const files = new Map<BrowserCostSource['key'], { fileId: number; bytes: Uint8Array }>();
let comparison: { id: number; result: CostCreepResult } | undefined;

async function localSource({ key, fileId, file, sheetName }: BrowserCostSource) {
  let cached = files.get(key);
  if (cached?.fileId !== fileId) {
    cached = { fileId, bytes: new Uint8Array(await file.arrayBuffer()) };
    files.set(key, cached);
  }
  return { bytes: cached.bytes, filename: file.name, sheetName };
}

function readPage<T>(items: T[], page: number, pageSize: number) {
  const start = page * pageSize;
  return { rows: items.slice(start, start + pageSize), total: items.length, page };
}

const FILTERS = {
  all: () => true,
  threshold: (row) => row.meetsThreshold,
  consecutive: (row) => row.consecutiveHikes >= 2,
  lifecycle: (row) => row.lifecycle !== 'active-all-periods',
  margin: (row) => row.margin !== null,
} satisfies Record<CostCreepFilter, (row: CostCreepRow) => boolean>;

const MIME = {
  historyCsv: 'text/csv;charset=utf-8',
  auditJson: 'application/json;charset=utf-8',
  briefHtml: 'text/html;charset=utf-8',
};

let queue = Promise.resolve();
scope.onmessage = ({ data: { id, request } }) => {
  queue = queue.then(async () => {
    try {
      if (request.type === 'clear') {
        files.delete(request.key);
        comparison = undefined;
        scope.postMessage({ id, value: null });
        return;
      }
      if (request.type === 'inspect') {
        comparison = undefined;
        const source = await localSource(request.source);
        const { issues, ...inspection } = inspectCostCreepSource(source, request.source.key === 'retail' ? 'retail' : 'period');
        scope.postMessage({ id, value: { ...inspection, firstIssue: issues[0]?.message } });
        return;
      }
      if (request.type === 'build') {
        comparison = undefined;
        const { periods, retail, currency, threshold, branding } = request.run;
        const [periodSources, retailSource] = await Promise.all([
          Promise.all(periods.map(async (period) => ({
            ...await localSource(period), label: period.label, mapping: period.mapping,
          }))),
          retail ? localSource(retail).then((source) => ({ ...source, mapping: retail.mapping, currency: retail.currency })) : undefined,
        ]);
        const result = await buildCostCreep(periodSources, {
          creepThresholdPercent: threshold, retail: retailSource, currency, branding,
        });
        comparison = { id: request.runId, result };
        const { status, summary, custody, issues } = result;
        scope.postMessage({ id, value: { status, summary, custody, issueCount: issues.length } satisfies CostCreepRunSummary });
        return;
      }
      if (comparison?.id !== request.runId) throw new Error('The cost creep analysis changed. Wait for the current result.');
      const { result } = comparison;
      if (request.type === 'rows') {
        const search = request.search.trim().toLowerCase();
        const include = FILTERS[request.filter];
        const rows = request.filter === 'all' && !search ? result.rows : result.rows.filter((row) =>
          include(row) && (!search || row.sku.toLowerCase().includes(search)));
        scope.postMessage({ id, value: readPage(rows, request.page, request.pageSize) });
        return;
      }
      if (request.type === 'issues') {
        scope.postMessage({ id, value: readPage(result.issues, request.page, request.pageSize) });
        return;
      }
      const { artifact } = request;
      const content = result[artifact];
      if (content === null || (artifact !== 'auditJson' && result.status !== 'ready')) {
        throw new Error('This report is held. Review the current cost creep analysis.');
      }
      const bytes = new TextEncoder().encode(content).buffer;
      scope.postMessage({ id, value: { bytes, filename: costCreepFilenames[artifact], mime: MIME[artifact] } }, [bytes]);
    } catch (error) {
      scope.postMessage({ id, error: error instanceof Error ? error.message : 'The cost creep analysis could not finish.' });
    }
  });
};
