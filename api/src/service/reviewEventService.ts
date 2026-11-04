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

class ReviewEventService {
  // Appends events to a review's log inside the caller's transaction, so an event is saved exactly
  // when the step it describes is. The log holds at most MAX_EVENTS_PER_REVIEW rows: the events
  // that don't fit are dropped and, the first time that happens, the last free row says how many.
  // `dropped` counts events the caller already dropped (see ReviewEventBuffer); they go in that
  // same truncated event. Returns how many of these events were dropped here.
  async append(reviewId: number, events: ReviewEventInput[], transaction: Transaction, dropped = 0): Promise<number> {
    if (!events.length && !dropped) return 0;
    await reviewEventDao.lockReview(reviewId, transaction);
    const stats = await reviewEventDao.stats(reviewId, transaction);
    const rows: NewReviewEvent[] = events.map((e) => ({ type: e.type, payload: clean(e.payload) as Record<string, unknown> }));

    const room = MAX_EVENTS_PER_REVIEW - stats.total;
    if (rows.length <= room && !dropped) {
      await reviewEventDao.insert(reviewId, rows, transaction);
      return 0;
    }
    // Something is dropped. Once the log has said so, later events are dropped without a word:
    // rows are never updated, so that count can't grow.
    if (stats.truncated || room <= 0) return rows.length;
    const kept = rows.slice(0, Math.min(rows.length, room - 1));
    const droppedHere = rows.length - kept.length;
    kept.push({ type: 'events.truncated', payload: { dropped: droppedHere + dropped } });
    await reviewEventDao.insert(reviewId, kept, transaction);
    return droppedHere;
  }

  async listForReview(reviewId: number) {
    const review = await reviewDao.findById(reviewId);
    if (!review) throw new HttpError(404, 'Review not found');
    const items = await reviewEventDao.listForReview(reviewId);
    return { items };
  }
}

export const reviewEventService = new ReviewEventService();

// The lifecycle events of one run (static.parsed, model.called or model.failed, review.done or
// review.failed) plus review.started and an events.truncated: room kept for them whatever the
// model sends, so a flood of rejected suggestions can't push out the events that say what happened.
const RESERVED_FOR_LIFECYCLE = 5;
const LIFECYCLE: ReadonlySet<EventType> = new Set<EventType>([
  'review.started',
  'static.parsed',
  'model.called',
  'model.failed',
  'review.done',
  'review.failed',
]);

// The events of one review run, written step by step. Per-item events (rule hits, kept, rejected,
// duplicate, fix checks) share a budget that leaves room for the lifecycle events; the ones over
// it are counted and reported in one events.truncated event when the run ends (done or failed).
export class ReviewEventBuffer {
  private pending: ReviewEventInput[] = [];
  private detailWritten = 0;
  private dropped = 0;

  constructor(private reviewId: number, private detailBudget = MAX_EVENTS_PER_REVIEW - RESERVED_FOR_LIFECYCLE) {}

  add(...events: ReviewEventInput[]) {
    for (const e of events) {
      if (LIFECYCLE.has(e.type)) {
        this.pending.push(e);
      } else if (this.detailWritten < this.detailBudget) {
        this.detailWritten++;
        this.pending.push(e);
      } else {
        this.dropped++;
      }
    }
  }

  // Writes what was added since the last flush. `final` on the run's last transaction, which also
  // records how many events the budget dropped.
  async flush(transaction: Transaction, { final = false } = {}) {
    const events = this.pending;
    this.pending = [];
    const dropped = final ? this.dropped : 0;
    if (final) this.dropped = 0;
    // Anything the size limit drops here is reported by append itself, in the log's one events.truncated.
    await reviewEventService.append(this.reviewId, events, transaction, dropped);
  }

  // Forgets unwritten events, when the transaction they were meant for did not commit.
  discard() {
    this.pending = [];
  }
}
