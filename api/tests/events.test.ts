import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import { api, createSnippet, db, fakeProvider, finding, startReview, useTestDatabase, V1, waitForReview } from './helpers';
import { MAX_EVENTS_PER_REVIEW, REVIEW_EVENT_TYPES } from '../src/model/constants';
import { CONTEXT_FOCUS, REVIEW_SYSTEM_PROMPT } from '../src/service/llm/prompt';
import { reviewJsonSchema } from '../src/service/llm/reviewSchema';
import { event, rawSuggestion, reviewEventService } from '../src/service/reviewEventService';
import { reviewService } from '../src/service/reviewService';
import {
  allRuleIds,
  computePromptVersion,
  computeRulesetVersion,
  packageVersion,
  PROMPT_VERSION,
  RULESET_VERSION,
} from '../src/service/versions';

useTestDatabase();

// js/loose-equality on line 2, with a mechanical fix to `  return x === 0;`. Detected context: unknown.
const LOOSE_EQUALITY = 'function isZero(x) {\n  return x == 0;\n}';
const PLAIN = 'function sum(a, b) {\n  return a + b;\n}';

const USAGE = {
  model: 'claude-test',
  inputTokens: 2,
  outputTokens: 407,
  cacheReadTokens: 0,
  cacheWriteTokens: 1948,
  costUsd: 0.0089,
  costSource: 'cli' as const,
};

async function eventsOf(reviewId: number) {
  const res = await api().get(`${V1}/reviews/${reviewId}/events`);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ success: true, message: 'Review events' });
  return res.body.data.items as { id: number; reviewId: number; type: string; payload: any; createdAt: string }[];
}

const types = (events: { type: string }[]) => events.map((e) => e.type);
const ofType = (events: { type: string; payload: any }[], type: string) => events.filter((e) => e.type === type);

async function runReview(code: string, findings: unknown[], usage: Record<string, unknown> | null = {}, language = 'javascript') {
  const snippet = await createSnippet({ code, language });
  fakeProvider.respondWith({ findings }, { usage: usage as any });
  const started = await startReview(snippet.id);
  const review = await waitForReview(started.id);
  return { snippet, review };
}

describe('version stamps', () => {
  it('promptVersion is the first 12 hex chars of sha256 over the system prompt, the context focus wording and the findings schema', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify({ system: REVIEW_SYSTEM_PROMPT, contextFocus: CONTEXT_FOCUS, findingsSchema: reviewJsonSchema }))
      .digest('hex')
      .slice(0, 12);
    expect(PROMPT_VERSION).toBe(expected);
    expect(PROMPT_VERSION).toMatch(/^[0-9a-f]{12}$/);
    expect(computePromptVersion()).toBe(PROMPT_VERSION);
  });

  it('rulesetVersion covers every analyzer rule id, sorted, and the parser versions', () => {
    const ids = allRuleIds();
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(
      expect.arrayContaining([
        'js/syntax-error',
        'js/focused-test',
        'py/syntax-error',
        'py/requests-verify-false',
        'sql/syntax-error',
        'sql/drop-or-truncate',
        'any/hardcoded-secret',
      ]),
    );
    expect(ids).toHaveLength(11 + 9 + 9 + 1);

    const parsers = {
      typescript: packageVersion('typescript'),
      'web-tree-sitter': packageVersion('web-tree-sitter'),
      'tree-sitter-python': packageVersion('tree-sitter-python'),
      'node-sql-parser': packageVersion('node-sql-parser'),
    };
    // Pinned in package.json; web-tree-sitter does not export its package.json, so this proves the fallback.
    expect(parsers['web-tree-sitter']).toBe('0.25.10');
    expect(parsers['tree-sitter-python']).toBe('0.25.0');
    expect(parsers['node-sql-parser']).toBe('5.4.0');
    expect(parsers.typescript).toMatch(/^\d+\.\d+\.\d+/);

    const expected = createHash('sha256').update(JSON.stringify({ ruleIds: ids, parsers })).digest('hex').slice(0, 12);
    expect(RULESET_VERSION).toBe(expected);
    expect(computeRulesetVersion()).toBe(RULESET_VERSION);
  });

  it('stamps both on every review, from the start', async () => {
    const snippet = await createSnippet();
    const started = await startReview(snippet.id);
    expect(started).toMatchObject({ promptVersion: PROMPT_VERSION, rulesetVersion: RULESET_VERSION });
    const review = await waitForReview(started.id);
    expect(review).toMatchObject({ promptVersion: PROMPT_VERSION, rulesetVersion: RULESET_VERSION });
  });
});

