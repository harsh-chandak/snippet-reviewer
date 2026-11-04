import { describe, expect, it } from 'vitest';
import { CONTEXT_FOCUS } from '../src/service/llm/prompt';
import {
  api,
  createSnippet,
  fakeProvider,
  finding,
  getSnippet,
  pollReview,
  startReview,
  useTestDatabase,
  V1,
  waitForReview,
} from './helpers';

useTestDatabase();

// The whole review pipeline through the HTTP API: static -> model -> checking -> done, with the
// fake model. Each snippet below is chosen for what the static rules find in it (probed against
// the real analyzers, not mocked).

// js/loose-equality on line 2, with a mechanical fix to `  return x === 0;`. Detected context: unknown.
const LOOSE_EQUALITY = 'function isZero(x) {\n  return x == 0;\n}';
// Detected as test code ("calls it()", "calls expect()"); js/focused-test fires on line 1 only in a test context.
const FOCUSED_TEST = "it.only('adds', () => {\n  expect(1 + 1).toBe(2);\n});";
// Go has no analyzer: only the language-agnostic rules run.
const GO_PLAIN = 'package main\n\nfunc main() {\n\tprintln("hi")\n}';
const GO_SECRET = 'package main\n\nfunc main() {\n\tpassword := "hunter2-real"\n\tprintln(password)\n}';

const byDescription = (review: any, description: string) => review.findings.find((f: any) => f.description === description);
const ruleFindings = (review: any) => review.findings.filter((f: any) => f.source === 'rule');
const modelFindings = (review: any) => review.findings.filter((f: any) => f.source === 'model');

describe('static phase', () => {
  it('saves rule findings when the static phase ends, visible through GET /reviews/:id while the model is still answering', async () => {
    const snippet = await createSnippet({ code: LOOSE_EQUALITY });
    fakeProvider.respondWith({ findings: [] }, { delayMs: 800 });

    const started = await startReview(snippet.id);
    expect(started).toMatchObject({ status: 'pending', phase: 'queued', phaseTimings: {} });

    // The model has not answered yet: the review is running in its model phase.
    const during = await pollReview(started.id, (r) => r.phase === 'model');
    expect(during.status).toBe('running');
    expect(during).toMatchObject({ context: 'unknown', contextSignals: [], staticSupported: true });
    expect(during.phaseTimings.static).toEqual(expect.any(Number));
    expect(during.phaseTimings.model).toBeUndefined();
    expect(during.findings).toEqual([
      expect.objectContaining({
        source: 'rule',
        ruleId: 'js/loose-equality',
        lineStart: 2,
        lineEnd: 2,
        severity: 'warning',
        category: 'bug',
        status: 'open',
        fix: { lineStart: 2, lineEnd: 2, replacement: '  return x === 0;' },
        // Fixes are checked in the checking phase, after the model.
        fixCheck: 'not_checked',
        fixCheckDetail: null,
      }),
    ]);

    // The snippet page reads the same rule findings from the latest review.
    const page = await getSnippet(snippet.id);
    expect(page.reviewStatus).toBe('in_progress');
    expect(page.latestReview.findings.map((f: any) => f.ruleId)).toEqual(['js/loose-equality']);

    const done = await waitForReview(started.id);
    expect(done).toMatchObject({ status: 'done', phase: 'done' });
    expect(done.phaseTimings).toEqual({
      static: expect.any(Number),
      model: expect.any(Number),
      checking: expect.any(Number),
    });
    expect(done.phaseTimings.model).toBeGreaterThanOrEqual(700);
    expect(done.findings).toHaveLength(1);
    expect(done.findings[0].id).toBe(during.findings[0].id);
  });

  it('a rule finding whose fix clears its rule is passed', async () => {
    const snippet = await createSnippet({ code: LOOSE_EQUALITY });

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toMatchObject({
      source: 'rule',
      ruleId: 'js/loose-equality',
      fixCheck: 'passed',
      fixCheckDetail: { parses: true, ruleCleared: true, newRuleIds: [], note: expect.stringContaining('no longer fires') },
    });
  });

  it.each([
    ['python', 'try:\n    run()\nexcept:\n    pass', 'py/bare-except', { lineStart: 3, lineEnd: 3, replacement: 'except Exception:' }],
    ['python', 'if x == None:\n    y = 1', 'py/none-comparison', { lineStart: 1, lineEnd: 1, replacement: 'if x is None:' }],
    [
      'sql',
      'SELECT id FROM users WHERE deleted_at = NULL;',
      'sql/equals-null',
      { lineStart: 1, lineEnd: 1, replacement: 'SELECT id FROM users WHERE deleted_at IS NULL;' },
    ],
  ])('%s: %s is found, saved with its mechanical fix, and the fix is passed', async (language, code, ruleId, fix) => {
    const snippet = await createSnippet({ language, code });

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review).toMatchObject({ status: 'done', staticSupported: true });
    expect(review.findings).toEqual([
      expect.objectContaining({
        source: 'rule',
        ruleId,
        fix,
        fixCheck: 'passed',
        fixCheckDetail: expect.objectContaining({ parses: true, ruleCleared: true, newRuleIds: [] }),
      }),
    ]);
  });

  it('a snippet that does not parse gets one syntax-error finding, and the model still runs', async () => {
    const snippet = await createSnippet({ code: 'function f( {' });
    fakeProvider.respondWith({ findings: [finding({ category: 'style', description: 'model one' })] });

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review.status).toBe('done');
    expect(ruleFindings(review)).toEqual([
      expect.objectContaining({ ruleId: 'js/syntax-error', lineStart: 1, severity: 'critical', category: 'bug' }),
    ]);
    expect(modelFindings(review).map((f: any) => f.description)).toEqual(['model one']);
    expect(fakeProvider.lastInput?.prompt).toContain('js/syntax-error');
  });
});

