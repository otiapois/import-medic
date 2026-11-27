import type { DiffIssue } from '../../core/shopify-price-diff/types';
import { Pagination, usePagination } from './Pagination';

const SOURCE_NAMES = { baseline: 'Baseline', supplier: 'Supplier', mapping: 'Mapping', verification: 'Verification' };

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
        {issues.map((issue, index) => (
          <li key={`${issue.source}:${issue.code}:${issue.row}:${issue.column}:${index}`}>
            <strong>{(showSupplierSource && issue.supplierSource) || SOURCE_NAMES[issue.source]}
              {issue.rows.length > 1 ? ` rows ${issue.rows.slice(0, limit).join(', ')}` : issue.row !== null ? ` row ${issue.row}` : ''}
              {issue.rows.length > limit ? ` (+${(issue.rows.length - limit).toLocaleString('en-US')} more)` : ''}
              {issue.column ? ` · ${issue.column}` : ''}
            </strong>
            <p>{issue.message}{issue.value ? <> <code>{issue.value}</code></> : null}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
