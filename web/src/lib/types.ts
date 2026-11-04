// Types for what the API sends back. Copied from api/src/model/constants.ts and the
// Sequelize schemas, because the frontend is a separate package. Keep them in step.
// Dates arrive as ISO strings (JSON has no Date type).

export const LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'java',
  'go',
  'rust',
  'c',
  'cpp',
  'csharp',
  'ruby',
  'php',
  'sql',
  'other',
] as const;
export type Language = (typeof LANGUAGES)[number];

// What the dashboard shows for each snippet.
export const SNIPPET_REVIEW_STATUSES = ['not_reviewed', 'in_progress', 'reviewed', 'failed'] as const;
export type SnippetReviewStatus = (typeof SNIPPET_REVIEW_STATUSES)[number];

// The life of one review run.
export const REVIEW_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
// Poll GET /reviews/:id while the review is in one of these.
export const ACTIVE_REVIEW_STATUSES: readonly ReviewStatus[] = ['pending', 'running'];

export const SEVERITIES = ['critical', 'warning', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = ['bug', 'security', 'performance', 'style'] as const;
export type Category = (typeof CATEGORIES)[number];

export const FINDING_STATUSES = ['open', 'accepted', 'dismissed'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

// Same limits the API validates, so the create form can warn before submitting.
export const MAX_CODE_CHARS = 20000;
export const MAX_CODE_LINES = 1000;

// What kind of code a snippet is: detected from the code, or set by the user on create.
export const CODE_CONTEXTS = ['frontend', 'backend', 'script', 'test', 'query', 'unknown'] as const;
export type CodeContext = (typeof CODE_CONTEXTS)[number];
// What POST /snippets accepts for `context`: a context, or 'auto' (detect it; stored as null).
export type ContextChoice = CodeContext | 'auto';

// Languages that get static rules before the model; every other language is model-only.
export const STATIC_LANGUAGES: readonly Language[] = ['javascript', 'typescript', 'python', 'sql'];

// Where a review is right now: queued -> static -> model -> checking -> done (or failed at any point).
export const REVIEW_PHASES = ['queued', 'static', 'model', 'checking', 'done', 'failed'] as const;
export type ReviewPhase = (typeof REVIEW_PHASES)[number];

// The phases that have a timing and a row in the step list, in order.
export const REVIEW_STEPS = ['static', 'model', 'checking'] as const;
export type ReviewStep = (typeof REVIEW_STEPS)[number];

// Who raised a finding: a deterministic rule, or the model.
export const FINDING_SOURCES = ['rule', 'model'] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

// Result of checking a finding's proposed fix.
export const FIX_CHECKS = ['not_checked', 'passed', 'failed'] as const;
export type FixCheck = (typeof FIX_CHECKS)[number];

// Where costUsd came from: the CLI's own total, or token counts priced from LLM_PRICE_* settings.
export const COST_SOURCES = ['cli', 'price-config'] as const;
export type CostSource = (typeof COST_SOURCES)[number];

// One item in GET /snippets. The list leaves out `code`.
export interface Snippet {
  id: number;
  title: string;
  language: Language;
  reviewStatus: SnippetReviewStatus;
  createdAt: string;
  updatedAt: string;
}

// "Replace lines lineStart..lineEnd (inclusive) with `replacement`" (empty deletes them).
export interface FixReplacement {
  lineStart: number;
  lineEnd: number;
  replacement: string;
}

// What the fix checker found. null means the check could not run (no analyzer for the
// language, or ruleCleared on a model finding).
export interface FixCheckDetail {
  parses: boolean | null;
  ruleCleared: boolean | null;
  newRuleIds: string[];
  note: string;
}

export interface Finding {
  id: number;
  reviewId: number;
  lineStart: number;
  lineEnd: number;
  severity: Severity;
  category: Category;
  description: string;
  suggestedFix: string | null;
  status: FindingStatus;
  source: FindingSource;
  ruleId: string | null; // set for rule findings, e.g. 'js/sql-string-concat'
  fix: FixReplacement | null;
  fixCheck: FixCheck;
  fixCheckDetail: FixCheckDetail | null;
  createdAt: string;
  updatedAt: string;
}

// GET /reviews/:id and latestReview include `findings`; POST /snippets/:id/reviews does not.
export interface Review {
  id: number;
  snippetId: number;
  status: ReviewStatus;
  error: string | null;
  provider: string;
  rejectedCount: number;
  phase: ReviewPhase;
  phaseTimings: Partial<Record<ReviewStep, number>> & { failedPhase?: ReviewStep }; // ms per finished step; failedPhase on failure
  context: CodeContext | null; // the context the review used: the user's, else the detected one
  contextSignals: string[]; // why that context, in plain words ('imports express')
  staticSupported: boolean | null; // false: no static rules for this language; null until the static step ran
  // Why static analysis stopped (out of time or memory, or the analyzer failed), in plain words; the
  // review then went on model-only with no rule findings. Null when it finished; absent from older APIs.
  analysisError?: string | null;
  duplicateCount: number; // model findings dropped because a rule already reported them
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null; // null when no price is known; never estimated by the frontend
  costSource: CostSource | null;
  promptVersion?: string | null; // 12 hex chars of the prompt the model got; null before the event log
  rulesetVersion?: string | null; // 12 hex chars of the rule ids and parser versions; null before the event log
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  findings?: Finding[];
}

// What happened during a review, one row per thing, in order (GET /reviews/:id/events).
export const REVIEW_EVENT_TYPES = [
  'review.started',
  'static.parsed',
  'static.rule_hit',
  'model.called',
  'model.failed',
  'model.finding_kept',
  'model.finding_rejected',
  'model.duplicate',
  'fix.checked',
  'review.done',
  'review.failed',
  'finding.resolved',
  'events.truncated',
] as const;
export type ReviewEventType = (typeof REVIEW_EVENT_TYPES)[number];

// The payload of each event type, as the API writes it.
export interface ReviewEventPayloads {
  'review.started': { provider: string };
  'static.parsed': {
    supported: boolean;
    parseOk: boolean | null;
    parseError: string | null;
    context: CodeContext | null;
    signals: string[];
    outlineItems: number;
    rulesChecked?: string[];
    ms: number;
  };
  'static.rule_hit': {
    ruleId: string;
    lineStart: number;
    lineEnd: number;
    severity: Severity;
    category: Category;
    hasFix: boolean;
  };
  'model.called': {
    provider: string;
    model: string | null;
    promptVersion: string | null;
    context: CodeContext | null;
    hintsSent: number;
    outlineItemsSent: number;
    promptChars: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    totalInputTokens: number | null;
    costUsd: number | null;
    costSource: CostSource | null;
    ms: number;
  };
  'model.failed': { message: string; ms: number };
  'model.finding_kept': {
    lineStart: number;
    lineEnd: number;
    severity: Severity;
    category: Category;
    hasFix: boolean;
  };
  'model.finding_rejected': { reason: string; raw: string }; // raw: the suggestion as JSON, cut to 2000 chars
  'model.duplicate': { lineStart: number; category: Category; ruleId: string | null };
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
  'review.failed': { phase: ReviewPhase | string; message: string; ms: number };
  'finding.resolved': { findingId: number; reviewId: number; from: FindingStatus; to: FindingStatus };
  'events.truncated': { dropped: number };
}

// One row of review_events. Narrow on `type` to get the payload's shape.
export type ReviewEvent = {
  [T in ReviewEventType]: { id: number; reviewId: number; type: T; payload: ReviewEventPayloads[T]; createdAt: string };
}[ReviewEventType];

// GET /reviews/:id/events.
export interface ReviewEventList {
  items: ReviewEvent[];
}

// GET /snippets/:id: the snippet with its code and its most recent review (null if never reviewed).
export interface SnippetDetail extends Snippet {
  code: string;
  context: CodeContext | null; // set by the user on create; null means detect automatically
  latestReview: Review | null;
}

// POST /snippets: the new snippet with its code; it has no review yet.
export type CreatedSnippet = Omit<SnippetDetail, 'latestReview'>;

// GET /snippets. Send nextCursor back as `cursor` for the next page; null means no more.
export interface SnippetPage {
  items: Snippet[];
  nextCursor: number | null;
}

export interface ListSnippetsParams {
  language?: Language;
  status?: SnippetReviewStatus;
  cursor?: number;
  limit?: number;
}

export interface CreateSnippetInput {
  title: string;
  language: Language;
  code: string;
  context?: ContextChoice; // omitted or 'auto' = detect from the code
}

// The `data` of a 400 validation error: field name -> messages.
export type FieldErrors = Record<string, string[]>;