describe('model phase', () => {
  it('gives the model the context, its signals, the outline and the rule findings as already reported', async () => {
    const snippet = await createSnippet({ code: LOOSE_EQUALITY });

    await waitForReview((await startReview(snippet.id)).id);

    const prompt = fakeProvider.lastInput?.prompt ?? '';
    expect(prompt).toContain('Context: unknown.');
    expect(prompt).toContain(CONTEXT_FOCUS.unknown);
    expect(prompt).toContain('- function isZero, lines 1-3');
    expect(prompt).toMatch(/<already_reported>\n- line 2 \[bug, js\/loose-equality\]: /);
  });

  it('drops a model finding on the same line and category as a rule finding, and counts it as a duplicate, not a rejection', async () => {
    const snippet = await createSnippet({ code: LOOSE_EQUALITY });
    fakeProvider.respondWith({
      findings: [
        finding({ lineStart: 2, lineEnd: 2, category: 'bug', description: 'same as the rule' }),
        finding({ lineStart: 2, lineEnd: 2, category: 'style', description: 'same line, other category' }),
        finding({ lineStart: 1, lineEnd: 1, category: 'bug', description: 'other line, same category' }),
        finding({ severity: 'urgent', description: 'invalid' }),
      ],
    });

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review).toMatchObject({ status: 'done', duplicateCount: 1, rejectedCount: 1 });
    expect(ruleFindings(review).map((f: any) => f.ruleId)).toEqual(['js/loose-equality']);
    expect(modelFindings(review).map((f: any) => f.description).sort()).toEqual([
      'other line, same category',
      'same line, other category',
    ]);
    for (const f of modelFindings(review)) expect(f).toMatchObject({ ruleId: null, fix: null, fixCheck: 'not_checked' });
  });

  it('a model failure fails the review but keeps the rule findings', async () => {
    const snippet = await createSnippet({ code: LOOSE_EQUALITY });
    fakeProvider.failWith('The review timed out after 120s');

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review).toMatchObject({ status: 'failed', phase: 'failed', error: 'The review timed out after 120s' });
    // PIPE-3: the row says which phase failed, so the page doesn't infer it from missing timings.
    expect(review.phaseTimings).toEqual({ static: expect.any(Number), model: expect.any(Number), failedPhase: 'model' });
    expect(review.findings).toEqual([
      expect.objectContaining({ source: 'rule', ruleId: 'js/loose-equality', fixCheck: 'not_checked' }),
    ]);
    const page = await getSnippet(snippet.id);
    expect(page.reviewStatus).toBe('failed');
    expect(page.latestReview.findings.map((f: any) => f.ruleId)).toEqual(['js/loose-equality']);
  });

  it('saves the usage the provider reports', async () => {
    const snippet = await createSnippet({ code: LOOSE_EQUALITY });
    fakeProvider.respondWith(
      { findings: [] },
      {
        usage: {
          model: 'claude-test-model',
          inputTokens: 1200,
          outputTokens: 340,
          cacheReadTokens: 50,
          cacheWriteTokens: 7,
          costUsd: 0.0123,
          costSource: 'cli',
        },
      },
    );

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review).toMatchObject({
      model: 'claude-test-model',
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 50,
      cacheWriteTokens: 7,
      costUsd: 0.0123,
      costSource: 'cli',
    });
  });

  it('saves zero tokens and no cost by default, and nothing when the provider reports no usage', async () => {
    const snippet = await createSnippet();
    const first = await waitForReview((await startReview(snippet.id)).id);
    expect(first).toMatchObject({
      model: 'fake',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      costSource: null,
    });

    fakeProvider.respondWith({ findings: [] }, { usage: null });
    const second = await waitForReview((await startReview(snippet.id)).id);
    expect(second).toMatchObject({ model: null, inputTokens: null, outputTokens: null, costUsd: null, costSource: null });
  });
});

