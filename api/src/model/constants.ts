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
