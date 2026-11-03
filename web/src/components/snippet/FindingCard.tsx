'use client';

import { useId, useState } from 'react';
import { CategoryTag, SeverityBadge } from '@/components/shared';
import type { Finding, FindingStatus, Severity } from '@/lib/types';

export function lineLabel(f: Pick<Finding, 'lineStart' | 'lineEnd'>): string {
  return f.lineStart === f.lineEnd ? `Line ${f.lineStart}` : `Lines ${f.lineStart}–${f.lineEnd}`;
}

// The coloured stripe down the left of an open comment, keyed to severity.
const ACCENT: Record<Severity, string> = {
  critical: 'border-l-red-500',
  warning: 'border-l-amber-500',
  info: 'border-l-blue-500',
};

const BUTTON =
  'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50';
const NEUTRAL_BUTTON = `${BUTTON} border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-gray-100 dark:hover:bg-gray-800`;
const ACCEPT_BUTTON = `${BUTTON} border-green-700 bg-green-600 text-white hover:bg-green-700 dark:border-green-600 dark:bg-green-700 dark:hover:bg-green-600`;

function CheckIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
      <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

function Body({ finding }: { finding: Finding }) {
  return (
    <>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{finding.description}</p>
      {finding.suggestedFix && (
        <div className="mt-3">
          <p className="mb-1 text-xs font-semibold text-[var(--muted)]">Suggested fix</p>
          <pre className="overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] leading-5">
            <code>{finding.suggestedFix}</code>
          </pre>
        </div>
      )}
    </>
  );
}

// One review comment, drawn like a GitHub PR review comment. Open findings show in full
// with Accept and Dismiss; accepted or dismissed ones fold to a single line with Reopen.
export function FindingCard({
  finding,
  pending,
  error,
  onSetStatus,
}: {
  finding: Finding;
  pending: boolean;
  error?: string;
  onSetStatus: (status: FindingStatus) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const resolved = finding.status !== 'open';
  const where = lineLabel(finding);

  const errorText = error && (
    <p role="alert" className="mt-2 text-xs font-medium text-red-700 dark:text-red-400">
      {error}
    </p>
  );

  if (resolved) {
    const accepted = finding.status === 'accepted';
    return (
      <article
        aria-label={`${accepted ? 'Accepted' : 'Dismissed'} finding, ${where}`}
        className="rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2"
      >
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span
            className={`inline-flex shrink-0 items-center gap-1 font-semibold ${
              accepted ? 'text-green-700 dark:text-green-400' : 'text-[var(--muted)]'
            }`}
          >
            {accepted ? <CheckIcon /> : <XIcon />}
            {accepted ? 'Accepted' : 'Dismissed'}
          </span>
          <SeverityBadge severity={finding.severity} />
          <span className="hidden sm:inline-flex">
            <CategoryTag category={finding.category} />
          </span>
          <span className="shrink-0 text-[var(--muted)]">{where}</span>
          <span
            className={`min-w-0 flex-1 truncate text-[var(--muted)] ${expanded ? 'invisible' : ''}`}
            title={finding.description}
          >
            {finding.description}
          </span>
          <button
            type="button"
            className={NEUTRAL_BUTTON}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? 'Hide' : 'Show'}
            <span className="sr-only"> details</span>
          </button>
          <button type="button" className={NEUTRAL_BUTTON} disabled={pending} onClick={() => onSetStatus('open')}>
            Reopen
          </button>
        </div>
        {expanded && (
          <div id={detailsId} className="mt-2 border-t border-[var(--border)] pt-2">
            <Body finding={finding} />
          </div>
        )}
        {errorText}
      </article>
    );
  }

  return (
    <article
      aria-label={`${finding.severity} ${finding.category} finding, ${where}`}
      className={`rounded-md border border-l-4 border-[var(--border)] ${ACCENT[finding.severity]} bg-[var(--background)] shadow-sm`}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs">
        <SeverityBadge severity={finding.severity} />
        <CategoryTag category={finding.category} />
        <span className="font-medium text-[var(--muted)]">{where}</span>
      </header>
      <div className="px-3 py-3">
        <Body finding={finding} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={ACCEPT_BUTTON} disabled={pending} onClick={() => onSetStatus('accepted')}>
            <CheckIcon />
            Accept
          </button>
          <button type="button" className={NEUTRAL_BUTTON} disabled={pending} onClick={() => onSetStatus('dismissed')}>
            <XIcon />
            Dismiss
          </button>
        </div>
        {errorText}
      </div>
    </article>
  );
}
