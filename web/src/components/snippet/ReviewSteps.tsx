"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import { CONTEXT_LABELS, ContextTag } from "@/components/shared";
import { REVIEW_STEPS, STATIC_LANGUAGES } from "@/lib/types";
import type { CodeContext, Language, Review, ReviewStep } from "@/lib/types";
import { StepEvents, useReviewEvents } from "./ReviewEvents";
import { Spinner } from "./Spinner";
import { isActive } from "./useSnippetReview";
import { formatDuration, formatUsd } from "./format";

type StepState = "waiting" | "running" | "done" | "failed" | "skipped";

const STEP_LABELS: Record<ReviewStep, string> = {
  static: "Static analysis",
  model: "Model",
  checking: "Checking fixes",
};

// The same steps in the folded 'Review details' line.
const SHORT_STEP_LABELS: Record<ReviewStep, string> = {
  static: "Static",
  model: "Model",
  checking: "Checks",
};

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// Kept as a name for existing imports; the one time format lives in ./format.
export const formatMs = formatDuration;

// A review that finished before phases existed (a migrated row: no timings, no static
// result) has no steps to show; drawing ticks and "0 rule findings" for a static step that
// never ran would be wrong.
export function hasSteps(review: Review): boolean {
  if (!review.phase) return false; // an API that does not send phases yet
  if (isActive(review.status)) return true;
  if (review.phase === "queued") return false;
  return (
    Object.keys(review.phaseTimings ?? {}).length > 0 ||
    review.staticSupported !== null
  );
}

// The step a failed review failed in, as the API recorded it (phaseTimings.failedPhase), or null
// for a review that failed before the API recorded it.
function recordedFailedStep(review: Review): ReviewStep | null {
  const value = ((review.phaseTimings ?? {}) as Record<string, unknown>)
    .failedPhase;
  return (REVIEW_STEPS as readonly unknown[]).includes(value)
    ? (value as ReviewStep)
    : null;
}

// Each step's state, from the phase and the timings. A failed review's phase is 'failed'; the
// step that failed is the one the API recorded in phaseTimings.failedPhase, the ones before it
// are done and the ones after it never ran. (A model timeout keeps its model timing, so missing
// timings can't tell which step failed.) Reviews that failed before failedPhase was recorded
// fall back to the first step without a timing.
export function stepStates(review: Review): Record<ReviewStep, StepState> {
  const timings = review.phaseTimings ?? {};
  const states = {} as Record<ReviewStep, StepState>;
  if (review.status === "done") {
    for (const step of REVIEW_STEPS) states[step] = "done";
    return states;
  }
  if (review.status === "failed") {
    const recorded = recordedFailedStep(review);
    const at =
      recorded !== null
        ? REVIEW_STEPS.indexOf(recorded)
        : (REVIEW_STEPS as readonly string[]).includes(review.phase)
          ? REVIEW_STEPS.indexOf(review.phase as ReviewStep)
          : REVIEW_STEPS.findIndex((step) => timings[step] === undefined);
    REVIEW_STEPS.forEach((step, i) => {
      states[step] =
        at === -1 || i < at ? "done" : i === at ? "failed" : "skipped";
    });
    return states;
  }
  const at =
    review.phase === "done"
      ? REVIEW_STEPS.length
      : REVIEW_STEPS.indexOf(review.phase as ReviewStep);
  REVIEW_STEPS.forEach((step, i) => {
    states[step] =
      at === -1
        ? "waiting"
        : i < at
          ? "done"
          : i === at
            ? "running"
            : "waiting";
  });
  return states;
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "running")
    return <Spinner className="h-4 w-4 text-amber-600 dark:text-amber-400" />;
  if (state === "done") {
    return (
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="h-4 w-4 fill-current text-green-600 dark:text-green-400"
      >
        <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
      </svg>
    );
  }
  if (state === "failed") {
    return (
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="h-4 w-4 fill-current text-red-600 dark:text-red-400"
      >
        <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
      </svg>
    );
  }
  return (
    <span
      aria-hidden
      className="mx-[5px] h-1.5 w-1.5 rounded-full bg-gray-300 dark:bg-gray-600"
    />
  );
}

