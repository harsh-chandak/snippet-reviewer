'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ErrorBanner } from '@/components/shared';
import { CodeView, ReviewPanel, SnippetHeader, useSnippetReview } from '@/components/snippet';
import { errorMessage } from '@/lib/api';

function BackLink() {
  return (
    <Link href="/" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)] hover:underline">
      &larr; All snippets
    </Link>
  );
}

function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading snippet">
      <div className="h-8 w-2/3 rounded bg-[var(--surface)]" />
      <div className="h-4 w-1/3 rounded bg-[var(--surface)]" />
      <div className="h-64 rounded-md border border-[var(--border)] bg-[var(--surface)]" />
    </div>
  );
}

// The snippet page: header with the Review button, the review's progress or summary, then
// the code with each finding as a comment under its line. Progress comes from polling
// GET /reviews/:id every 2 s (see useSnippetReview).
export default function SnippetPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const state = useSnippetReview(id);
  const { snippet, review } = state;

  if (state.notFound) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-6 py-12 text-center">
          <h1 className="text-xl font-semibold">Snippet not found</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">It may have been deleted, or the link is wrong.</p>
          <Link
            href="/"
            className="mt-6 inline-block rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            Back to all snippets
          </Link>
        </div>
      </div>
    );
  }

  if (state.loadError && !snippet) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorBanner title="Could not load this snippet" message={errorMessage(state.loadError)} onRetry={state.reload} />
      </div>
    );
  }

  if (!snippet || !state.status) {
    return (
      <div className="space-y-4">
        <BackLink />
        <LoadingSkeleton />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <BackLink />
        <SnippetHeader
          snippet={snippet}
          status={state.status}
          review={review}
          active={state.active}
          starting={state.starting}
          onReview={state.start}
        />
      </div>
      {state.loadError ? (
        <ErrorBanner title="Could not refresh" message={errorMessage(state.loadError)} onRetry={state.reload} />
      ) : null}
      <ReviewPanel
        review={review}
        startError={state.startError}
        pollError={state.pollError}
        starting={state.starting}
        onRetry={state.start}
      />
      <CodeView
        code={snippet.code}
        language={snippet.language}
        findings={review?.status === 'done' ? (review.findings ?? []) : []}
        pendingFindings={state.pendingFindings}
        findingErrors={state.findingErrors}
        onSetFindingStatus={state.updateFinding}
      />
    </div>
  );
}
