'use client';

import { useEffect, useState } from 'react';
import { CATEGORY_LABELS, CONTEXT_LABELS, SEVERITY_LABELS } from '@/components/shared';
import { errorMessage, listReviewEvents } from '@/lib/api';
import { REVIEW_STEPS } from '@/lib/types';
import type { Finding, Review, ReviewEvent, ReviewEventPayloads, ReviewStep } from '@/lib/types';

// The events each step row lists when it is opened. review.started, review.done and
// finding.resolved belong to no step; review.failed goes to the step it failed in.
const STEP_OF: Partial<Record<ReviewEvent['type'], ReviewStep>> = {
  'static.parsed': 'static',
  'static.rule_hit': 'static',
  'model.called': 'model',
  'model.failed': 'model',
  'model.finding_kept': 'model',
  'model.finding_rejected': 'model',
  'model.duplicate': 'model',
  'fix.checked': 'checking',
};

export interface ReviewEventsState {
  events: ReviewEvent[] | null; // null until the first answer
  error: string | null;
  loading: boolean;
}

// GET /reviews/:id/events while `enabled` (a step is open). It fetches when a step opens and
// again whenever `pollMark` changes: the caller passes the polled review object while the
// review runs, so the list follows every poll, and one last time when it finishes.
export function useReviewEvents(reviewId: number, enabled: boolean, pollMark: unknown): ReviewEventsState {
  const [events, setEvents] = useState<ReviewEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Another review replaced this one: its events are not ours.
  useEffect(() => {
    setEvents(null);
    setError(null);
  }, [reviewId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    listReviewEvents(reviewId)
      .then((items) => {
        if (cancelled) return;
        setEvents(items);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reviewId, enabled, pollMark]);

  return { events, error, loading };
}

function count(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString('en-US');
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${count(n)} ${n === 1 ? one : many}`;
}

function lines(start: number, end: number): string {
  return end > start ? `lines ${start}-${end}` : `line ${start}`;
}

function contextWord(context: string | null | undefined): string {
  if (!context) return 'no context';
  return CONTEXT_LABELS[context as keyof typeof CONTEXT_LABELS] ?? context;
}

function severityCategory(p: { severity: string; category: string }): string {
  const severity = SEVERITY_LABELS[p.severity as keyof typeof SEVERITY_LABELS] ?? p.severity;
  const category = CATEGORY_LABELS[p.category as keyof typeof CATEGORY_LABELS] ?? p.category;
  return `${severity.toLowerCase()} ${category.toLowerCase()}`;
}

function seconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// 'passed (parses, rule cleared, no new issues)'. A null check did not run and is not named.
function fixCheckWords(p: ReviewEventPayloads['fix.checked']): string {
  if (p.fixCheck === 'not_checked') return 'not checked';
  const parts = [
    p.parses === true ? 'parses' : p.parses === false ? "doesn't parse" : null,
    p.ruleCleared === true ? 'rule cleared' : p.ruleCleared === false ? 'rule still fires' : null,
    p.newRuleIds.length === 0 ? 'no new issues' : `new: ${p.newRuleIds.join(', ')}`,
  ].filter(Boolean);
  return `${p.fixCheck} (${parts.join(', ')})`;
}

interface EventText {
  text: string;
  detail?: string; // a muted second line
  raw?: string; // untrusted model output, shown on request, always as text
}

// One event in plain words. Every string here is rendered as text, never as HTML: rule ids,
// reasons and raw come from the model or the API and are untrusted.
function describe(event: ReviewEvent, findings: Finding[]): EventText | null {
  switch (event.type) {
    case 'static.parsed': {
      const p = event.payload;
      if (!p.supported)
        return { text: `Only the language-agnostic rules ran (hard-coded secrets) · context ${contextWord(p.context)}` };
      const parsed = p.parseOk === false ? `Did not parse${p.parseError ? `: ${p.parseError}` : ''}` : 'Parsed OK';
      const rules = p.rulesChecked?.length ? ` · ${plural(p.rulesChecked.length, 'rule')} checked` : '';
      return {
        text: `${parsed} · ${plural(p.outlineItems, 'outline item')} · context ${contextWord(p.context)}${rules}`,
        detail: p.signals?.length ? `Signals: ${p.signals.join(' · ')}` : undefined,
      };
    }
    case 'static.rule_hit': {
      const p = event.payload;
      const fix = p.hasFix ? ' · fix proposed' : '';
      return { text: `${p.ruleId} fired on ${lines(p.lineStart, p.lineEnd)}${fix}`, detail: severityCategory(p) };
    }
    case 'model.called': {
      const p = event.payload;
      const total = p.totalInputTokens ?? (p.inputTokens ?? 0) + (p.cacheReadTokens ?? 0) + (p.cacheWriteTokens ?? 0);
      const about = [p.model, p.promptVersion && `prompt ${p.promptVersion}`].filter(Boolean).join(' · ');
      return {
        text:
          `Sent: ${contextWord(p.context)} context, ${plural(p.hintsSent, 'rule finding')} as already reported, ` +
          `${plural(p.outlineItemsSent, 'outline item')}, ${plural(p.promptChars, 'character')}`,
        detail: `Answered in ${seconds(p.ms)}: ${count(total)} in · ${count(p.outputTokens)} out${about ? ` · ${about}` : ''}`,
      };
    }
    case 'model.failed':
      return { text: `Failed after ${seconds(event.payload.ms)}: ${event.payload.message}` };
    case 'model.finding_kept': {
      const p = event.payload;
      return { text: `Kept: ${severityCategory(p)}, ${lines(p.lineStart, p.lineEnd)}${p.hasFix ? ' · with a fix' : ''}` };
    }
    case 'model.finding_rejected':
      return { text: `Rejected: ${event.payload.reason}`, raw: event.payload.raw || undefined };
    case 'model.duplicate': {
      const p = event.payload;
      const of = p.ruleId ?? 'a rule finding';
      return { text: `Dropped as a repeat of ${of} (line ${p.lineStart})` };
    }
    case 'fix.checked': {
      const p = event.payload;
      const finding = findings.find((f) => f.id === p.findingId);
      const line = finding ? (finding.fix?.lineStart ?? finding.lineStart) : null;
      const where = line !== null ? `Fix on line ${line}` : `Fix for finding #${p.findingId}`;
      return { text: `${where}: ${fixCheckWords(p)}`, detail: p.ruleId ?? (p.source === 'model' ? 'AI finding' : undefined) };
    }
    case 'review.failed':
      return { text: `Failed: ${event.payload.message}` };
    default:
      return null;
  }
}

