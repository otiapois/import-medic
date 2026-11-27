import { buildPromoCampaign } from '../../../core/promo-campaign/engine';
import type { PromoCampaign, PromoCampaignIssue, PromoCampaignRow } from '../../../core/promo-campaign/types';
import type { CampaignArtifact, CampaignMessage, CampaignReply, CampaignSummary } from './campaignWorker';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<CampaignMessage>) => void;
  postMessage: (reply: CampaignReply, transfer?: Transferable[]) => void;
};

let campaign: PromoCampaign | undefined;
let rows: PromoCampaignRow[] = [];
let issues: PromoCampaignIssue[] = [];

const mimeTypes: Record<CampaignArtifact, string> = {
  launch: 'text/csv;charset=utf-8',
  revert: 'text/csv;charset=utf-8',
  audit: 'application/json;charset=utf-8',
  signoff: 'text/html;charset=utf-8',
};

function readPage<T>(items: T[], page: number, pageSize: number) {
  const start = page * pageSize;
  return { rows: items.slice(start, start + pageSize), total: items.length, page };
}

const issueKey = ({ source, line, column, code }: PromoCampaignIssue) => `${source}:${line}:${column}:${code}`;

scope.onmessage = async ({ data: { id, request } }) => {
  try {
    if (request.type === 'build') {
      const [baseline, cost] = await Promise.all([request.baseline.arrayBuffer(), request.costSheet?.arrayBuffer()]);
      campaign = await buildPromoCampaign(request.platform, new Uint8Array(baseline), {
        ...request.options, ...(cost ? { costSheet: new Uint8Array(cost) } : {}),
      });
      const held: PromoCampaignRow[] = [];
      const review: PromoCampaignRow[] = [];
      const remaining: PromoCampaignRow[] = [];
      const rowIssueKeys = new Set<string>();
      for (const row of campaign.rows) {
        (row.status === 'held' ? held : row.issues.length || row.status === 'skipped' ? review : remaining).push(row);
        for (const issue of row.issues) rowIssueKeys.add(issueKey(issue));
      }
      rows = held.concat(review, remaining);
      issues = campaign.issues.filter((issue) => !rowIssueKeys.has(issueKey(issue)));
      const { canExport, custody, summary } = campaign;
      const value = { canExport, custody, summary, issueCount: issues.length, rowCount: rows.length } satisfies CampaignSummary;
      scope.postMessage({ id, value });
      return;
    }
    if (!campaign) throw new Error('The campaign preview is not ready.');
    if (request.type !== 'download') {
      const value = request.type === 'rows' ? readPage(rows, request.page, request.pageSize) : readPage(issues, request.page, request.pageSize);
      scope.postMessage({ id, value });
      return;
    }
    const { artifact } = request;
    const content = {
      launch: campaign.launchCsv, revert: campaign.revertCsv, audit: campaign.auditJson, signoff: campaign.signoffHtml,
    }[artifact];
    if (content === null || (!campaign.canExport && (artifact === 'launch' || artifact === 'revert'))) {
      throw new Error('This campaign file is held. Review the current preview.');
    }
    const bytes = new TextEncoder().encode(content).buffer;
    scope.postMessage({ id, value: { bytes, filename: campaign.fileNames[artifact], mime: mimeTypes[artifact] } }, [bytes]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : 'The campaign preview could not finish.' });
  }
};