describe('GET /reviews/:id/events', () => {
  it('logs every step of a review that ends done, in order, with the decided payloads', async () => {
    const kept = finding({
      lineStart: 1,
      lineEnd: 3,
      severity: 'info',
      category: 'style',
      description: 'Name the function after what it checks',
      fix: { lineStart: 1, lineEnd: 1, replacement: 'function isZeroNumber(x) {' },
    });
    const duplicate = finding({ lineStart: 2, lineEnd: 2, category: 'bug', description: 'Loose equality again' });
    const invalid = finding({ severity: 'error', description: 'Bad severity' });
    const { snippet, review } = await runReview(LOOSE_EQUALITY, [kept, duplicate, invalid], USAGE);
    expect(review.status).toBe('done');

    const events = await eventsOf(review.id);
    expect(types(events)).toEqual([
      'review.started',
      'static.parsed',
      'static.rule_hit',
      'model.called',
      'model.finding_rejected',
      'model.duplicate',
      'model.finding_kept',
      'fix.checked',
      'fix.checked',
      'review.done',
    ]);
    expect(events.map((e) => e.id)).toEqual([...events.map((e) => e.id)].sort((a, b) => a - b));
    for (const e of events) expect(e.reviewId).toBe(review.id);

    const [started, parsed, ruleHit, called, rejected, dup, keptEvent, ruleCheck, modelCheck, done] = events;
    expect(started.payload).toEqual({ provider: 'fake' });
    expect(parsed.payload).toEqual({
      supported: true,
      parseOk: true,
      parseError: null,
      context: 'unknown',
      signals: [],
      outlineItems: 1,
      ms: review.phaseTimings.static,
    });
    expect(ruleHit.payload).toEqual({
      ruleId: 'js/loose-equality',
      lineStart: 2,
      lineEnd: 2,
      severity: 'warning',
      category: 'bug',
      hasFix: true,
    });
    expect(called.payload).toEqual({
      provider: 'fake',
      model: 'claude-test',
      promptVersion: PROMPT_VERSION,
      context: 'unknown',
      hintsSent: 1,
      outlineItemsSent: 1,
      promptChars: fakeProvider.lastInput!.prompt.length,
      inputTokens: 2,
      outputTokens: 407,
      cacheReadTokens: 0,
      cacheWriteTokens: 1948,
      totalInputTokens: 1950,
      costUsd: 0.0089,
      costSource: 'cli',
      ms: review.phaseTimings.model,
    });
    expect(rejected.payload.reason).toContain('severity');
    expect(JSON.parse(rejected.payload.raw)).toEqual(invalid);
    expect(dup.payload).toEqual({ lineStart: 2, category: 'bug', ruleId: 'js/loose-equality' });
    expect(keptEvent.payload).toEqual({ lineStart: 1, lineEnd: 3, severity: 'info', category: 'style', hasFix: true });

    const ruleFinding = review.findings.find((f: any) => f.source === 'rule');
    const modelFinding = review.findings.find((f: any) => f.source === 'model');
    expect(ruleCheck.payload).toEqual({
      findingId: ruleFinding.id,
      source: 'rule',
      ruleId: 'js/loose-equality',
      fixCheck: 'passed',
      parses: true,
      ruleCleared: true,
      newRuleIds: [],
    });
    expect(modelCheck.payload).toEqual({
      findingId: modelFinding.id,
      source: 'model',
      ruleId: null,
      fixCheck: modelFinding.fixCheck,
      parses: modelFinding.fixCheckDetail.parses,
      ruleCleared: null,
      newRuleIds: modelFinding.fixCheckDetail.newRuleIds,
    });
    expect(done.payload).toEqual({ ms: expect.any(Number), findings: 2, ruleFindings: 1, modelFindings: 1 });
    expect(done.payload.ms).toBeGreaterThanOrEqual(review.phaseTimings.model);

    // The review's own counts agree with the log.
    expect(review).toMatchObject({ rejectedCount: 1, duplicateCount: 1 });
    // No event stores the snippet's code.
    expect(JSON.stringify(events)).not.toContain('x == 0');
    expect(JSON.stringify(events)).not.toContain(snippet.code);
  });

  it('logs a model call with no usage as nulls, and a model-only language as unsupported', async () => {
    const { review } = await runReview('package main\n\nfunc main() {}', [], null, 'go');
    const events = await eventsOf(review.id);
    expect(types(events)).toEqual(['review.started', 'static.parsed', 'model.called', 'review.done']);
    expect(events[1].payload).toMatchObject({ supported: false, parseOk: true, context: 'unknown', outlineItems: 0 });
    expect(events[2].payload).toMatchObject({
      model: null,
      inputTokens: null,
      totalInputTokens: null,
      costUsd: null,
      costSource: null,
      hintsSent: 0,
    });
    expect(events[3].payload).toMatchObject({ findings: 0, ruleFindings: 0, modelFindings: 0 });
  });

  it('logs a failed model call, then the failed review with its phase; rule hits already saved stay', async () => {
    const snippet = await createSnippet({ code: LOOSE_EQUALITY });
    fakeProvider.failWith('The review timed out after 120 s');
    const started = await startReview(snippet.id);
    const review = await waitForReview(started.id);
    expect(review.status).toBe('failed');

    const events = await eventsOf(review.id);
    expect(types(events)).toEqual(['review.started', 'static.parsed', 'static.rule_hit', 'model.failed', 'review.failed']);
    expect(events[3].payload).toEqual({ message: review.error, ms: expect.any(Number) });
    expect(events[4].payload).toEqual({ phase: 'model', message: review.error, ms: expect.any(Number) });
  });

  it('logs a model answer without a findings list as a failed model step', async () => {
    const snippet = await createSnippet();
    fakeProvider.respondWith({ nothing: true });
    const started = await startReview(snippet.id);
    const review = await waitForReview(started.id);
    expect(review.status).toBe('failed');
    const events = await eventsOf(review.id);
    expect(types(events).slice(-2)).toEqual(['model.failed', 'review.failed']);
    expect(events.at(-1)!.payload.phase).toBe('model');
  });

  it('returns an empty list for a review with no events, 404 for a missing review and 400 for a bad id', async () => {
    const snippet = await createSnippet();
    await db.query(
      `INSERT INTO reviews ("snippetId", provider, status, phase, "createdAt", "updatedAt") VALUES (:id, 'fake', 'done', 'done', now(), now())`,
      { replacements: { id: snippet.id } },
    );
    const [{ id }] = await db.query<{ id: number }>('SELECT max(id)::int AS id FROM reviews', { type: QueryTypes.SELECT });
    expect(await eventsOf(id)).toEqual([]);

    const missing = await api().get(`${V1}/reviews/999999/events`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ success: false, message: 'Review not found' });

    const bad = await api().get(`${V1}/reviews/abc/events`);
    expect(bad.status).toBe(400);
  });
});