// The step a review.failed event belongs to: its phase, else the step the row list marks failed.
function failedStep(phase: string, fallback: ReviewStep | null): ReviewStep | null {
  return (REVIEW_STEPS as readonly string[]).includes(phase) ? (phase as ReviewStep) : fallback;
}

export function eventsForStep(events: ReviewEvent[], step: ReviewStep, failedAt: ReviewStep | null): ReviewEvent[] {
  return events.filter((e) =>
    e.type === 'review.failed' ? failedStep(e.payload.phase, failedAt) === step : STEP_OF[e.type] === step,
  );
}

// The list under an opened step row.
export function StepEvents({
  id,
  step,
  state,
  review,
  failedAt,
}: {
  id: string;
  step: ReviewStep;
  state: ReviewEventsState;
  review: Review;
  failedAt: ReviewStep | null;
}) {
  const { events, error, loading } = state;
  const findings = review.findings ?? [];
  const mine = events ? eventsForStep(events, step, failedAt) : [];
  const truncated = events?.find((e) => e.type === 'events.truncated');
  const items = mine.flatMap((event) => {
    const text = describe(event, findings);
    return text ? [{ event, text }] : [];
  });

  return (
    <div id={id} className="mb-1 ml-[1.625rem] mt-1.5 space-y-1 border-l border-[var(--border)] pl-3 text-xs">
      {error && <p className="text-red-700 dark:text-red-400">Could not load the events: {error}</p>}
      {!events && !error && <p className="text-[var(--muted)]">Loading events…</p>}
      {events && items.length === 0 && (
        <p className="text-[var(--muted)]">
          {loading ? 'Loading events…' : 'Nothing recorded for this step.'}
        </p>
      )}
      {items.length > 0 && (
        <ul className="space-y-1" aria-label="Events">
          {items.map(({ event, text }) => (
            <li key={event.id} className="break-words">
              <span>{text.text}</span>
              {text.detail && <span className="block text-[var(--muted)]">{text.detail}</span>}
              {text.raw && (
                <details className="text-[var(--muted)]">
                  <summary className="cursor-pointer select-none">What the model sent</summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--background)] p-2 font-mono text-[11px]">
                    {text.raw}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {truncated && truncated.type === 'events.truncated' && (
        <p className="text-[var(--muted)]">
          The log stops at 500 events; {plural(truncated.payload.dropped, 'later event was', 'later events were')} not
          recorded.
        </p>
      )}
      {step === 'static' && review.rulesetVersion && (
        <p className="text-[var(--muted)]">Rule set {review.rulesetVersion}</p>
      )}
    </div>
  );
}
