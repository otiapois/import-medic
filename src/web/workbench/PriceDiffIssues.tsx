import type { DiffIssue } from '../../core/shopify-price-diff/types';
import { Pagination, usePagination } from './Pagination';

const SOURCE_NAMES = { baseline: 'Baseline', supplier: 'Supplier', mapping: 'Mapping', verification: 'Verification', bom: 'Bundle BOM' };

export function PriceDiffIssues({ issues, title }: { issues: readonly DiffIssue[]; title: string }) {
  const page = usePagination(issues.length);
  if (!issues.length) return null;
  return (
    <>
      <DiffIssueList issues={issues.slice(page.start, page.end)} title={title} />
      <Pagination state={page} total={issues.length} />
    </>
  );
}

export function DiffIssueList({ issues, title, showSupplierSource }: { issues: readonly DiffIssue[]; title: string; showSupplierSource?: boolean }) {
  const limit = 8;
  if (!issues.length) return null;
  return (
    <div className="price-checks">
      <h3>{title}</h3>
      <ul className="price-check-list">
        {issues.map((issue, index) => {
          const bom = issue.source === 'bom';
          const noun = bom ? 'line' : 'row';
          const rows = bom ? issue.rows : issue.rows.slice(0, limit);
          const firstRow = issue.row ?? rows[0];
          return (
            <li key={`${issue.source}:${issue.code}:${issue.row}:${issue.column}:${index}`}>
              <strong>{(showSupplierSource && issue.supplierSource) || SOURCE_NAMES[issue.source]}
                {rows.length > 1 ? ` ${noun}s ${rows.join(', ')}` : firstRow !== undefined ? ` ${noun} ${firstRow}` : ''}
                {!bom && issue.rows.length > limit ? ` (+${(issue.rows.length - limit).toLocaleString('en-US')} more)` : ''}
                {issue.column ? ` · ${issue.column}` : ''}
              </strong>
              <p>{issue.message}{issue.value ? <> <code>{issue.value}</code></> : null}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
