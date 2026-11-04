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
export const ACTIVE_REVIEW_STATUSES: ReviewStatus[] = ['pending', 'running'];

export const SEVERITIES = ['critical', 'warning', 'info'] as const;
export const CATEGORIES = ['bug', 'security', 'performance', 'style'] as const;

export const FINDING_STATUSES = ['open', 'accepted', 'dismissed'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

// Keeps one review to a size the model handles well and a cost we control.
export const MAX_CODE_CHARS = 20000;
export const MAX_CODE_LINES = 1000;

// What kind of code a snippet is. Detected from the code by the static analyzers, or set by the user.
export const CODE_CONTEXTS = ['frontend', 'backend', 'script', 'test', 'query', 'unknown'] as const;
export type CodeContext = (typeof CODE_CONTEXTS)[number];

// Languages that get static rules before the model; every other language is model-only.
export const STATIC_LANGUAGES = ['javascript', 'typescript', 'python', 'sql'] as const;

// Where a review is right now. queued -> static -> model -> checking -> done (or failed at any point).
export const REVIEW_PHASES = ['queued', 'static', 'model', 'checking', 'done', 'failed'] as const;
export type ReviewPhase = (typeof REVIEW_PHASES)[number];

// Who raised a finding: a deterministic rule, or the model.
export const FINDING_SOURCES = ['rule', 'model'] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

// Result of checking a finding's proposed fix: not_checked (no fix, or nothing could check it),
// passed (every check that could run passed), failed (at least one check failed).
export const FIX_CHECKS = ['not_checked', 'passed', 'failed'] as const;
export type FixCheck = (typeof FIX_CHECKS)[number];

// What a review's event log records, one type per thing that happens (the decision 'review event types').
// finding.resolved is the user's label on a finding; events.truncated says the log hit its size limit.
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

// A hostile model answer must not flood the log: at most this many events per review, the last
// of them events.truncated when anything was dropped. A rejected suggestion keeps this much of its JSON.
export const MAX_EVENTS_PER_REVIEW = 500;
export const MAX_REJECTED_RAW_CHARS = 2000;
