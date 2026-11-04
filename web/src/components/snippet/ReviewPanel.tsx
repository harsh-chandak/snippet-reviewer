'use client';

import { useEffect, useState } from 'react';
import { ErrorBanner, SEVERITY_LABELS } from '@/components/shared';
import { FINDING_STATUSES, SEVERITIES } from '@/lib/types';
import type { FindingStatus, Review, Severity } from '@/lib/types';
import { isActive } from './useSnippetReview';

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" className={`animate-spin ${className}`}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// Whole seconds since `from`, ticking once a second.
function useElapsedSeconds(from: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function ReviewProgress({ review }: { review: Review }) {
  const seconds = useElapsedSeconds(review.createdAt);
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
    >
      <Spinner />
      <span className="font-medium">
        {review.status === 'pending' ? 'Starting review…' : 'Reviewing…'}
      </span>
      {/* Not announced every second; the status line above is. */}
      <span aria-hidden className="tabular-nums">
        {formatElapsed(seconds)}
      </span>
      <span className="ml-auto hidden text-xs opacity-80 sm:inline">Findings appear on their lines when it finishes.</span>
    </div>
  );
}

const SEVERITY_DOT: Record<Severity, string> = {
  critical: 'bg-red-500',
  warning: 'bg-amber-500',
  info: 'bg-blue-500',
};

const STATUS_LABEL: Record<FindingStatus, string> = { open: 'open', accepted: 'accepted', dismissed: 'dismissed' };

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function RejectedNote({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p className="text-xs text-[var(--muted)]">
      {plural(count, 'suggestion was', 'suggestions were')} dropped because{' '}
      {count === 1 ? 'it' : 'they'} didn&apos;t pass our checks (a missing or invalid field, or lines that
      don&apos;t exist in this snippet).
    </p>
  );
}

function Summary({ review }: { review: Review }) {
  const findings = review.findings ?? [];
  // Nothing usable came back, but the model did say something: never call that "no issues".
  if (findings.length === 0 && review.rejectedCount > 0) {
    return (
      <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950">
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">This review couldn&apos;t be used</p>
        <p className="text-sm text-amber-900 dark:text-amber-200">
          The model returned {plural(review.rejectedCount, 'suggestion')}, but none passed our checks, so nothing is
          shown. Run the review again.
        </p>
      </div>
    );
  }
  if (findings.length === 0) {
    return (
      <div className="space-y-1 rounded-md border border-green-300 bg-green-50 px-4 py-3 dark:border-green-800 dark:bg-green-950">
        <p className="flex items-center gap-2 text-sm font-semibold text-green-800 dark:text-green-300">
          <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 fill-current">
            <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
          </svg>
          No issues found
        </p>
      </div>
    );
  }

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const byStatus = Object.fromEntries(FINDING_STATUSES.map((s) => [s, 0])) as Record<FindingStatus, number>;
  for (const f of findings) {
    bySeverity[f.severity]++;
    byStatus[f.status]++;
  }

  return (
    <div className="space-y-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <span className="font-semibold">{plural(findings.length, 'finding')}</span>
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1" aria-label="By severity">
          {SEVERITIES.map((s) => (
            <li key={s} className={`flex items-center gap-1.5 ${bySeverity[s] ? '' : 'text-[var(--muted)]'}`}>
              <span aria-hidden className={`h-2 w-2 rounded-full ${SEVERITY_DOT[s]}`} />
              <span className="tabular-nums">{bySeverity[s]}</span> {SEVERITY_LABELS[s].toLowerCase()}
            </li>
          ))}
        </ul>
        <ul
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[var(--muted)] sm:ml-auto"
          aria-label="By status"
        >
          {FINDING_STATUSES.map((s, i) => (
            <li key={s} className="flex items-center gap-3">
              {i > 0 && <span aria-hidden>&middot;</span>}
              <span>
                <span className="tabular-nums text-[var(--foreground)]">{byStatus[s]}</span> {STATUS_LABEL[s]}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <RejectedNote count={review.rejectedCount} />
    </div>
  );
}

// What sits above the code: nothing before the first review, progress while one runs,
// the error when it failed, and the summary of findings when it is done.
export function ReviewPanel({
  review,
  startError,
  pollError,
  starting,
  onRetry,
}: {
  review: Review | null;
  startError: string | null;
  pollError: string | null;
  starting: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-3" aria-live="polite">
      {startError && <ErrorBanner title="Could not start the review" message={startError} onRetry={onRetry} />}
      {!review && !startError && (
        <p className="rounded-md border border-dashed border-[var(--border)] px-4 py-3 text-sm text-[var(--muted)]">
          This snippet hasn&apos;t been reviewed yet. Run a review and each finding will appear under the line it is
          about.
        </p>
      )}
      {review && isActive(review.status) && <ReviewProgress key={review.id} review={review} />}
      {review && isActive(review.status) && pollError && (
        <p className="text-xs text-amber-800 dark:text-amber-300">{pollError}</p>
      )}
      {review?.status === 'failed' && !starting && (
        <ErrorBanner
          title="The review failed"
          message={review.error || 'The review failed without a reason.'}
          onRetry={onRetry}
        />
      )}
      {review?.status === 'done' && <Summary review={review} />}
    </div>
  );
}
