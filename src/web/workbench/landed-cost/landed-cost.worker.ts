import { allocateLandedCost, landedCostFilenames } from '../../../core/landed-cost/allocator';
import { listWorkbookSheets } from '../../../core/xlsx';
import type { LandedCostMessage, LandedCostReply, LandedCostSummary } from './landedCostWorker';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<LandedCostMessage>) => void;
  postMessage: (reply: LandedCostReply, transfer?: Transferable[]) => void;
};

const MIME = { csv: 'text/csv;charset=utf-8', audit: 'application/json;charset=utf-8', html: 'text/html;charset=utf-8' };
let result: Awaited<ReturnType<typeof allocateLandedCost>> | undefined;

function readPage<T>(rows: readonly T[], page: number, pageSize: number) {
  const start = page * pageSize;
  return { rows: rows.slice(start, start + pageSize), total: rows.length, page };
}

scope.onmessage = async ({ data: { id, request } }) => {
  try {
    if (request.type === 'worksheets') {
      const value = listWorkbookSheets(new Uint8Array(await request.file.arrayBuffer()));
      scope.postMessage({ id, value });
      return;
    }
    if (request.type === 'build') {
      const { file, sheetName, options } = request;
      const bytes = new Uint8Array(await file.arrayBuffer());
      result = await allocateLandedCost({ source: { bytes, name: file.name, sheetName }, options });
      const { status, rows, issues, totals } = result;
      const value = { status, totals, rowCount: rows.length, issueCount: issues.length } satisfies LandedCostSummary;
      scope.postMessage({ id, value });
      return;
    }
    if (!result) throw new Error('The landed-cost calculation is still processing.');
    if (request.type !== 'download') {
      const value = request.type === 'rows'
        ? readPage(result.rows, request.page, request.pageSize)
        : readPage(result.issues, request.page, request.pageSize);
      scope.postMessage({ id, value });
      return;
    }
    const { artifact } = request;
    const content = artifact === 'audit' ? result.files.audit : result.status === 'ready' ? result.files[artifact] : undefined;
    if (content === undefined) throw new Error('This download is held. Review the current shipment checks.');
    const bytes = new TextEncoder().encode(content).buffer;
    scope.postMessage({ id, value: { filename: landedCostFilenames[artifact], mime: MIME[artifact], bytes } }, [bytes]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : 'The local landed-cost calculation could not finish.' });
  }
};
