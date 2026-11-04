'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, listSnippets } from '@/lib/api';
import type { SnippetListItem } from '@/lib/dashboardTypes';
import { ErrorBanner } from '@/components/shared';
import { DashboardFilters, type DashboardFilterValues } from './DashboardFilters';
import { NoMatches, NoSnippets } from './EmptyState';
import { SnippetTable } from './SnippetTable';
import { SnippetTableSkeleton } from './SnippetTableSkeleton';

const BUTTON_CLASS =
  'rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-gray-800';

type Phase = 'loading' | 'ready' | 'error';

// The snippet list for the given filters. Filters live in the URL, so the page owns them;
// a change of filters reloads from the first page.
export function SnippetDashboard({
  filters,
  onFilterChange,
}: {
  filters: DashboardFilterValues;
  onFilterChange: (key: keyof DashboardFilterValues, value: string) => void;
}) {
  const { language, status } = filters;
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<SnippetListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  // Bumped on every first-page load, so a slow response for old filters is dropped.
  const generation = useRef(0);

  const loadFirstPage = useCallback(async () => {
    const gen = ++generation.current;
    setPhase('loading');
    setError(null);
    setMoreError(null);
    setLoadingMore(false);
    try {
      const page = await listSnippets({ language, status });
      if (gen !== generation.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setPhase('ready');
    } catch (err) {
      if (gen !== generation.current) return;
      setError(errorMessage(err));
      setPhase('error');
    }
  }, [language, status]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = async () => {
    if (nextCursor === null || loadingMore) return;
    const gen = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listSnippets({ language, status, cursor: nextCursor });
      if (gen !== generation.current) return;
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (gen !== generation.current) return;
      setMoreError(errorMessage(err));
    } finally {
      if (gen === generation.current) setLoadingMore(false);
    }
  };

  const hasFilters = Boolean(language || status);

  let content: React.ReactNode;
  if (phase === 'loading') {
    content = <SnippetTableSkeleton />;
  } else if (phase === 'error') {
    content = <ErrorBanner title="Could not load snippets" message={error ?? ''} onRetry={loadFirstPage} />;
  } else if (items.length === 0) {
    content = hasFilters ? <NoMatches /> : <NoSnippets />;
  } else {
    content = (
      <>
        <SnippetTable snippets={items} />
        {moreError && <ErrorBanner title="Could not load more snippets" message={moreError} onRetry={loadMore} />}
        <div className="flex items-center justify-center">
          {nextCursor !== null ? (
            <button type="button" className={BUTTON_CLASS} onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          ) : (
            <p className="text-sm text-[var(--muted)]">
              Showing all {items.length} {items.length === 1 ? 'snippet' : 'snippets'}
            </p>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Snippets</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Every snippet you have submitted, newest first.</p>
        </div>
        <button type="button" className={BUTTON_CLASS} onClick={loadFirstPage} disabled={phase === 'loading'}>
          Refresh
        </button>
      </div>
      <DashboardFilters filters={filters} onChange={onFilterChange} />
      {content}
    </div>
  );
}
