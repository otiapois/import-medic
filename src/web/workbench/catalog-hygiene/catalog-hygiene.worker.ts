import { auditCatalogHygiene } from '../../../core/catalog-hygiene/engine';
import type { CatalogHygieneResult } from '../../../core/catalog-hygiene/engine';
import type { CatalogHygieneArtifact, CatalogHygieneIssue, CatalogHygieneMessage, CatalogHygieneReply, CatalogHygieneSummary } from './catalogHygieneWorker';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<CatalogHygieneMessage>) => void;
  postMessage: (reply: CatalogHygieneReply, transfer?: Transferable[]) => void;
};

const MIME = {
  issuesCsv: 'text/csv;charset=utf-8',
  auditJson: 'application/json;charset=utf-8',
  reportHtml: 'text/html;charset=utf-8',
  cleanedCsv: 'text/csv',
  rollbackCsv: 'text/csv',
} satisfies Record<CatalogHygieneArtifact['kind'], string>;

let result: CatalogHygieneResult | undefined;
const issuesByCode = new Map<string, CatalogHygieneIssue[]>();

scope.onmessage = async ({ data: { id, request } }) => {
  try {
    if (request.type === 'audit') {
      result = undefined;
      issuesByCode.clear();
      const { input } = request;
      const sources = await Promise.all(input.sources.map(async ({ file, platform }) => ({
        platform, filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()),
      })));
      result = await auditCatalogHygiene(sources, input.options);
      for (const issue of result.issues) {
        const group = issuesByCode.get(issue.code);
        if (group) group.push(issue);
        else issuesByCode.set(issue.code, [issue]);
      }
      const value = {
        status: result.status, summary: result.summary, sources: result.sources, issueCount: result.issues.length,
        issueTypes: Array.from(issuesByCode, ([code, issues]) => ({ code, count: issues.length })),
      } satisfies CatalogHygieneSummary;
      scope.postMessage({ id, value });
      return;
    }
    if (!result) throw new Error('The local catalog audit is still running.');
    if (request.type === 'issues') {
      const { code, page, pageSize } = request;
      const issues = code ? issuesByCode.get(code) ?? [] : result.issues;
      const start = page * pageSize;
      scope.postMessage({ id, value: { rows: issues.slice(start, start + pageSize), total: issues.length, page } });
      return;
    }
    const target = request.artifact;
    const artifact = 'sourceIndex' in target
      ? result.status === 'READY' ? result.artifacts.catalogs.find(({ sourceIndex }) => sourceIndex === target.sourceIndex)?.[target.kind] : undefined
      : result.artifacts[target.kind];
    if (!artifact) throw new Error('This catalog file is held. Review the current catalog audit.');
    const bytes = artifact.bytes.slice().buffer;
    scope.postMessage({ id, value: { filename: artifact.filename, bytes, mime: MIME[target.kind] } }, [bytes]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : 'The local catalog worker could not finish.' });
  }
};
