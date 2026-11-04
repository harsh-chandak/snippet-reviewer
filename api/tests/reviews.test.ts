import { describe, expect, it } from 'vitest';
import { UniqueConstraintError } from 'sequelize';
import { Review, Snippet } from '../src/model/schema';
import { reviewService } from '../src/service/reviewService';
import {
  api,
  createSnippet,
  db,
  fakeProvider,
  finding,
  getSnippet,
  startReview,
  useTestDatabase,
  V1,
  waitForReview,
} from './helpers';

useTestDatabase();

const FIVE_LINES = ['const a = 1;', 'const b = 2;', 'let c;', 'c = a + b;', 'console.log(c);'].join('\n');

describe('POST /snippets/:id/reviews', () => {
  it('answers 202 at once with a pending review, and the snippet shows in_progress', async () => {
    const snippet = await createSnippet();
    // Hold the fake model's answer back, so the review is still active when we look.
    fakeProvider.respondWith({ findings: [] }, { delayMs: 300 });

    const res = await api().post(`${V1}/snippets/${snippet.id}/reviews`);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, message: 'Review started' });
    expect(res.body.data).toMatchObject({ id: expect.any(Number), snippetId: snippet.id, status: 'pending', provider: 'fake' });

    const during = await getSnippet(snippet.id);
    expect(during.reviewStatus).toBe('in_progress');
    expect(['pending', 'running']).toContain(during.latestReview.status);
    expect(during.latestReview.id).toBe(res.body.data.id);

    const list = await api().get(`${V1}/snippets`).query({ status: 'in_progress' });
    expect(list.body.data.items.map((s: any) => s.id)).toEqual([snippet.id]);

    await waitForReview(res.body.data.id);
  });

  it('reaches done, the snippet becomes reviewed, and findings come back ordered by line', async () => {
    const snippet = await createSnippet({ code: FIVE_LINES });
    fakeProvider.respondWith({
      findings: [
        finding({ lineStart: 4, lineEnd: 5, severity: 'info', category: 'style', description: 'Log at the end' }),
        finding({ lineStart: 1, lineEnd: 1, severity: 'critical', category: 'security', description: 'First line' }),
        finding({ lineStart: 3, lineEnd: 3, category: 'bug', description: 'Uninitialised', suggestedFix: undefined }),
      ],
    });

    const started = await startReview(snippet.id);
    const review = await waitForReview(started.id);

    expect(review).toMatchObject({ id: started.id, status: 'done', error: null, rejectedCount: 0 });
    expect(review.completedAt).not.toBeNull();
    expect(review.findings.map((f: any) => [f.lineStart, f.lineEnd])).toEqual([
      [1, 1],
      [3, 3],
      [4, 5],
    ]);
    expect(review.findings[0]).toMatchObject({
      severity: 'critical',
      category: 'security',
      description: 'First line',
      suggestedFix: 'Fix it',
      status: 'open',
    });
    expect(review.findings[1].suggestedFix).toBeNull();

    const after = await getSnippet(snippet.id);
    expect(after.reviewStatus).toBe('reviewed');
    expect(after.latestReview.findings.map((f: any) => f.lineStart)).toEqual([1, 3, 4]);
  });

  it('reaches done with no findings when the model finds nothing', async () => {
    const snippet = await createSnippet();
    fakeProvider.respondWith({ findings: [] });

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review).toMatchObject({ status: 'done', rejectedCount: 0, findings: [] });
    expect((await getSnippet(snippet.id)).reviewStatus).toBe('reviewed');
  });

  it('keeps a finding whose optional suggestedFix is null', async () => {
    const snippet = await createSnippet({ code: FIVE_LINES });
    fakeProvider.respondWith({ findings: [finding({ lineStart: 2, lineEnd: 2, suggestedFix: null })] });

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review.rejectedCount).toBe(0);
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0].suggestedFix).toBeNull();
  });

  it('a review whose every finding is rejected is done with zero findings and the rejected count', async () => {
    const snippet = await createSnippet({ code: FIVE_LINES });
    fakeProvider.respondWith({ findings: [finding({ severity: 'error' }), finding({ lineStart: 99, lineEnd: 99 })] });

    const review = await waitForReview((await startReview(snippet.id)).id);

    // The page reads exactly this shape to say "this review couldn't be used", never "no issues found".
    expect(review).toMatchObject({ status: 'done', rejectedCount: 2, findings: [] });
  });

  it('a review moved on by something else cannot overwrite it, the newer review or the snippet', async () => {
    const snippet = await createSnippet({ code: FIVE_LINES });
    // The first review's model answer arrives late, after a restart elsewhere failed it and a new review finished.
    fakeProvider.respondWith({ findings: [finding({ description: 'late answer' })] }, { delayMs: 1500 });
    const first = await startReview(snippet.id);
    await expect.poll(async () => (await Review.findByPk(first.id))?.status, { timeout: 5000 }).toBe('running');

    await reviewService.failInterrupted();
    fakeProvider.respondWith({ findings: [finding({ description: 'second review' })] });
    const second = await waitForReview((await startReview(snippet.id)).id);
    expect(second.status).toBe('done');

    await new Promise((r) => setTimeout(r, 2000));
    const late = await Review.findByPk(first.id, { include: ['findings'] });
    expect(late?.status).toBe('failed');
    expect(late?.findings).toHaveLength(0);
    const after = await getSnippet(snippet.id);
    expect(after.reviewStatus).toBe('reviewed');
    expect(after.latestReview.id).toBe(second.id);
    expect(after.latestReview.findings.map((f: { description: string }) => f.description)).toEqual(['second review']);
  });

  it('keeps at most 100 findings and drops oversized descriptions', async () => {
    const snippet = await createSnippet({ code: FIVE_LINES });
    const many = Array.from({ length: 150 }, (_, i) => finding({ description: `finding ${i}` }));
    many.push(finding({ description: 'x'.repeat(2001) }));
    fakeProvider.respondWith({ findings: many });

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review.findings).toHaveLength(100);
    expect(review.rejectedCount).toBe(51);
  });

  it('stores a provider error as short, clean text', async () => {
    const snippet = await createSnippet();
    fakeProvider.failWith(`\u001b[31mboom\u001b[0m\n\t${'x'.repeat(5000)}`);

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review.status).toBe('failed');
    expect(review.error.length).toBeLessThanOrEqual(500);
    expect(review.error.startsWith('boom x')).toBe(true);
    expect(review.error).not.toMatch(/[\u0000-\u001f]/);
  });

  it('drops findings past the last line and invalid ones, and counts them in rejectedCount', async () => {
    const snippet = await createSnippet({ code: 'a\nb\nc' });
    fakeProvider.respondWith({
      findings: [
        finding({ lineStart: 2, lineEnd: 2, description: 'kept' }),
        finding({ lineStart: 3, lineEnd: 4, description: 'ends past line 3' }),
        finding({ lineStart: 9, lineEnd: 9, description: 'starts past line 3' }),
        finding({ severity: 'urgent', description: 'severity not in the enum' }),
        finding({ category: 'vibes', description: 'category not in the enum' }),
        finding({ lineStart: 3, lineEnd: 2, description: 'ends before it starts' }),
        finding({ lineStart: 0, lineEnd: 1, description: 'line 0' }),
        finding({ description: '   ' }),
        'not even an object',
      ],
    });

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review.status).toBe('done');
    expect(review.rejectedCount).toBe(8);
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toMatchObject({ lineStart: 2, lineEnd: 2, description: 'kept' });
  });

  it('sends the model the code with every line numbered', async () => {
    const snippet = await createSnippet({ language: 'python', code: 'x = 1\n\nprint(x)' });

    await waitForReview((await startReview(snippet.id)).id);

    expect(fakeProvider.callCount).toBe(1);
    expect(fakeProvider.lastInput?.prompt).toContain('python');
    expect(fakeProvider.lastInput?.prompt).toContain('1: x = 1\n2: \n3: print(x)');
  });

  it('a final newline adds no numbered line, so a finding on it is dropped', async () => {
    const snippet = await createSnippet({ language: 'python', code: 'x = 1\nprint(x)\n' });
    fakeProvider.respondWith({ findings: [finding({ lineStart: 2, lineEnd: 2 }), finding({ lineStart: 3, lineEnd: 3 })] });

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(fakeProvider.lastInput?.prompt).toContain('1: x = 1\n2: print(x)\n</snippet>');
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toMatchObject({ lineStart: 2 });
    expect(review.rejectedCount).toBe(1);
  });

  it('a provider failure leaves the review failed with the LlmError message and the snippet failed', async () => {
    const snippet = await createSnippet();
    fakeProvider.failWith('The review timed out after 120s');

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review).toMatchObject({ status: 'failed', error: 'The review timed out after 120s', findings: [] });
    expect(review.completedAt).not.toBeNull();
    const after = await getSnippet(snippet.id);
    expect(after.reviewStatus).toBe('failed');
    expect(after.latestReview).toMatchObject({ id: review.id, status: 'failed', error: 'The review timed out after 120s' });
  });

  it('fails the review when the model answers without a findings list', async () => {
    const snippet = await createSnippet();
    fakeProvider.respondWith({ notFindings: true });

    const review = await waitForReview((await startReview(snippet.id)).id);

    expect(review.status).toBe('failed');
    expect(review.error).toBe('The model returned an answer without a findings list');
    expect((await getSnippet(snippet.id)).reviewStatus).toBe('failed');
  });

  it('answers 409 to a second start while the first is still running, and keeps only the first', async () => {
    const snippet = await createSnippet();
    fakeProvider.respondWith({ findings: [finding()] }, { delayMs: 500 });

    const first = await startReview(snippet.id);
    const second = await api().post(`${V1}/snippets/${snippet.id}/reviews`);

    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      message: 'A review is already in progress for this snippet',
      data: null,
      success: false,
    });

    const during = await getSnippet(snippet.id);
    expect(during.reviewStatus).toBe('in_progress');
    expect(during.latestReview.id).toBe(first.id);

    const done = await waitForReview(first.id);
    expect(done.status).toBe('done');
    expect(fakeProvider.callCount).toBe(1);
    const [rows] = await db.query('SELECT id FROM reviews');
    expect(rows).toEqual([{ id: first.id }]);
  });

  it('lets exactly one of two simultaneous starts through (202 and 409), settled by the database', async () => {
    const snippet = await createSnippet();
    fakeProvider.respondWith({ findings: [] }, { delayMs: 300 });

    const results = await Promise.all([
      api().post(`${V1}/snippets/${snippet.id}/reviews`),
      api().post(`${V1}/snippets/${snippet.id}/reviews`),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    const winner = results.find((r) => r.status === 202)!;
    await waitForReview(winner.body.data.id);
    const [rows] = await db.query('SELECT count(*)::int AS n FROM reviews');
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('after a review finishes a new one can start, and the snippet returns the latest', async () => {
    const snippet = await createSnippet({ code: FIVE_LINES });
    fakeProvider.respondWith({ findings: [finding({ lineStart: 1, lineEnd: 1, description: 'old' })] });
    const first = await waitForReview((await startReview(snippet.id)).id);

    fakeProvider.respondWith({ findings: [finding({ lineStart: 5, lineEnd: 5, description: 'new' })] });
    const res = await api().post(`${V1}/snippets/${snippet.id}/reviews`);
    expect(res.status).toBe(202);
    expect(res.body.data.id).not.toBe(first.id);
    const second = await waitForReview(res.body.data.id);

    const after = await getSnippet(snippet.id);
    expect(after.latestReview.id).toBe(second.id);
    expect(after.latestReview.findings.map((f: any) => f.description)).toEqual(['new']);

    // The earlier run is kept, with its own findings.
    const old = await api().get(`${V1}/reviews/${first.id}`);
    expect(old.status).toBe(200);
    expect(old.body.data.findings.map((f: any) => f.description)).toEqual(['old']);
  });

  it('after a failed review a new one can start and succeed', async () => {
    const snippet = await createSnippet();
    fakeProvider.failWith('Could not reach the Anthropic API');
    const failed = await waitForReview((await startReview(snippet.id)).id);
    expect(failed.status).toBe('failed');

    fakeProvider.respondWith({ findings: [finding()] });
    const retried = await waitForReview((await startReview(snippet.id)).id);

    expect(retried.status).toBe('done');
    const after = await getSnippet(snippet.id);
    expect(after.reviewStatus).toBe('reviewed');
    expect(after.latestReview.id).toBe(retried.id);
  });

  it('answers 404 for a snippet that does not exist', async () => {
    const res = await api().post(`${V1}/snippets/999999/reviews`);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Snippet not found');
    expect(fakeProvider.callCount).toBe(0);
  });

  it('answers 400 for a non-numeric snippet id', async () => {
    const res = await api().post(`${V1}/snippets/abc/reviews`);
    expect(res.status).toBe(400);
    expect(res.body.data).toHaveProperty('id');
  });
});

describe('GET /reviews/:id', () => {
  it('answers 404 for a review that does not exist', async () => {
    const res = await api().get(`${V1}/reviews/999999`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Review not found', data: null, success: false });
  });

  it('answers 400 for a non-numeric id', async () => {
    const res = await api().get(`${V1}/reviews/latest`);
    expect(res.status).toBe(400);
    expect(res.body.data).toHaveProperty('id');
  });
});

describe('reviewService.failInterrupted (runs at startup)', () => {
  it('marks pending and running reviews failed with the restart message, and their snippets failed', async () => {
    const pendingSnippet = await createSnippet({ title: 'pending' });
    const runningSnippet = await createSnippet({ title: 'running' });
    const doneSnippet = await createSnippet({ title: 'done' });

    // Rows as a crashed process would have left them: no background run exists for these.
    const pending = await Review.create({ snippetId: pendingSnippet.id, provider: 'fake', status: 'pending' });
    const running = await Review.create({
      snippetId: runningSnippet.id,
      provider: 'fake',
      status: 'running',
      startedAt: new Date(),
    });
    const done = await Review.create({ snippetId: doneSnippet.id, provider: 'fake', status: 'done', completedAt: new Date() });
    await Snippet.update({ reviewStatus: 'in_progress' }, { where: { id: [pendingSnippet.id, runningSnippet.id] } });
    await Snippet.update({ reviewStatus: 'reviewed' }, { where: { id: doneSnippet.id } });

    const count = await reviewService.failInterrupted();
    expect(count).toBe(2);

    const restartMessage = 'The server restarted before this review finished. Run it again.';
    for (const [review, snippet] of [
      [pending, pendingSnippet],
      [running, runningSnippet],
    ] as const) {
      const res = await api().get(`${V1}/reviews/${review.id}`);
      expect(res.body.data).toMatchObject({ status: 'failed', error: restartMessage });
      expect(res.body.data.completedAt).not.toBeNull();
      expect((await getSnippet(snippet.id)).reviewStatus).toBe('failed');
    }

    const untouched = await api().get(`${V1}/reviews/${done.id}`);
    expect(untouched.body.data).toMatchObject({ status: 'done', error: null });
    expect((await getSnippet(doneSnippet.id)).reviewStatus).toBe('reviewed');

    // The snippet is free to be reviewed again.
    const again = await api().post(`${V1}/snippets/${pendingSnippet.id}/reviews`);
    expect(again.status).toBe(202);
    await waitForReview(again.body.data.id);
  });

  it('does nothing and returns 0 when no review is active', async () => {
    const snippet = await createSnippet();
    await waitForReview((await startReview(snippet.id)).id);

    expect(await reviewService.failInterrupted()).toBe(0);
    expect((await getSnippet(snippet.id)).reviewStatus).toBe('reviewed');
  });
});

describe('database constraints', () => {
  it('refuses a raw insert of a second pending review for the same snippet (one_active_review_per_snippet)', async () => {
    const snippet = await createSnippet();
    const insert = (status: string) =>
      db.query(
        `INSERT INTO reviews ("snippetId", status, provider, "createdAt", "updatedAt") VALUES (:id, :status, 'fake', now(), now())`,
        { replacements: { id: snippet.id, status } },
      );

    // Finished reviews don't count: any number of them may sit beside one active review.
    await insert('done');
    await insert('failed');
    await insert('pending');

    const second = await insert('pending').then(
      () => null,
      (err) => err,
    );
    expect(second).toBeInstanceOf(UniqueConstraintError);
    expect(second.original.constraint).toBe('one_active_review_per_snippet');

    const running = await insert('running').then(
      () => null,
      (err) => err,
    );
    expect(running).toBeInstanceOf(UniqueConstraintError);
    expect(running.original.constraint).toBe('one_active_review_per_snippet');

    // Leave no active row behind for the after-each check.
    await db.query(`UPDATE reviews SET status = 'failed' WHERE status = 'pending'`);
  });

  it('refuses a review status outside the enum', async () => {
    const snippet = await createSnippet();
    const err = await db
      .query(
        `INSERT INTO reviews ("snippetId", status, provider, "createdAt", "updatedAt") VALUES (:id, 'queued', 'fake', now(), now())`,
        { replacements: { id: snippet.id } },
      )
      .then(
        () => null,
        (e) => e,
      );
    expect(err?.original?.constraint).toBe('reviews_status_check');
  });
});
