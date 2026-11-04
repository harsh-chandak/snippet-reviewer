import type {
  CreateSnippetInput,
  CreatedSnippet,
  FieldErrors,
  Finding,
  FindingStatus,
  Language,
  ListSnippetsParams,
  Review,
  ReviewEvent,
  ReviewEventList,
  SnippetDetail,
} from './types';
import type { SnippetListPage } from './dashboardTypes';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

export interface ApiResponse<T> {
  message: string;
  data: T;
  success: boolean;
}

// Thrown for every failed call. `status` is the HTTP status (0 when the API could not be
// reached) and `data` is the API's `data` field: for a 400 validation error it is
// { field: [messages] }, which `fieldErrors` exposes for forms.
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly data: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  // Per-field messages from a 400 validation error, or null for any other error.
  get fieldErrors(): FieldErrors | null {
    if (this.status !== 400 || !this.data || typeof this.data !== 'object' || Array.isArray(this.data)) {
      return null;
    }
    return this.data as FieldErrors;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

// The text to show for any error a call might throw. The API's own messages are written
// for users (a 409 already says "A review is already in progress for this snippet").
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

// One place for every call to the API, so errors look the same everywhere.
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new ApiError('Could not reach the API. Is it running?', 0);
  }
  const body = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  if (!res.ok || !body?.success) {
    throw new ApiError(body?.message || `Request failed with ${res.status}`, res.status, body?.data ?? null);
  }
  return body.data;
}

function query(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

// GET /snippets — newest first, each with the open-finding counts of its latest review.
// Pass the page's nextCursor as `cursor` for the next page.
export function listSnippets(params: ListSnippetsParams = {}): Promise<SnippetListPage> {
  return api<SnippetListPage>(`/snippets${query(params)}`);
}

// GET /snippets/:id — the snippet, its code and its latest review with findings.
export function getSnippet(id: number): Promise<SnippetDetail> {
  return api<SnippetDetail>(`/snippets/${id}`);
}

// POST /snippets — 400 carries per-field messages in ApiError.fieldErrors.
export function createSnippet(input: CreateSnippetInput): Promise<CreatedSnippet> {
  return api<CreatedSnippet>('/snippets', { method: 'POST', body: JSON.stringify(input) });
}

// POST /snippets/:id/reviews — 202 with the new review (no findings yet).
// 409 (ApiError.isConflict) means a review is already in progress.
export function startReview(snippetId: number): Promise<Review> {
  return api<Review>(`/snippets/${snippetId}/reviews`, { method: 'POST' });
}

// GET /reviews/:id — the review with its findings. Poll while status is pending or running.
export function getReview(id: number): Promise<Review> {
  return api<Review>(`/reviews/${id}`);
}

// GET /reviews/:id/events — what each step of the review did, ordered by id.
// 404 (ApiError.isNotFound) means the review does not exist.
export async function listReviewEvents(reviewId: number): Promise<ReviewEvent[]> {
  const data = await api<ReviewEventList>(`/reviews/${reviewId}/events`);
  return data.items;
}

// PATCH /findings/:id — accept, dismiss or reopen a finding.
export function setFindingStatus(id: number, status: FindingStatus): Promise<Finding> {
  return api<Finding>(`/findings/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
}

// GET /languages — the languages the API accepts.
export function listLanguages(): Promise<Language[]> {
  return api<Language[]>('/languages');
}