const STATE_WORDS: Record<StepState, string> = {
  waiting: "waiting",
  running: "running",
  done: "done",
  failed: "failed",
  skipped: "not run",
};

// What each step found, in a few words.
function stepDetail(
  step: ReviewStep,
  state: StepState,
  review: Review,
  staticRules: boolean,
): string | null {
  const findings = review.findings ?? [];
  if (step === "static") {
    if (!staticRules) return "No static rules for this language yet";
    if (state === "running") return "Parsing the code and running the rules";
    if (review.analysisError)
      return `Static analysis stopped: ${review.analysisError}; the model reviewed the code alone`;
    if (state === "done")
      return plural(
        findings.filter((f) => f.source === "rule").length,
        "rule finding",
      );
    return null;
  }
  if (step === "model") {
    const model = review.model ? ` (${review.model})` : "";
    if (state === "running") return `Waiting for the model${model}`;
    if (state === "done") {
      const dupes =
        review.duplicateCount > 0
          ? `; ${plural(review.duplicateCount, "repeat")} of a rule finding dropped`
          : "";
      return `${plural(findings.filter((f) => f.source === "model").length, "AI finding")}${dupes}${model}`;
    }
    return null;
  }
  if (state === "running")
    return "Applying each proposed fix and re-running the rules";
  if (state === "done") {
    const fixes = findings.filter((f) => f.fix).length;
    const checked = findings.filter(
      (f) => f.fix && f.fixCheck !== "not_checked",
    ).length;
    if (!fixes) return "No fixes to check";
    return checked === fixes
      ? `${plural(fixes, "fix", "fixes")} checked`
      : `${checked} of ${plural(fixes, "fix", "fixes")} checked`;
  }
  return null;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={`h-3 w-3 shrink-0 fill-current text-[var(--muted)] transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

// A step can be opened once it has started; a waiting or skipped step has nothing to list.
function canOpen(state: StepState): boolean {
  return state === "running" || state === "done" || state === "failed";
}

function StepList({
  review,
  language,
}: {
  review: Review;
  language: Language;
}) {
  const states = stepStates(review);
  const timings = review.phaseTimings ?? {};
  // Before the static step reports, go by the language.
  const staticRules =
    review.staticSupported ?? STATIC_LANGUAGES.includes(language);
  // Collapsed by default; a new review starts collapsed again.
  const [open, setOpen] = useState<{
    reviewId: number;
    steps: ReadonlySet<ReviewStep>;
  }>({
    reviewId: review.id,
    steps: new Set(),
  });
  const openSteps =
    open.reviewId === review.id ? open.steps : new Set<ReviewStep>();
  const toggle = (step: ReviewStep) => {
    const next = new Set(openSteps);
    if (next.has(step)) next.delete(step);
    else next.add(step);
    setOpen({ reviewId: review.id, steps: next });
  };
  // While the review runs each poll hands us a new review object: refetch with it. Once it
  // has finished the mark stops changing, so an open step does not refetch on every render.
  const pollMark = isActive(review.status) ? review : review.status;
  const events = useReviewEvents(review.id, openSteps.size > 0, pollMark);
  const failedAt =
    REVIEW_STEPS.find((step) => states[step] === "failed") ?? null;
  const baseId = useId();

  return (
    <ol aria-label="Review steps" className="space-y-1.5">
      {REVIEW_STEPS.map((step) => {
        const state = states[step];
        const detail = stepDetail(step, state, review, staticRules);
        const ms = timings[step];
        const expandable = canOpen(state);
        const isOpen = expandable && openSteps.has(step);
        const panelId = `${baseId}-${step}-events`;
        const row = (
          <>
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              <StepIcon state={state} />
            </span>
            <span
              className={`font-medium ${state === "waiting" || state === "skipped" ? "text-[var(--muted)]" : ""}`}
            >
              {STEP_LABELS[step]}
            </span>
            <span className="sr-only">: {STATE_WORDS[state]}</span>
            {detail && (
              <span className="min-w-0 truncate text-xs text-[var(--muted)]">
                {detail}
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {ms !== undefined && (
                <span className="text-xs tabular-nums text-[var(--muted)]">
                  {formatMs(ms)}
                </span>
              )}
              {expandable && <Chevron open={isOpen} />}
            </span>
          </>
        );
        return (
          <li key={step} className="text-sm">
            {expandable ? (
              <button
                type="button"
                aria-label={[
                  STEP_LABELS[step],
                  STATE_WORDS[state],
                  detail,
                  ms !== undefined ? formatDuration(ms) : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
                aria-expanded={isOpen}
                aria-controls={isOpen ? panelId : undefined}
                onClick={() => toggle(step)}
                className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2.5 rounded px-1.5 py-0.5 text-left hover:bg-[var(--background)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500"
              >
                {row}
                <span className="sr-only">
                  {isOpen ? ", hide events" : ", show events"}
                </span>
              </button>
            ) : (
              <div className="flex items-center gap-2.5 py-0.5">{row}</div>
            )}
            {isOpen && (
              <StepEvents
                id={panelId}
                step={step}
                state={events}
                review={review}
                failedAt={failedAt}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// Older reviews stored this in place of the detected signals when the user chose the context.
const LEGACY_USER_SIGNAL = "set by the user";

// Which context the review used, and why: the user's choice (kept on the snippet) next to what
// detection saw (the review's contextSignals), or the detected signals alone.
function ContextLine({
  review,
  snippetContext,
}: {
  review: Review;
  snippetContext: CodeContext | null;
}) {
  if (!review.context) return null;
  const signals = (review.contextSignals ?? []).filter(
    (s) => s !== LEGACY_USER_SIGNAL,
  );
  const byUser = snippetContext !== null;
  let why: string;
  if (byUser)
    why = signals.length
      ? `set by you (detected: ${signals.join(" · ")})`
      : "set by you";
  else if (signals.length) why = `detected: ${signals.join(" · ")}`;
  else why = "nothing in the code pointed to a kind, so only general rules ran";
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--muted)]">
      <span className="font-medium text-[var(--foreground)]">Context</span>
      <ContextTag
        context={review.context}
        title={
          byUser
            ? "Set by you when the snippet was created"
            : "Detected from the code"
        }
      />
      <span className="break-words">{why}</span>
    </p>
  );
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

// '1,950 in (1,948 written to cache · 0 read from cache · 2 uncached) · 407 out · 5.8 s ·
// ~$0.0089 (CLI estimate)'. Total input is uncached + read from cache + written to cache: the
// CLI caches the prompt, so inputTokens alone hides most of what was sent. The cost is only
// what the API saved; with no costUsd it says 'cost not configured' rather than guess a price.
export function usageLine(review: Review): string {
  const parts: string[] = [];
  const tokens = [
    review.inputTokens,
    review.outputTokens,
    review.cacheReadTokens,
    review.cacheWriteTokens,
  ];
  if (tokens.some((t) => t !== null && t !== undefined)) {
    const uncached = review.inputTokens ?? 0;
    const read = review.cacheReadTokens ?? 0;
    const written = review.cacheWriteTokens ?? 0;
    parts.push(
      `${count(uncached + read + written)} in (${count(written)} written to cache · ${count(read)} read from cache · ${count(uncached)} uncached)`,
    );
    parts.push(`${count(review.outputTokens ?? 0)} out`);
  } else {
    parts.push("tokens not reported");
  }
  const modelMs = review.phaseTimings?.model;
  if (modelMs !== undefined) parts.push(formatMs(modelMs));
  if (review.costUsd === null || review.costUsd === undefined) {
    parts.push("cost not configured");
  } else {
    const source =
      review.costSource === "cli"
        ? " (CLI estimate)"
        : review.costSource === "price-config"
          ? " (priced from settings)"
          : "";
    parts.push(`~${formatUsd(review.costUsd)}${source}`);
  }
  return parts.join(" · ");
}

// Did the review get as far as asking the model? Only then is there usage to show.
function reachedModel(review: Review): boolean {
  return (
    review.phaseTimings?.model !== undefined ||
    (review.inputTokens ?? null) !== null ||
    (review.outputTokens ?? null) !== null ||
    (review.costUsd ?? null) !== null ||
    (review.status === "done" && review.phase === "done")
  );
}

// The folded line: 'Static 12 ms · Model 5.7 s · Checks 6 ms · Backend · ~$0.0089'. While the
// review runs it ends at the current step, with a spinner; a failed step says so.
function DetailsSummary({
  review,
  language,
  showCost,
}: {
  review: Review;
  language: Language;
  showCost: boolean;
}) {
  const states = stepStates(review);
  const staticRules =
    review.staticSupported ?? STATIC_LANGUAGES.includes(language);
  const timings = review.phaseTimings ?? {};
  const active = isActive(review.status);
  const parts: ReactNode[] = [];
  for (const step of REVIEW_STEPS) {
    const state = states[step];
    const ms = timings[step];
    if (state === "waiting") continue;
    if (state === "running") {
      const detail = stepDetail(step, state, review, staticRules);
      parts.push(
        <>
          <Spinner className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="font-medium text-[var(--foreground)]">
            {STEP_LABELS[step]}
          </span>
          {detail && <span>{detail}</span>}
        </>,
      );
      continue;
    }
    const words =
      state === "failed"
        ? "failed"
        : state === "skipped"
          ? "not run"
          : ms !== undefined
            ? formatDuration(ms)
            : "done";
    parts.push(
      <span
        className={
          state === "failed" ? "font-medium text-red-700 dark:text-red-400" : ""
        }
      >
        {SHORT_STEP_LABELS[step]} <span className="tabular-nums">{words}</span>
      </span>,
    );
  }
  if (!active && review.context) parts.push(CONTEXT_LABELS[review.context]);
  if (showCost && review.costUsd !== null && review.costUsd !== undefined) {
    parts.push(
      <span className="tabular-nums">~{formatUsd(review.costUsd)}</span>,
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[var(--muted)]">
      {parts.map((part, i) => (
        // The separator trails its item, so a wrapped line never starts with one.
        <span key={i} className="inline-flex items-center gap-1.5">
          {part}
          {i < parts.length - 1 && <span aria-hidden>&middot;</span>}
        </span>
      ))}
    </span>
  );
}

// The steps a review goes through, the context it used and, once the model has answered,
// what that cost, under one 'Review details' line below the summary row (open by default, so
// the step list, context and usage are visible at once; the line folds them away and, while a
// review runs, shows the current step). Each step in the list opens to its events.
export function ReviewSteps({
  review,
  language,
  snippetContext,
}: {
  review: Review;
  language: Language;
  snippetContext: CodeContext | null;
}) {
  const [open, setOpen] = useState(true);
  const panelId = useId();
  if (!hasSteps(review)) return null;
  const showUsage = !isActive(review.status) && reachedModel(review);
  return (
    <div className="text-sm">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs hover:bg-[var(--background)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500"
      >
        <span className="shrink-0 font-medium text-[var(--foreground)]">
          Review details
        </span>
        <DetailsSummary
          review={review}
          language={language}
          showCost={showUsage}
        />
        <span className="ml-auto shrink-0">
          <Chevron open={open} />
        </span>
      </button>
      {/* Kept mounted while folded, so the steps opened inside it stay open. */}
      <div
        id={panelId}
        hidden={!open}
        className="mt-2 space-y-2.5 border-t border-[var(--border)] pt-2.5"
      >
        <StepList review={review} language={language} />
        <ContextLine review={review} snippetContext={snippetContext} />
        {showUsage && (
          <p className="text-xs tabular-nums text-[var(--muted)]">
            <span className="font-medium text-[var(--foreground)]">Usage</span>{" "}
            {usageLine(review)}
          </p>
        )}
      </div>
    </div>
  );
}
