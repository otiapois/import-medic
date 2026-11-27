import { useState } from 'react';

export const PAGE_SIZE = 10;

export function usePagination(total: number) {
  const [requestedPage, setPage] = useState(0);
  return pagination(total, requestedPage, setPage);
}

export function pagination(total: number, requestedPage: number, setPage: (page: number) => void) {
  const pageCount = Math.ceil(total / PAGE_SIZE);
  const page = Math.min(requestedPage, Math.max(0, pageCount - 1));
  const start = page * PAGE_SIZE;
  return { page, pageCount, start, end: Math.min(start + PAGE_SIZE, total), setPage };
}

export function Pagination({ state, total, label = 'Pagination' }: {
  state: ReturnType<typeof usePagination>;
  total: number;
  label?: string;
}) {
  if (state.pageCount < 2) return null;
  return (
    <nav className="pagination" aria-label={label}>
      <span aria-live="polite">{state.start + 1}–{state.end} of {total.toLocaleString('en-US')}</span>
      <div>
        <button className="button button-secondary button-small" type="button" disabled={!state.page} onClick={() => state.setPage(state.page - 1)}>Previous page</button>
        <button className="button button-secondary button-small" type="button" disabled={state.page === state.pageCount - 1} onClick={() => state.setPage(state.page + 1)}>Next page</button>
      </div>
    </nav>
  );
}
