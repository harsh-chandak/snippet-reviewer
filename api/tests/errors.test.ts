import { describe, expect, it } from 'vitest';
import { api, useTestDatabase, V1 } from './helpers';

useTestDatabase();

describe('error responses', () => {
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

  // KNOWN BUG (not fixed here: src/middleware/errorHandler.ts is owned by another unit).
  // express.json() rejects a malformed body with a 400 error (err.status / err.type =
  // 'entity.parse.failed'), but errorHandler only keeps the status of HttpError, so the
  // client's mistake comes back as 500 "Internal Server Error" and is logged as a server fault.
  it('KNOWN BUG: answers 400, not 500, for a malformed JSON body', async () => {
    const res = await api().post(`${V1}/snippets`).set('content-type', 'application/json').send('{"title": ');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // KNOWN BUG, same cause: a body over the 1mb express.json limit is a 413 from body-parser,
  // reshaped into a 500 by errorHandler.
  it('KNOWN BUG: answers 413, not 500, for a body over the size limit', async () => {
    const res = await api()
      .post(`${V1}/snippets`)
      .send({ title: 'big', language: 'go', code: 'x'.repeat(1_100_000) });
    expect(res.status).toBe(413);
    expect(res.body.success).toBe(false);
  });
});
