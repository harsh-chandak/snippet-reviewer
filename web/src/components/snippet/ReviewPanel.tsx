'use client';

import { ErrorBanner, SEVERITY_LABELS } from '@/components/shared';
import { FINDING_STATUSES, SEVERITIES } from '@/lib/types';
import type { CodeContext, FindingStatus, Language, Review, Severity } from '@/lib/types';
import { formatDuration } from './format';
import { hasSteps, ReviewSteps } from './ReviewSteps';
import { isActive } from './useSnippetReview';

const SEVERITY_DOT: Record<Severity, string> = {
  critical: 'bg-red-500',
  warning: 'bg-amber-500',
  info: 'bg-blue-500',
};

const STATUS_LABEL: Record<FindingStatus, string> = {
  open: 'open',
  accepted: 'marked valid',
  dismissed: 'not an issue',
};

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function RejectedNote({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p className="text-xs text-[var(--muted)]">
      {plural(count, 'suggestion was', 'suggestions were')} dropped because {count === 1 ? 'it' : 'they'} didn&apos;t
      pass our checks (a missing or invalid field, or lines that don&apos;t exist in this snippet).
    </p>
  );
}

function DuplicateNote({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p className="text-xs text-[var(--muted)]">
      {plural(count, 'AI suggestion', 'AI suggestions')} repeated a rule finding on the same line and{' '}
      {count === 1 ? 'was' : 'were'} left out.
    </p>
  );
}

function Summary({ review }: { review: Review }) {
  const findings = review.findings ?? [];
  const modelFindings = findings.filter((f) => f.source === 'model').length;
  const ruleFindings = findings.length - modelFindings;
  const started = review.startedAt ? Date.parse(review.startedAt) : NaN;
  const completed = review.completedAt ? Date.parse(review.completedAt) : NaN;
  const tookMs =
    Number.isFinite(started) && Number.isFinite(completed) && completed >= started ? completed - started : null;
  // Nothing usable came back, but the model did say something: never call that "no issues".
  if (findings.length === 0 && review.rejectedCount > 0) {
    return (
      <p className="text-sm text-amber-900 dark:text-amber-200">
        <span className="font-semibold">This review couldn&apos;t be used.</span> The model returned{' '}
        {plural(review.rejectedCount, 'suggestion')}, but none passed our checks, so nothing is shown. Run the review
        again.
      </p>
    );
  }
  if (findings.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm font-semibold text-green-800 dark:text-green-300">
        <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 fill-current">
          <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
        </svg>
        No issues found
      </p>
    );
  }

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const byStatus = Object.fromEntries(FINDING_STATUSES.map((s) => [s, 0])) as Record<FindingStatus, number>;
  for (const f of findings) {
    bySeverity[f.severity]++;
    byStatus[f.status]++;
  }

  return (
    <div className="space-y-1">
      {modelFindings === 0 && review.rejectedCount > 0 && (
        <p className="pb-1 text-sm font-semibold text-amber-900 dark:text-amber-200">
          The model&apos;s part of this review couldn&apos;t be used: it returned{' '}
          {plural(review.rejectedCount, 'suggestion')} and none passed our checks. The rule findings stand; run the
          review again for the AI findings.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <span className="font-semibold">
          {plural(findings.length, 'finding')}
          {tookMs !== null && <span className="font-normal text-[var(--muted)]"> in {formatDuration(tookMs)}</span>}
        </span>
        <span className="text-[var(--muted)]">
          <span className="tabular-nums text-[var(--foreground)]">{ruleFindings}</span> rule &middot;{' '}
          <span className="tabular-nums text-[var(--foreground)]">{modelFindings}</span> AI
        </span>
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
      <DuplicateNote count={review.duplicateCount} />
    </div>
  );
}

// A failed review keeps the rule findings the static step saved; say so, so they are not
// mistaken for a finished review.
function KeptFindingsNote({ review }: { review: Review }) {
  const kept = (review.findings ?? []).filter((f) => f.source === 'rule').length;
  if (kept === 0) return null;
  return (
    <p className="text-xs text-[var(--muted)]">
      Static analysis had already finished, so its {plural(kept, 'rule finding')} {kept === 1 ? 'is' : 'are'} kept and
      listed beside the code.
    </p>
  );
}

// What sits above the code and the findings: a note before the first review, the error when
// it failed, then one box with the summary row (when it is done) over the folded 'Review
// details' line (which is also the progress while a review runs).
export function ReviewPanel({
  review,
  language,
  snippetContext,
  startError,
  pollError,
  starting,
  onRetry,
}: {
  review: Review | null;
  language: Language;
  snippetContext: CodeContext | null;
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
          This snippet hasn&apos;t been reviewed yet. Run a review and its findings will be listed beside the code, most
          severe first; select one to see the lines it is about.
        </p>
      )}
      {/* While a review runs, the Review details line below is the one progress indicator. */}
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
      {review?.status === 'failed' && !starting && <KeptFindingsNote review={review} />}
      {review && (review.status === 'done' || hasSteps(review)) && (
        <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5">
          {review.status === 'done' && <Summary review={review} />}
          {hasSteps(review) && (
            <div className={review.status === 'done' ? 'border-t border-[var(--border)] pt-2' : ''}>
              <ReviewSteps review={review} language={language} snippetContext={snippetContext} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