describe('checking phase', () => {
  it('applies model fix locality in a live review: a fix far from its finding is failed, naming the lines it touches', async () => {
    // 15 lines; the finding is on line 1, the fix rewrites line 15 only (no overlap).
    const code = ['function isZero(x) {', '  return x === 0;', ...Array.from({ length: 12 }, (_, i) => `// ${i}`), '}'].join('\n');
    const snippet = await createSnippet({ code });
    fakeProvider.respondWith({
      findings: [
        finding({
          lineStart: 1,
          lineEnd: 1,
          category: 'style',
          description: 'far fix',
          fix: { lineStart: 15, lineEnd: 15, replacement: '};' },
        }),
        finding({
          lineStart: 15,
          lineEnd: 15,
          category: 'style',
          description: 'near fix',
          fix: { lineStart: 15, lineEnd: 15, replacement: '};' },
        }),
      ],
    });

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review.status).toBe('done');
    const far = byDescription(review, 'far fix');
    expect(far).toMatchObject({ source: 'model', fixCheck: 'failed' });
    expect(far.fixCheckDetail.note).toContain('15');
    expect(byDescription(review, 'near fix')).toMatchObject({ fixCheck: 'passed' });
  });

  it('fails a model fix that rewrites lines away from its finding (model fix locality)', async () => {
    const snippet = await createSnippet({ code: LOOSE_EQUALITY });
    fakeProvider.respondWith({
      findings: [
        finding({
          lineStart: 3,
          lineEnd: 3,
          category: 'style',
          description: 'strays from its line',
          fix: { lineStart: 1, lineEnd: 1, replacement: 'function isZero(x) {' },
        }),
      ],
    });

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(byDescription(review, 'strays from its line')).toMatchObject({ source: 'model', fixCheck: 'failed' });
  });

  it('checks every model fix: a fix that does not parse or adds a rule is failed, a clean one passed, none not_checked', async () => {
    const snippet = await createSnippet({ code: LOOSE_EQUALITY });
    fakeProvider.respondWith({
      findings: [
        finding({
          lineStart: 1,
          lineEnd: 1,
          category: 'style',
          description: 'breaks the syntax',
          fix: { lineStart: 1, lineEnd: 1, replacement: 'function isZero(x {' },
        }),
        finding({
          lineStart: 1,
          lineEnd: 1,
          category: 'security',
          description: 'adds an eval',
          fix: { lineStart: 1, lineEnd: 1, replacement: 'function isZero(x) { eval("1");' },
        }),
        finding({
          lineStart: 3,
          lineEnd: 3,
          category: 'style',
          description: 'clean fix',
          fix: { lineStart: 3, lineEnd: 3, replacement: '};' },
        }),
        finding({ lineStart: 1, lineEnd: 1, category: 'performance', description: 'no fix' }),
      ],
    });

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review.status).toBe('done');
    expect(byDescription(review, 'breaks the syntax')).toMatchObject({
      source: 'model',
      fixCheck: 'failed',
      fixCheckDetail: { parses: false, ruleCleared: null, newRuleIds: expect.any(Array) },
    });
    expect(byDescription(review, 'adds an eval')).toMatchObject({
      fixCheck: 'failed',
      fixCheckDetail: { parses: true, ruleCleared: null, newRuleIds: ['js/eval'] },
    });
    expect(byDescription(review, 'clean fix')).toMatchObject({
      fix: { lineStart: 3, lineEnd: 3, replacement: '};' },
      fixCheck: 'passed',
      fixCheckDetail: { parses: true, ruleCleared: null, newRuleIds: [] },
    });
    expect(byDescription(review, 'no fix')).toMatchObject({ fix: null, fixCheck: 'not_checked', fixCheckDetail: null });
    // The rule finding's own fix is checked in the same phase.
    expect(ruleFindings(review)[0]).toMatchObject({ ruleId: 'js/loose-equality', fixCheck: 'passed' });
  });
});

