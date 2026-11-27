import { useEffect, useState } from 'react';

interface Page<T> {
  rows: readonly T[];
  total: number;
  page: number;
}

export function useWorkerPage<T>(read: (() => Promise<Page<T>>) | null) {
  const [data, setData] = useState<{ read: typeof read; page?: Page<T>; error?: string }>();
  useEffect(() => {
    if (!read) return;
    let current = true;
    void read().then((page) => {
      if (current) setData({ read, page });
    }, (error: unknown) => {
      if (current) setData({ read, error: error instanceof Error ? error.message : 'This page could not be read.' });
    });
    return () => { current = false; };
  }, [read]);
  return data && data.read === read ? data : undefined;
}
