'use client';

import { LanguageTag, ReviewStatusBadge } from '@/components/shared';
import type { Review, SnippetDetail, SnippetReviewStatus } from '@/lib/types';
import { Spinner } from './Spinner';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function SnippetHeader({
  snippet,
  status,
  review,
  active,
  starting,
  onReview,
}: {
  snippet: SnippetDetail;
  status: SnippetReviewStatus;
  review: Review | null;
  active: boolean;
  starting: boolean;
  onReview: () => void;
}) {
  const busy = active || starting;
  const label = starting ? 'Starting…' : active ? 'Review running' : review ? 'Review again' : 'Review';

  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-2">
        <h1 className="break-words text-2xl font-semibold tracking-tight">{snippet.title}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--muted)]">
          <LanguageTag language={snippet.language} />
          {/* While a review runs the step list shows its progress; a second "In progress" chip
              here would only repeat it. */}
          {!active && <ReviewStatusBadge status={status} />}
          <span>
            Created <time dateTime={snippet.createdAt}>{formatDate(snippet.createdAt)}</time>
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={onReview}
        disabled={busy}
        aria-busy={busy}
        className="inline-flex shrink-0 items-center justify-center gap-2 self-start rounded-md border border-green-700 bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-green-600 dark:bg-green-700 dark:hover:bg-green-600"
      >
        {/* Only before the step list exists: once the review has started, the steps show progress. */}
        {starting && <Spinner />}
        {label}
      </button>
    </header>
  );
}