describe('context', () => {
  it('uses the detected context and its signals when the user set none', async () => {
    const snippet = await createSnippet({ code: FOCUSED_TEST });
    expect(snippet.context).toBeNull();

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review).toMatchObject({ context: 'test', contextSignals: ['calls it()', 'calls expect()'] });
    expect(ruleFindings(review).map((f: any) => f.ruleId)).toEqual(['js/focused-test']);
    expect(fakeProvider.lastInput?.prompt).toContain('Context: test (signals: calls it(); calls expect()).');
    expect(fakeProvider.lastInput?.prompt).toContain(CONTEXT_FOCUS.test);
  });

  it("a user context adds its rules to the detected context's, and keeps the detected signals", async () => {
    const snippet = await createSnippet({ code: FOCUSED_TEST, context: 'backend' });
    expect(snippet.context).toBe('backend');

    const review = await waitForReview((await startReview(snippet.id)).id);

    // The choice is on the snippet; the review keeps what detection saw.
    expect(review).toMatchObject({ status: 'done', context: 'backend', contextSignals: ['calls it()', 'calls expect()'] });
    // js/focused-test runs for the detected test context even though the user chose backend.
    expect(ruleFindings(review).map((f: any) => f.ruleId)).toEqual(['js/focused-test']);
    expect(fakeProvider.lastInput?.prompt).toContain('Context: backend (signals: calls it(); calls expect()).');
    expect(fakeProvider.lastInput?.prompt).toContain(CONTEXT_FOCUS.backend);
  });

  it('WEB2-4: choosing query for JavaScript with SQL concat still runs js/sql-string-concat', async () => {
    const code = 'function find(req) {\n  return db.query("SELECT * FROM users WHERE id = " + req.query.id);\n}';
    const auto = await waitForReview((await startReview((await createSnippet({ code })).id)).id);
    expect(ruleFindings(auto).map((f: any) => f.ruleId)).toContain('js/sql-string-concat');

    const snippet = await createSnippet({ code, context: 'query' });
    const review = await waitForReview((await startReview(snippet.id)).id);
    expect(review).toMatchObject({ status: 'done', context: 'query', contextSignals: auto.contextSignals });
    expect(auto.contextSignals.length).toBeGreaterThan(0);
    expect(ruleFindings(review).map((f: any) => f.ruleId)).toContain('js/sql-string-concat');
    // One finding per (ruleId, lineStart), not one per context.
    const keys = ruleFindings(review).map((f: any) => `${f.ruleId}:${f.lineStart}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a user context that matches detection keeps the detected signals', async () => {
    const snippet = await createSnippet({ code: FOCUSED_TEST, context: 'test' });

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review).toMatchObject({ context: 'test', contextSignals: ['calls it()', 'calls expect()'] });
  });
});

describe('languages without an analyzer', () => {
  it('are model-only with staticSupported false, and a model fix is not checked', async () => {
    const snippet = await createSnippet({ language: 'go', code: GO_PLAIN });
    fakeProvider.respondWith({
      findings: [
        finding({
          lineStart: 4,
          lineEnd: 4,
          category: 'style',
          description: 'use fmt',
          fix: { lineStart: 4, lineEnd: 4, replacement: '\tfmt.Println("hi")' },
        }),
      ],
    });

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review).toMatchObject({ status: 'done', phase: 'done', staticSupported: false, context: 'unknown', contextSignals: [] });
    expect(review.findings).toEqual([
      expect.objectContaining({
        source: 'model',
        description: 'use fmt',
        fixCheck: 'not_checked',
        fixCheckDetail: expect.objectContaining({ parses: null, ruleCleared: null, newRuleIds: [] }),
      }),
    ]);
    expect(fakeProvider.lastInput?.prompt).toContain('No static analysis findings were reported for this snippet.');
  });

  it('still get the language-agnostic hard-coded secret rule', async () => {
    const snippet = await createSnippet({ language: 'go', code: GO_SECRET });
    fakeProvider.respondWith({ findings: [] }, { delayMs: 300 });

    const started = await startReview(snippet.id);
    const during = await pollReview(started.id, (r) => r.phase === 'model');
    expect(during.findings.map((f: any) => f.ruleId)).toEqual(['any/hardcoded-secret']);

    const review = await waitForReview(started.id);
    expect(review.staticSupported).toBe(false);
    expect(review.findings).toEqual([
      expect.objectContaining({
        source: 'rule',
        ruleId: 'any/hardcoded-secret',
        lineStart: 4,
        lineEnd: 4,
        severity: 'critical',
        category: 'security',
        fix: null,
        fixCheck: 'not_checked',
      }),
    ]);
    // The description names the variable, never the secret.
    expect(review.findings[0].description).toContain('password');
    expect(review.findings[0].description).not.toContain('hunter2-real');
    expect(fakeProvider.lastInput?.prompt).toContain('any/hardcoded-secret');
  });
});

describe('rule findings and the finding API', () => {
  it('a rule finding can be accepted and dismissed like a model finding', async () => {
    const snippet = await createSnippet({ code: LOOSE_EQUALITY });
    const review = await waitForReview((await startReview(snippet.id)).id);
    const rule = ruleFindings(review)[0];

    const accepted = await api().patch(`${V1}/findings/${rule.id}`).send({ status: 'accepted' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({ id: rule.id, source: 'rule', ruleId: 'js/loose-equality', status: 'accepted' });

    const dismissed = await api().patch(`${V1}/findings/${rule.id}`).send({ status: 'dismissed' });
    expect(dismissed.body.data.status).toBe('dismissed');
    expect((await getSnippet(snippet.id)).latestReview.findings[0]).toMatchObject({ id: rule.id, status: 'dismissed' });
  });
});
