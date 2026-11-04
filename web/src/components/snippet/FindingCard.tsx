'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CategoryTag, FixCheckBadge, SeverityBadge, SourceBadge } from '@/components/shared';
import type { Finding, FindingStatus, Severity } from '@/lib/types';
import { FixDiff } from './FixDiff';

export function lineLabel(f: Pick<Finding, 'lineStart' | 'lineEnd'>): string {
  const start = Math.min(f.lineStart, f.lineEnd);
  const end = Math.max(f.lineStart, f.lineEnd);
  return start === end ? `Line ${start}` : `Lines ${start}–${end}`;
}

// The coloured stripe down the left of a card, keyed to severity; muted once resolved.
const ACCENT: Record<Severity, string> = {
  critical: 'border-l-red-500',
  warning: 'border-l-amber-500',
  info: 'border-l-blue-500',
};

// What the API's accepted/dismissed mean to a reader: the finding is right, or it isn't.
export const STATUS_TEXT: Record<Exclude<FindingStatus, 'open'>, string> = {
  accepted: 'Marked as valid',
  dismissed: 'Not an issue',
};

const BUTTON =
  'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50';
const NEUTRAL_BUTTON = `${BUTTON} border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-gray-100 dark:hover:bg-gray-800`;
const VALID_BUTTON = `${BUTTON} border-green-700 bg-green-600 text-white hover:bg-green-700 dark:border-green-600 dark:bg-green-700 dark:hover:bg-green-600`;

function CheckIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 fill-current">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 fill-current">
      <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={`h-3 w-3 shrink-0 fill-current text-[var(--muted)] transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

// Prose stays prose: it wraps like text (no code box, no horizontal scrollbar), and only
// `backticked` spans are set in monospace.
function Prose({ text, className = '' }: { text: string; className?: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <p className={`whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere] ${className}`}>
      {parts.map((part, i) =>
        part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
          <code key={i} className="rounded bg-[var(--surface)] px-1 py-0.5 font-mono text-[12.5px]">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </p>
  );
}

// Copies the fix's replacement lines (not the diff) and says so for two seconds.
function CopyFixButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  };
  return (
    <button type="button" className={NEUTRAL_BUTTON} onClick={copy}>
      <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 fill-current">
        <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
        <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
      </svg>
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy fix'}</span>
    </button>
  );
}

// The proposed fix as a before/after, with whether it passed the mechanical check and why.
function ProposedFix({ finding, lines, checking }: { finding: Finding; lines: readonly string[]; checking: boolean }) {
  if (!finding.fix) return null;
  const note = finding.fixCheckDetail?.note;
  return (
    <div className="mt-3">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <p className="text-xs font-semibold text-[var(--muted)]">Proposed change</p>
        <FixCheckBadge fixCheck={finding.fixCheck} detail={finding.fixCheckDetail} checking={checking} />
      </div>
      <FixDiff fix={finding.fix} lines={lines} />
      {note && <p className="mt-1 break-words text-xs text-[var(--muted)]">{note}</p>}
    </div>
  );
}

// One finding in the list beside the code. The header is a button: it selects the card,
// which opens it to the full description, the fix and the actions, and highlights its lines.
// Marking it keeps the card open and the same height (the actions row becomes a status line
// with Reopen), so nothing on the page moves.
export function FindingCard({
  finding,
  lines,
  checking = false,
  pending,
  error,
  selected,
  onToggle,
  onHighlight,
  onSetStatus,
}: {
  finding: Finding;
  lines: readonly string[]; // codeLines(code), for the fix's before side
  checking?: boolean; // the review is still running, so an unchecked fix may yet be checked
  pending: boolean;
  error?: string;
  selected: boolean;
  onToggle: () => void;
  onHighlight: (on: boolean) => void;
  onSetStatus: (status: FindingStatus) => void;
}) {
  const bodyId = useId();
  const resolved = finding.status !== 'open';
  const where = lineLabel(finding);
  const source = finding.source === 'rule' ? 'Rule' : 'AI';

  let statusTag: ReactNode = null;
  if (finding.status === 'accepted') {
    statusTag = (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700 dark:text-green-400">
        <CheckIcon />
        {STATUS_TEXT.accepted}
      </span>
    );
  } else if (finding.status === 'dismissed') {
    statusTag = (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--muted)]">
        <XIcon />
        {STATUS_TEXT.dismissed}
      </span>
    );
  }

  return (
    <article
      onMouseEnter={() => onHighlight(true)}
      onMouseLeave={() => onHighlight(false)}
      className={`rounded-md border border-l-4 bg-[var(--background)] ${
        resolved ? 'border-l-gray-300 dark:border-l-gray-600' : ACCENT[finding.severity]
      } ${
        selected
          ? 'border-sky-400 shadow-md ring-1 ring-sky-400 dark:border-sky-500 dark:ring-sky-500'
          : 'border-[var(--border)] shadow-sm'
      }`}
    >
      <button
        type="button"
        data-finding-button
        aria-expanded={selected}
        aria-controls={selected ? bodyId : undefined}
        aria-label={`${finding.severity} ${source} ${finding.category} finding, ${where}${
          resolved ? `, ${STATUS_TEXT[finding.status as 'accepted' | 'dismissed'].toLowerCase()}` : ''
        }: ${finding.description.slice(0, 140)}`}
        onClick={onToggle}
        onFocus={() => onHighlight(true)}
        onBlur={() => onHighlight(false)}
        className={`block w-full rounded-md px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-500 ${
          resolved && !selected ? 'opacity-70' : ''
        } ${selected ? '' : 'hover:bg-[var(--surface)]'}`}
      >
        <span className="flex flex-wrap items-center gap-1.5 text-xs">
          <SeverityBadge severity={finding.severity} />
          <SourceBadge source={finding.source} ruleId={finding.ruleId} />
          <CategoryTag category={finding.category} />
          {statusTag}
          <span className="ml-auto flex items-center gap-1.5 font-medium tabular-nums text-[var(--muted)]">
            {where}
            <Chevron open={selected} />
          </span>
        </span>
        {!selected && (
          <span className="mt-1.5 line-clamp-2 break-words text-sm leading-5 [overflow-wrap:anywhere]">
            {finding.description}
          </span>
        )}
        {!selected && error && (
          <span className="mt-1 block text-xs font-medium text-red-700 dark:text-red-400">{error}</span>
        )}
      </button>
      {selected && (
        <div id={bodyId} className="border-t border-[var(--border)] px-3 pb-3 pt-2.5">
          {finding.source === 'rule' && finding.ruleId && (
            <p className="mb-1.5 font-mono text-[11px] text-[var(--muted)]">{finding.ruleId}</p>
          )}
          <Prose text={finding.description} />
          {finding.suggestedFix && (
            <div className="mt-3">
              <p className="mb-0.5 text-xs font-semibold text-[var(--muted)]">Suggested fix</p>
              <Prose text={finding.suggestedFix} />
            </div>
          )}
          <ProposedFix finding={finding} lines={lines} checking={checking} />
          <div className="mt-3 flex min-h-[1.875rem] flex-wrap items-center gap-2">
            {resolved ? (
              <>
                {statusTag}
                <button
                  type="button"
                  className={NEUTRAL_BUTTON}
                  disabled={pending}
                  onClick={() => onSetStatus('open')}
                >
                  Reopen
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={VALID_BUTTON}
                  disabled={pending}
                  onClick={() => onSetStatus('accepted')}
                >
                  <CheckIcon />
                  Mark as valid
                </button>
                <button
                  type="button"
                  className={NEUTRAL_BUTTON}
                  disabled={pending}
                  onClick={() => onSetStatus('dismissed')}
                >
                  <XIcon />
                  Not an issue
                </button>
              </>
            )}
            {finding.fix && finding.fix.replacement !== '' && <CopyFixButton text={finding.fix.replacement} />}
          </div>
          {error && (
            <p role="alert" className="mt-2 text-xs font-medium text-red-700 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
