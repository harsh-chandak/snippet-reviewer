import { describe, expect, it } from 'vitest';
import {
  api,
  createSnippet,
  fakeProvider,
  finding,
  getSnippet,
  reviewedSnippet,
  startReview,
  useTestDatabase,
  V1,
  waitForReview,
} from './helpers';

useTestDatabase();

describe('POST /snippets', () => {
  it('creates a snippet, answers 201 and returns it as stored', async () => {
    const code = 'def add(a, b):\n    return a + b\n';
    const res = await api().post(`${V1}/snippets`).send({ title: '  Add  ', language: 'python', code });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, message: 'Snippet created' });
    expect(res.body.data).toMatchObject({
      id: expect.any(Number),
      title: 'Add',
      language: 'python',
      code,
      reviewStatus: 'not_reviewed',
    });
    expect(Date.parse(res.body.data.createdAt)).not.toBeNaN();

    // And it is really stored: read it back.
    const stored = await getSnippet(res.body.data.id);
    expect(stored).toMatchObject({ id: res.body.data.id, title: 'Add', language: 'python', code });
  });

  it('answers 400 with a message per field for an empty title, unknown language and blank code', async () => {
    const res = await api().post(`${V1}/snippets`).send({ title: '   ', language: 'cobol', code: '  \n  ' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Validation Error');
    expect(Object.keys(res.body.data).sort()).toEqual(['code', 'language', 'title']);
    expect(res.body.data.title).toEqual(['title is not allowed to be empty']);
    expect(res.body.data.language[0]).toMatch(/^language must be one of \[javascript, typescript, python/);
    expect(res.body.data.code).toEqual(['code is not allowed to be empty']);
  });

  it('answers 400 when required fields are missing', async () => {
    const res = await api().post(`${V1}/snippets`).send({});

    expect(res.status).toBe(400);
    expect(res.body.data).toEqual({
      title: ['title is required'],
      language: ['language is required'],
      code: ['code is required'],
    });
  });

  it('accepts code at the line limit and refuses code one line over it', async () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `x${i}`).join('\n');

    const atLimit = await api().post(`${V1}/snippets`).send({ title: 'Long', language: 'go', code: lines(1000) });
    expect(atLimit.status).toBe(201);

    const over = await api().post(`${V1}/snippets`).send({ title: 'Too long', language: 'go', code: lines(1001) });
    expect(over.status).toBe(400);
    expect(over.body.data).toEqual({ code: ['code must be at most 1000 lines'] });
  });

  it('does not count a final newline as an extra line', async () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `x${i}`).join('\n');

    // 1000 lines saved by an editor end with a newline; that is still 1000 lines.
    const saved = await api().post(`${V1}/snippets`).send({ title: 'Saved file', language: 'go', code: lines(1000) + '\n' });
    expect(saved.status).toBe(201);
  });

  it('accepts code at the character limit and refuses code one character over it', async () => {
    const atLimit = await api().post(`${V1}/snippets`).send({ title: 'Wide', language: 'go', code: 'x'.repeat(20000) });
    expect(atLimit.status).toBe(201);

    const over = await api().post(`${V1}/snippets`).send({ title: 'Too wide', language: 'go', code: 'x'.repeat(20001) });
    expect(over.status).toBe(400);
    expect(over.body.data).toEqual({ code: ['code length must be less than or equal to 20000 characters long'] });
  });

  it('refuses a title over 200 characters', async () => {
    const res = await api().post(`${V1}/snippets`).send({ title: 't'.repeat(201), language: 'go', code: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.data).toHaveProperty('title');
  });

  it('does not store anything when validation fails', async () => {
    await api().post(`${V1}/snippets`).send({ title: '', language: 'python', code: 'x' });
    const list = await api().get(`${V1}/snippets`);
    expect(list.body.data.items).toEqual([]);
  });
});

