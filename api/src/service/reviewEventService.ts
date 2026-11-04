import { Transaction } from 'sequelize';
import { NewReviewEvent, reviewEventDao } from '../model/dao/ReviewEventDao';
import { reviewDao } from '../model/dao/ReviewDao';
import { CodeContext, FindingSource, FindingStatus, FixCheck, MAX_EVENTS_PER_REVIEW, MAX_REJECTED_RAW_CHARS, ReviewPhase } from '../model/constants';
import { HttpError } from '../utils/httpError';

type Severity = 'critical' | 'warning' | 'info';
type Category = 'bug' | 'security' | 'performance' | 'style';

// The payload of each event type (the decision 'review event payloads'). No event carries the
// snippet's code; the page and the analytics views both read these shapes.
export interface ReviewEventPayloads {
  'review.started': { provider: string };
  'static.parsed': {
    supported: boolean;
    parseOk: boolean;
    parseError: string | null;
    context: CodeContext;
    signals: string[];
    outlineItems: number;
    rulesChecked?: string[];
    ms: number;
  };
  'static.rule_hit': { ruleId: string; lineStart: number; lineEnd: number; severity: Severity; category: Category; hasFix: boolean };
  'model.called': {
    provider: string;
    model: string | null;
    promptVersion: string;
    context: CodeContext;
    hintsSent: number;
    outlineItemsSent: number;
    promptChars: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    totalInputTokens: number | null;
    costUsd: number | null;
    costSource: string | null;
    ms: number;
  };
  'model.failed': { message: string; ms: number };
  'model.finding_kept': { lineStart: number; lineEnd: number; severity: Severity; category: Category; hasFix: boolean };
  'model.finding_rejected': { reason: string; raw: string };
  'model.duplicate': { lineStart: number; category: Category; ruleId: string };
  'fix.checked': {
    findingId: number;
    source: FindingSource;
    ruleId: string | null;
    fixCheck: FixCheck;
    parses: boolean | null;
    ruleCleared: boolean | null;
    newRuleIds: string[];
  };
  'review.done': { ms: number; findings: number; ruleFindings: number; modelFindings: number };
  'review.failed': { phase: ReviewPhase; message: string; ms: number };
  'finding.resolved': { findingId: number; reviewId: number; from: FindingStatus; to: FindingStatus };
  'events.truncated': { dropped: number };
}
export type EventType = keyof ReviewEventPayloads;
export type ReviewEventInput = { [T in EventType]: { type: T; payload: ReviewEventPayloads[T] } }[EventType];

export function event<T extends EventType>(type: T, payload: ReviewEventPayloads[T]): ReviewEventInput {
  return { type, payload } as ReviewEventInput;
}

// Postgres jsonb refuses \u0000 and a lone surrogate (half of an emoji cut in two), and a refused
// event would fail the step it belongs to. Strings are cleaned of both before they are stored.
function cleanString(text: string): string {
  return text.replace(/\u0000/g, '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
}

function clean(value: unknown): unknown {
  if (typeof value === 'string') return cleanString(value);
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [cleanString(k), clean(v)]));
  }
  return value;
}

// A rejected suggestion as the model sent it, as JSON cut to MAX_REJECTED_RAW_CHARS.
export function rawSuggestion(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? String(value);
  } catch {
    json = String(value);
  }
  return cleanString(json.slice(0, MAX_REJECTED_RAW_CHARS));
}

// total input = uncached + read from cache + written to cache (the decision 'total input tokens').
export function totalInputTokens(usage: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

// Lifecycle events say what happened to the review as a whole. The 500-event cap never drops them
// and doesn't count them (the decision 'event cap and lifecycle events'): it counts only the per-item
// events (rule hits, kept, rejected and duplicate suggestions, fix checks, finding.resolved).
export const LIFECYCLE_EVENTS: readonly EventType[] = [
  'review.started',
  'static.parsed',
  'model.called',
  'model.failed',
  'review.done',
  'review.failed',
  'events.truncated',
];
const LIFECYCLE: ReadonlySet<EventType> = new Set(LIFECYCLE_EVENTS);

// Per-item rows a log may hold: the cap less the five slots one run's lifecycle events need
// (review.started, static.parsed, model.called or model.failed, review.done or review.failed, and an
// events.truncated), so a normal run's log stays within MAX_EVENTS_PER_REVIEW rows.
export const MAX_PER_ITEM_EVENTS = MAX_EVENTS_PER_REVIEW - 5;

class ReviewEventService {
  // Appends events to a review's log inside the caller's transaction, so an event is saved exactly
  // when the step it describes is. Lifecycle events always go in. Per-item events go in while the
  // log holds fewer than MAX_PER_ITEM_EVENTS of them, counted from the rows in the table (under a
  // lock, so concurrent writers, say the pipeline and a user labelling findings, share one count).
  // The ones that don't fit are dropped, and this same write adds an events.truncated saying how
  // many, so the count is in the table as soon as anything is dropped, whatever happens after.
  // One exception keeps a full log from growing: user labels (finding.resolved) dropped from a log
  // that has already said it was truncated are dropped without another events.truncated.
  // Returns how many of these events were dropped.
  async append(reviewId: number, events: ReviewEventInput[], transaction: Transaction): Promise<number> {
    if (!events.length) return 0;
    await reviewEventDao.lockReview(reviewId, transaction);
    const stats = await reviewEventDao.stats(reviewId, transaction, LIFECYCLE_EVENTS);
    let room = MAX_PER_ITEM_EVENTS - stats.perItem;
    const rows: NewReviewEvent[] = [];
    let dropped = 0;
    let droppedOnlyLabels = true;
    for (const e of events) {
      if (LIFECYCLE.has(e.type) || room > 0) {
        if (!LIFECYCLE.has(e.type)) room--;
        rows.push({ type: e.type, payload: clean(e.payload) as Record<string, unknown> });
      } else {
        dropped++;
        if (e.type !== 'finding.resolved') droppedOnlyLabels = false;
      }
    }
    if (dropped && !(stats.truncated && droppedOnlyLabels)) {
      rows.push({ type: 'events.truncated', payload: { dropped } });
    }
    await reviewEventDao.insert(reviewId, rows, transaction);
    return dropped;
  }

  async listForReview(reviewId: number) {
    const review = await reviewDao.findById(reviewId);
    if (!review) throw new HttpError(404, 'Review not found');
    const items = await reviewEventDao.listForReview(reviewId);
    return { items };
  }
}

export const reviewEventService = new ReviewEventService();

// The events of one review run, collected for the transaction that saves the step they describe
// and written with it. The cap is applied by append, against the rows already in the table.
export class ReviewEventBuffer {
  private pending: ReviewEventInput[] = [];

  constructor(private reviewId: number) {}

  add(...events: ReviewEventInput[]) {
    this.pending.push(...events);
  }

  // Writes what was added since the last flush.
  async flush(transaction: Transaction) {
    const events = this.pending;
    this.pending = [];
    await reviewEventService.append(this.reviewId, events, transaction);
  }

  // Forgets unwritten events, when the transaction they were meant for did not commit.
  discard() {
    this.pending = [];
  }
}