describe('finding.resolved', () => {
  it('logs each accept, dismiss and reopen with from and to; setting the same status again logs nothing', async () => {
    const { review } = await runReview(PLAIN, [finding({ description: 'one' })]);
    const [f] = review.findings;
    const patch = (status: string) => api().patch(`${V1}/findings/${f.id}`).send({ status });

    expect((await patch('accepted')).status).toBe(200);
    expect((await patch('accepted')).status).toBe(200);
    expect((await patch('dismissed')).status).toBe(200);
    expect((await patch('open')).status).toBe(200);

    const resolved = ofType(await eventsOf(review.id), 'finding.resolved');
    expect(resolved.map((e) => e.payload)).toEqual([
      { findingId: f.id, reviewId: review.id, from: 'open', to: 'accepted' },
      { findingId: f.id, reviewId: review.id, from: 'accepted', to: 'dismissed' },
      { findingId: f.id, reviewId: review.id, from: 'dismissed', to: 'open' },
    ]);
  });

  it('logs nothing for a missing finding', async () => {
    const res = await api().patch(`${V1}/findings/999999`).send({ status: 'accepted' });
    expect(res.status).toBe(404);
    const [{ n }] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM review_events', { type: QueryTypes.SELECT });
    expect(n).toBe(0);
  });
});

