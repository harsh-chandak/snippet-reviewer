'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { ErrorBanner } from '@/components/shared';
import {
  CodeView,
  FindingsPanel,
  ReviewPanel,
  SnippetHeader,
  useFindingsView,
  useSnippetReview,
} from '@/components/snippet';
import { errorMessage } from '@/lib/api';
import { codeLines } from '@/lib/codeLines';
import type { Finding, FindingStatus } from '@/lib/types';

const NO_FINDINGS: Finding[] = [];

// Side by side (lg and up), each column is as tall as the viewport minus the 3.5rem header
// (never under 480px), stays on screen and scrolls on its own; stacked on narrow screens.
const COLUMN = 'lg:sticky lg:top-2 lg:h-[max(480px,calc(100vh_-_3.5rem))]';

// The layout's content box is max-w-5xl; code needs more room than that. From lg up the page
// widens itself to at most 1600px, centred on the viewport, with the layout's 24px gutter each
// side. 100vw counts a classic scrollbar, so with one showing the gutter shrinks by half its
// width (to about 16px) and the box still never overflows the page. Below lg the layout's own
// width and gutter (16px on phones) apply.
function Wide({ children }: { children: ReactNode }) {
  return (
    <div className="lg:ml-[calc(50%_-_min(800px,calc(50vw_-_1.5rem)))] lg:w-[min(1600px,calc(100vw_-_3rem))]">
      {children}
    </div>
  );
}

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

// The snippet page: header with the Review button, the summary row and one folded 'Review
// details' line (which is the progress while a review runs), then the code and the findings
// side by side. Selecting a finding highlights its lines and scrolls the code to them; a gutter
// dot selects its line's finding. Progress comes from polling GET /reviews/:id every 2 s (see useSnippetReview).
export default function SnippetPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const state = useSnippetReview(id);
  const { snippet, review, updateFinding } = state;
  // Rule findings are saved when the static step ends, so they show while the model runs,
  // and they stay when a later step fails.
  const findings = review?.findings ?? NO_FINDINGS;
  const view = useFindingsView(findings);
  const { keep } = view;
  // Split exactly as the API does (codeLines), so line N here is line N there.
  const code = snippet?.code ?? '';
  const lines = useMemo(() => codeLines(code).map((l) => l.replace(/\r$/, '')), [code]);
  const setFindingStatus = useCallback(
    (findingId: number, status: FindingStatus) => {
      keep(findingId);
      updateFinding(findingId, status);
    },
    [keep, updateFinding],
  );

  if (state.notFound) {
    return (
      <Wide>
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
      </Wide>
    );
  }

  if (state.loadError && !snippet) {
    return (
      <Wide>
        <div className="space-y-4">
          <BackLink />
          <ErrorBanner
            title="Could not load this snippet"
            message={errorMessage(state.loadError)}
            onRetry={state.reload}
          />
        </div>
      </Wide>
    );
  }

  if (!snippet || !state.status) {
    return (
      <Wide>
        <div className="space-y-4">
          <BackLink />
          <LoadingSkeleton />
        </div>
      </Wide>
    );
  }

  return (
    <Wide>
      <div className="space-y-4">
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
          language={snippet.language}
          snippetContext={snippet.context ?? null}
          startError={state.startError}
          pollError={state.pollError}
          starting={state.starting}
          onRetry={state.start}
        />
        {/* The code takes what is left; the findings column is 400px. */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <CodeView
            code={snippet.code}
            lines={lines}
            language={snippet.language}
            findings={view.visible}
            selected={view.visible.find((f) => f.id === view.selectedId) ?? null}
            highlighted={view.visible.find((f) => f.id === view.highlightedId) ?? null}
            onSelectLine={view.selectLine}
            className={`max-h-[70vh] lg:max-h-none lg:min-w-0 lg:flex-1 ${COLUMN}`}
          />
          <FindingsPanel
            view={view}
            review={review}
            lines={lines}
            reviewActive={state.active}
            pendingFindings={state.pendingFindings}
            findingErrors={state.findingErrors}
            onSetFindingStatus={setFindingStatus}
            className={`lg:w-[400px] lg:shrink-0 ${COLUMN}`}
          />
        </div>
      </div>
    </Wide>
  );
}
