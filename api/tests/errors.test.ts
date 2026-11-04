import { describe, expect, it } from 'vitest';
import { api, useTestDatabase, V1 } from './helpers';

useTestDatabase();

describe('error responses', () => {
  it('answers 400, not 500, for a malformed %-escape in an id', async () => {
    for (const path of ['/snippets/%E0', '/reviews/%zz']) {
      const res = await api().get(`${V1}${path}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ message: 'The URL is not valid', success: false });
    }
    const patch = await api().patch(`${V1}/findings/%25%`).send({ status: 'accepted' });
    expect(patch.status).toBe(400);
  });

  it('answers 400, not 500, for an id past the integer column', async () => {
    const patch = await api().patch(`${V1}/findings/2147483648`).send({ status: 'accepted' });
    expect(patch.status).toBe(400);
    const get = await api().get(`${V1}/snippets/2147483648`);
    expect(get.status).toBe(400);
    const list = await api().get(`${V1}/snippets?cursor=2147483648`);
    expect(list.status).toBe(400);
  });

  it('refuses a NUL character in the title or the code', async () => {
    const res = await api().post(`${V1}/snippets`).send({ title: 'a\u0000b', language: 'go', code: 'x\u0000y' });
    expect(res.status).toBe(400);
    expect(res.body.data).toEqual({
      title: ['title must not contain NUL characters'],
      code: ['code must not contain NUL characters'],
    });
  });

  it('answers 404 in the usual shape for a route that does not exist', async () => {
    const res = await api().get(`${V1}/nope`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'No route for GET /api/v1/nope', data: null, success: false });
  });

  it('answers the health check with the database up', async () => {
    const res = await api().get(`${V1}/health`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'ok', data: { db: 'up' }, success: true });
  });

  // express.json() rejects a malformed body with 400; the error handler must keep that status.
  it('answers 400, not 500, for a malformed JSON body', async () => {
    const res = await api().post(`${V1}/snippets`).set('content-type', 'application/json').send('{"title": ');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // A body over the 1mb express.json limit is a 413.
  it('answers 413, not 500, for a body over the size limit', async () => {
    const res = await api()
      .post(`${V1}/snippets`)
      .send({ title: 'big', language: 'go', code: 'x'.repeat(1_100_000) });
    expect(res.status).toBe(413);
    expect(res.body.success).toBe(false);
  });
});
