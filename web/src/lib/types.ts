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

// One item in GET /snippets. The list leaves out `code`.
export interface Snippet {
  id: number;
  title: string;
  language: Language;
  reviewStatus: SnippetReviewStatus;
  createdAt: string;
  updatedAt: string;
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
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  findings?: Finding[];
}

// GET /snippets/:id: the snippet with its code and its most recent review (null if never reviewed).
export interface SnippetDetail extends Snippet {
  code: string;
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
}

// The `data` of a 400 validation error: field name -> messages.
export type FieldErrors = Record<string, string[]>;
