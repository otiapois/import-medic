import { buildWholesalePriceList } from '../../../core/wholesale-pricelist/engine';
import type { WholesalePriceList } from '../../../core/wholesale-pricelist/engine';
import { listWorkbookSheets } from '../../../core/xlsx';
import type { WholesaleArtifact, WholesaleMessage, WholesaleReply, WholesaleSummary } from './wholesaleWorker';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<WholesaleMessage>) => void;
  postMessage: (reply: WholesaleReply, transfer?: Transferable[]) => void;
};

const MIME = {
  buyer: 'text/csv;charset=utf-8', shopify: 'text/csv;charset=utf-8', lineSheet: 'text/html;charset=utf-8',
  internal: 'text/csv;charset=utf-8', audit: 'application/json;charset=utf-8',
} satisfies Record<WholesaleArtifact, string>;

let result: WholesalePriceList | undefined;

function readPage<T>(rows: readonly T[], page: number, pageSize: number) {
  const start = page * pageSize;
  return { rows: rows.slice(start, start + pageSize), total: rows.length, page };
}

scope.onmessage = async ({ data: { id, request } }) => {
  try {
    if (request.type === 'worksheets') {
      const sheets = listWorkbookSheets(new Uint8Array(await request.file.arrayBuffer()));
      scope.postMessage({ id, value: sheets });
      return;
    }
    if (request.type === 'build') {
      const [baseline, cost] = await Promise.all([request.baseline.arrayBuffer(), request.costSheet?.arrayBuffer()]);
      result = await buildWholesalePriceList(request.platform, new Uint8Array(baseline), {
        ...request.settings, ...(cost ? { costSheet: new Uint8Array(cost) } : {}),
      }, request.branding);
      const { canExport, custody, buyerRows, rows, issues, internalCsv } = result;
      const value = { canExport, custody, buyerCount: buyerRows.length, internalCount: rows.length,
        issueCount: issues.length, hasInternalCsv: internalCsv !== null } satisfies WholesaleSummary;
      scope.postMessage({ id, value });
      return;
    }
    if (!result) throw new Error('The wholesale preview is still processing.');
    if (request.type !== 'download') {
      const { page, pageSize } = request;
      const value = request.type === 'buyerRows' ? readPage(result.buyerRows, page, pageSize)
        : request.type === 'internalRows' ? readPage(result.rows, page, pageSize) : readPage(result.issues, page, pageSize);
      scope.postMessage({ id, value });
      return;
    }
    const { artifact } = request;
    const content = { buyer: result.buyerCsv, shopify: result.shopifyCsv, lineSheet: result.lineSheetHtml,
      internal: result.internalCsv, audit: result.auditJson }[artifact];
    if (content === null || (!result.canExport && (artifact === 'buyer' || artifact === 'shopify' || artifact === 'lineSheet'))) {
      throw new Error('This file is held. Review the current wholesale checks.');
    }
    const bytes = new TextEncoder().encode(content).buffer;
    scope.postMessage({ id, value: { filename: result.fileNames[artifact], mime: MIME[artifact], bytes } }, [bytes]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : 'The local wholesale worker could not finish.' });
  }
};