describe('GET /snippets', () => {
  it('lists newest first and leaves the code out', async () => {
    const a = await createSnippet({ title: 'first' });
    const b = await createSnippet({ title: 'second' });
    const c = await createSnippet({ title: 'third' });

    const res = await api().get(`${V1}/snippets`);

    expect(res.status).toBe(200);
    expect(res.body.data.items.map((s: any) => s.id)).toEqual([c.id, b.id, a.id]);
    expect(res.body.data.nextCursor).toBeNull();
    for (const item of res.body.data.items) {
      expect(item).not.toHaveProperty('code');
      expect(item).toMatchObject({ title: expect.any(String), language: 'javascript', reviewStatus: 'not_reviewed' });
    }
  });

  it('filters by language', async () => {
    const py1 = await createSnippet({ language: 'python' });
    await createSnippet({ language: 'go' });
    const py2 = await createSnippet({ language: 'python' });

    const res = await api().get(`${V1}/snippets`).query({ language: 'python' });

    expect(res.status).toBe(200);
    expect(res.body.data.items.map((s: any) => s.id)).toEqual([py2.id, py1.id]);
  });

  it('filters by review status', async () => {
    const plain = await createSnippet();
    const { snippet: reviewed } = await reviewedSnippet([finding()]);

    const done = await api().get(`${V1}/snippets`).query({ status: 'reviewed' });
    expect(done.body.data.items.map((s: any) => s.id)).toEqual([reviewed.id]);
    expect(done.body.data.items[0].reviewStatus).toBe('reviewed');

    const notDone = await api().get(`${V1}/snippets`).query({ status: 'not_reviewed' });
    expect(notDone.body.data.items.map((s: any) => s.id)).toEqual([plain.id]);
  });

  it('combines the language and status filters', async () => {
    await reviewedSnippet([], { language: 'go' });
    const { snippet: pyReviewed } = await reviewedSnippet([], { language: 'python' });
    await createSnippet({ language: 'python' });

    const res = await api().get(`${V1}/snippets`).query({ language: 'python', status: 'reviewed' });
    expect(res.body.data.items.map((s: any) => s.id)).toEqual([pyReviewed.id]);
  });

  it('answers 400 for an unknown filter value or a bad limit', async () => {
    const lang = await api().get(`${V1}/snippets`).query({ language: 'cobol' });
    expect(lang.status).toBe(400);
    expect(lang.body.data).toHaveProperty('language');

    const status = await api().get(`${V1}/snippets`).query({ status: 'almost' });
    expect(status.status).toBe(400);
    expect(status.body.data).toHaveProperty('status');

    const limit = await api().get(`${V1}/snippets`).query({ limit: 0 });
    expect(limit.status).toBe(400);
    expect(limit.body.data).toHaveProperty('limit');
  });

  it('pages with a cursor: every row exactly once, nextCursor null on the last page', async () => {
    const created: number[] = [];
    for (let i = 0; i < 7; i++) created.push((await createSnippet({ title: `s${i}` })).id);

    const seen: number[] = [];
    const pageSizes: number[] = [];
    let cursor: number | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const res = await api()
        .get(`${V1}/snippets`)
        .query(cursor ? { limit: 3, cursor } : { limit: 3 });
      expect(res.status).toBe(200);
      seen.push(...res.body.data.items.map((s: any) => s.id));
      pageSizes.push(res.body.data.items.length);
      cursor = res.body.data.nextCursor;
      if (cursor === null) break;
    }

    expect(pageSizes).toEqual([3, 3, 1]);
    expect(seen).toEqual([...created].reverse());
    expect(new Set(seen).size).toBe(created.length);
  });

  it('gives nextCursor null when the last page is exactly full', async () => {
    for (let i = 0; i < 4; i++) await createSnippet();

    const first = await api().get(`${V1}/snippets`).query({ limit: 2 });
    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.nextCursor).not.toBeNull();

    const second = await api().get(`${V1}/snippets`).query({ limit: 2, cursor: first.body.data.nextCursor });
    expect(second.body.data.items).toHaveLength(2);
    expect(second.body.data.nextCursor).toBeNull();
  });

  it('does not repeat or skip rows when a snippet is created between pages', async () => {
    const created: number[] = [];
    for (let i = 0; i < 4; i++) created.push((await createSnippet()).id);

    const first = await api().get(`${V1}/snippets`).query({ limit: 2 });
    await createSnippet({ title: 'arrived late' });
    const second = await api().get(`${V1}/snippets`).query({ limit: 2, cursor: first.body.data.nextCursor });

    const ids = [...first.body.data.items, ...second.body.data.items].map((s: any) => s.id);
    expect(ids).toEqual([...created].reverse());
  });

  it('pages within a filter', async () => {
    const py: number[] = [];
    for (let i = 0; i < 3; i++) {
      py.push((await createSnippet({ language: 'python' })).id);
      await createSnippet({ language: 'go' });
    }

    const first = await api().get(`${V1}/snippets`).query({ language: 'python', limit: 2 });
    const second = await api()
      .get(`${V1}/snippets`)
      .query({ language: 'python', limit: 2, cursor: first.body.data.nextCursor });

    const ids = [...first.body.data.items, ...second.body.data.items].map((s: any) => s.id);
    expect(ids).toEqual([...py].reverse());
    expect(second.body.data.nextCursor).toBeNull();
  });
});

describe('GET /snippets/:id', () => {
  it('returns the snippet with latestReview null before any review, then the review with its findings', async () => {
    const created = await createSnippet({ code: 'a\nb\nc' });

    const before = await api().get(`${V1}/snippets/${created.id}`);
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({ id: created.id, code: 'a\nb\nc', latestReview: null });

    fakeProvider.respondWith({ findings: [finding({ lineStart: 2, lineEnd: 2 })] });
    const review = await waitForReview((await startReview(created.id)).id);

    const after = await api().get(`${V1}/snippets/${created.id}`);
    expect(after.status).toBe(200);
    expect(after.body.data.reviewStatus).toBe('reviewed');
    expect(after.body.data.latestReview).toMatchObject({
      id: review.id,
      status: 'done',
      findings: [expect.objectContaining({ lineStart: 2, lineEnd: 2, status: 'open' })],
    });
  });

  it('answers 404 for a snippet that does not exist', async () => {
    const res = await api().get(`${V1}/snippets/999999`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Snippet not found', data: null, success: false });
  });

  it('answers 400 for a non-numeric id', async () => {
    const res = await api().get(`${V1}/snippets/abc`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toHaveProperty('id');
  });
});

describe('GET /languages', () => {
  it('lists the supported languages', async () => {
    const res = await api().get(`${V1}/languages`);
    expect(res.status).toBe(200);
    expect(res.body.data).toContain('python');
    expect(res.body.data).toHaveLength(13);
  });
});