describe('event size limits', () => {
  it('a flood of rejected suggestions stops at 500 events, keeps the lifecycle events and counts what it dropped', async () => {
    const flood = Array.from({ length: 600 }, (_, i) => finding({ severity: 'error', description: `bad ${i}` }));
    const { review } = await runReview(PLAIN, flood);
    expect(review.status).toBe('done');
    expect(review.rejectedCount).toBe(600);

    const events = await eventsOf(review.id);
    expect(events).toHaveLength(MAX_EVENTS_PER_REVIEW);
    const rejected = ofType(events, 'model.finding_rejected');
    const truncated = ofType(events, 'events.truncated');
    expect(truncated).toHaveLength(1);
    expect(truncated[0].payload).toEqual({ dropped: 600 - rejected.length });
    for (const type of ['review.started', 'static.parsed', 'model.called', 'review.done']) {
      expect(ofType(events, type), type).toHaveLength(1);
    }
    expect(rejected.length + 4 + 1).toBe(MAX_EVENTS_PER_REVIEW);
    expect(events.at(-1)!.type).toBe('events.truncated');

    // Later events past the limit are dropped; the log never grows past 500 or gets a second truncated event.
    const late = event('finding.resolved', { findingId: 1, reviewId: review.id, from: 'open', to: 'accepted' });
    expect(await db.transaction((t) => reviewEventService.append(review.id, [late], t))).toBe(1);
    const after = await eventsOf(review.id);
    expect(after).toHaveLength(MAX_EVENTS_PER_REVIEW);
    expect(ofType(after, 'events.truncated')).toHaveLength(1);
  });

  it('the writer fills the log to the limit, ending it with one events.truncated', async () => {
    const { review } = await runReview(PLAIN, []);
    const before = (await eventsOf(review.id)).length;
    const batch = Array.from({ length: 600 }, (_, i) =>
      event('finding.resolved', { findingId: i, reviewId: review.id, from: 'open', to: 'accepted' }),
    );
    const dropped = await db.transaction((t) => reviewEventService.append(review.id, batch, t));

    const events = await eventsOf(review.id);
    expect(events).toHaveLength(MAX_EVENTS_PER_REVIEW);
    expect(dropped).toBe(600 - (MAX_EVENTS_PER_REVIEW - before - 1));
    expect(events.at(-1)).toMatchObject({ type: 'events.truncated', payload: { dropped } });
  });

  it('caps a rejected suggestion at 2000 characters of JSON', async () => {
    const huge = finding({ severity: 'error', description: 'x'.repeat(10_000) });
    const { review } = await runReview(PLAIN, [huge]);
    const [rejected] = ofType(await eventsOf(review.id), 'model.finding_rejected');
    expect(rejected.payload.raw).toHaveLength(2000);
    expect(rejected.payload.raw).toBe(JSON.stringify(huge).slice(0, 2000));
  });

  it('stores text Postgres jsonb would refuse (NUL, half an emoji) without failing the step', async () => {
    // Cut so the 2000th character is the first half of an emoji.
    const base = JSON.stringify(finding({ severity: 'error', description: '' }));
    const start = base.indexOf('"description":"') + '"description":"'.length;
    const description = 'y'.repeat(1999 - start) + '\u{1F600}tail';
    const sneaky = finding({ severity: 'error', description });
    expect(rawSuggestion(sneaky)).toHaveLength(1999);

    const { review } = await runReview(PLAIN, [sneaky]);
    expect(review.status).toBe('done');
    const [rejected] = ofType(await eventsOf(review.id), 'model.finding_rejected');
    expect(rejected.payload.raw).toBe(JSON.stringify(sneaky).slice(0, 1999));

    await db.transaction((t) =>
      reviewEventService.append(review.id, [event('model.failed', { message: 'a\u0000b\ud800c', ms: 1 })], t),
    );
    expect(ofType(await eventsOf(review.id), 'model.failed')[0].payload).toEqual({ message: 'abc', ms: 1 });
  });
});

