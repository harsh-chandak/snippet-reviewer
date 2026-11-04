import http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import app from '../src/app';
import db from '../src/db/postgres';
import { fakeProvider } from '../src/service/llm/fakeProvider';

// Guard rails: these tests truncate tables, so they must only ever see the test database,
// and they must never reach a real model.
if (!/\/snippets_test[a-z0-9_]*$/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error(`Tests must run against snippets_test, got DATABASE_URL=${process.env.DATABASE_URL}`);
}
if (process.env.LLM_PROVIDER !== 'fake') {
  throw new Error(`Tests must run with LLM_PROVIDER=fake, got ${process.env.LLM_PROVIDER}`);
}

export const V1 = '/api/v1';

// One server per test file, bound to 127.0.0.1 explicitly. Left to itself, supertest listens on
// `::` and then dials 127.0.0.1:<port>; on a machine with other local listeners that request can
// land on a different process bound to 127.0.0.1 on the same port (seen as a stray 401 or a hang).
const server = http.createServer(app);
export const api = () => {
  if (!server.listening) throw new Error('Call useTestDatabase() at the top of the test file');
  return request(server);
};
export { db, fakeProvider };

export type SnippetInput = { title: string; language: string; code: string; context?: string };

export async function resetState() {
  await db.query('TRUNCATE TABLE findings, reviews, snippets RESTART IDENTITY CASCADE');
  fakeProvider.reset();
}

// A review started through the API keeps running after the response (setImmediate).
// Wait for every such run to finish, so it can't write into the next test's data.
export async function waitForBackgroundReviews(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [rows] = await db.query(`SELECT count(*)::int AS n FROM reviews WHERE status IN ('pending', 'running')`);
    if ((rows as { n: number }[])[0].n === 0) return;
    if (Date.now() > deadline) {
      throw new Error('A review was still pending or running after the test; a test left an active review behind');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Call at the top of every test file: a clean database and fake model per test, and the
// connection pool closed at the end so the worker can exit.
export function useTestDatabase() {
  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { address } = server.address() as AddressInfo;
    if (address !== '127.0.0.1') throw new Error(`Test server bound to ${address}, expected 127.0.0.1`);
  });
  beforeEach(resetState);
  afterEach(() => waitForBackgroundReviews());
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  });
}

export async function createSnippet(overrides: Partial<SnippetInput> = {}) {
  const body: SnippetInput = {
    title: 'Sum two numbers',
    language: 'javascript',
    code: 'function sum(a, b) {\n  return a + b;\n}',
    ...overrides,
  };
  const res = await api().post(`${V1}/snippets`).send(body);
  if (res.status !== 201) throw new Error(`createSnippet failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as {
    id: number;
    title: string;
    language: string;
    code: string;
    context: string | null;
    reviewStatus: string;
  };
}

export async function getSnippet(id: number) {
  const res = await api().get(`${V1}/snippets/${id}`);
  if (res.status !== 200) throw new Error(`getSnippet failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

export async function startReview(snippetId: number) {
  const res = await api().post(`${V1}/snippets/${snippetId}/reviews`);
  if (res.status !== 202) throw new Error(`startReview failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as { id: number; status: string; snippetId: number };
}

// Polls GET /reviews/:id, the way the client does, until the review is done or failed.
export async function waitForReview(reviewId: number, { timeoutMs = 10_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api().get(`${V1}/reviews/${reviewId}`);
    if (res.status !== 200) throw new Error(`GET /reviews/${reviewId} returned ${res.status}`);
    const review = res.body.data;
    if (review.status === 'done' || review.status === 'failed') return review;
    if (Date.now() > deadline) throw new Error(`Review ${reviewId} still ${review.status} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Creates a snippet, queues these findings as the model's answer, and runs a review to completion.
export async function reviewedSnippet(findings: unknown[], snippet: Partial<SnippetInput> = {}) {
  const created = await createSnippet(snippet);
  fakeProvider.respondWith({ findings });
  const started = await startReview(created.id);
  const review = await waitForReview(started.id);
  return { snippet: created, review };
}

export function finding(overrides: Record<string, unknown> = {}) {
  return {
    lineStart: 1,
    lineEnd: 1,
    severity: 'warning',
    category: 'bug',
    description: 'Something is wrong here',
    suggestedFix: 'Fix it',
    ...overrides,
  };
}

// Polls GET /reviews/:id until `until` holds for the review, and returns that review. For looking
// at a review mid-run (rule findings while the model is still answering, say).
export async function pollReview(
  reviewId: number,
  until: (review: any) => boolean,
  { timeoutMs = 10_000, intervalMs = 20 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api().get(`${V1}/reviews/${reviewId}`);
    if (res.status !== 200) throw new Error(`GET /reviews/${reviewId} returned ${res.status}`);
    if (until(res.body.data)) return res.body.data;
    if (Date.now() > deadline) {
      throw new Error(`Review ${reviewId} never reached the expected state: ${JSON.stringify(res.body.data)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