describe('reviews interrupted by a restart', () => {
  it('logs review.failed with the phase the review was in', async () => {
    const snippet = await createSnippet();
    await db.query(
      `INSERT INTO reviews ("snippetId", provider, status, phase, "startedAt", "createdAt", "updatedAt")
       VALUES (:id, 'fake', 'running', 'model', now() - interval '5 seconds', now(), now())`,
      { replacements: { id: snippet.id } },
    );
    const [{ id }] = await db.query<{ id: number }>('SELECT max(id)::int AS id FROM reviews', { type: QueryTypes.SELECT });

    expect(await reviewService.failInterrupted()).toBe(1);
    const events = await eventsOf(id);
    expect(types(events)).toEqual(['review.failed']);
    expect(events[0].payload).toEqual({
      phase: 'model',
      message: 'The server restarted before this review finished. Run it again.',
      ms: expect.any(Number),
    });
    expect(events[0].payload.ms).toBeGreaterThanOrEqual(4000);
  });
});

describe('analytics views over real reviews', () => {
  it('v_rule_feedback, v_review_costs and v_model_rejections read what the pipeline and the user wrote', async () => {
    const { review } = await runReview(LOOSE_EQUALITY, [finding({ severity: 'error' }), finding({ severity: 'error' })], USAGE);
    const rule = review.findings.find((f: any) => f.source === 'rule');
    await api().patch(`${V1}/findings/${rule.id}`).send({ status: 'dismissed' });

    expect(await db.query('SELECT * FROM v_rule_feedback', { type: QueryTypes.SELECT })).toEqual([
      { ruleId: 'js/loose-equality', findings: 1, accepted: 0, dismissed: 1, open: 0, dismiss_rate: 1 },
    ]);
    expect(await db.query('SELECT * FROM v_review_costs', { type: QueryTypes.SELECT })).toEqual([
      {
        reviewId: review.id,
        language: 'javascript',
        context: 'unknown',
        model: 'claude-test',
        promptVersion: PROMPT_VERSION,
        totalInputTokens: 1950,
        outputTokens: 407,
        cacheReadTokens: 0,
        costUsd: 0.0089,
        staticMs: review.phaseTimings.static,
        modelMs: review.phaseTimings.model,
        checkingMs: review.phaseTimings.checking,
      },
    ]);
    const rejections = await db.query<{ reason: string; count: number }>('SELECT * FROM v_model_rejections', {
      type: QueryTypes.SELECT,
    });
    expect(rejections).toHaveLength(1);
    expect(rejections[0].count).toBe(2);
    expect(rejections[0].reason).toContain('severity');
  });
});

describe('event types', () => {
  it('the constants match the CHECK in the database', async () => {
    const [{ def }] = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'review_events_type_check'`,
      { type: QueryTypes.SELECT },
    );
    const inCheck = [...def.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]).sort();
    expect(inCheck).toEqual([...REVIEW_EVENT_TYPES].sort());
  });
});
