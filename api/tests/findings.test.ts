import { describe, expect, it } from 'vitest';
import { api, finding, getSnippet, reviewedSnippet, useTestDatabase, V1 } from './helpers';

useTestDatabase();

// A reviewed snippet with two open findings, on lines 1 and 2.
async function twoFindings() {
  const { snippet, review } = await reviewedSnippet(
    [finding({ lineStart: 1, lineEnd: 1, description: 'one' }), finding({ lineStart: 2, lineEnd: 2, description: 'two' })],
    { code: 'a\nb\nc' },
  );
  expect(review.status).toBe('done');
  const [first, second] = review.findings;
  return { snippetId: snippet.id, reviewId: review.id, first, second };
}

const statusOf = async (snippetId: number, findingId: number) => {
  const snippet = await getSnippet(snippetId);
  return snippet.latestReview.findings.find((f: any) => f.id === findingId)?.status;
};

describe('PATCH /findings/:id', () => {
  it('accepting a finding persists: the snippet fetched again shows it accepted', async () => {
    const { snippetId, reviewId, first, second } = await twoFindings();

    const res = await api().patch(`${V1}/findings/${first.id}`).send({ status: 'accepted' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: 'Finding updated' });
    expect(res.body.data).toMatchObject({ id: first.id, status: 'accepted', description: 'one' });

    expect(await statusOf(snippetId, first.id)).toBe('accepted');
    expect(await statusOf(snippetId, second.id)).toBe('open');
    const review = await api().get(`${V1}/reviews/${reviewId}`);
    expect(review.body.data.findings.map((f: any) => f.status)).toEqual(['accepted', 'open']);
  });

  it('dismissing a finding persists: the snippet fetched again shows it dismissed', async () => {
    const { snippetId, first, second } = await twoFindings();

    const res = await api().patch(`${V1}/findings/${second.id}`).send({ status: 'dismissed' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: second.id, status: 'dismissed' });
    expect(await statusOf(snippetId, second.id)).toBe('dismissed');
    expect(await statusOf(snippetId, first.id)).toBe('open');
  });

  it('reopens an accepted or dismissed finding back to open', async () => {
    const { snippetId, first, second } = await twoFindings();
    await api().patch(`${V1}/findings/${first.id}`).send({ status: 'accepted' });
    await api().patch(`${V1}/findings/${second.id}`).send({ status: 'dismissed' });

    const reopenFirst = await api().patch(`${V1}/findings/${first.id}`).send({ status: 'open' });
    const reopenSecond = await api().patch(`${V1}/findings/${second.id}`).send({ status: 'open' });

    expect(reopenFirst.status).toBe(200);
    expect(reopenSecond.status).toBe(200);
    expect(await statusOf(snippetId, first.id)).toBe('open');
    expect(await statusOf(snippetId, second.id)).toBe('open');
  });

  it('changing a decision keeps only the last one', async () => {
    const { snippetId, first } = await twoFindings();
    await api().patch(`${V1}/findings/${first.id}`).send({ status: 'accepted' });
    await api().patch(`${V1}/findings/${first.id}`).send({ status: 'dismissed' });

    expect(await statusOf(snippetId, first.id)).toBe('dismissed');
  });

  it('answers 400 for an unknown status and leaves the finding unchanged', async () => {
    const { snippetId, first } = await twoFindings();

    const res = await api().patch(`${V1}/findings/${first.id}`).send({ status: 'resolved' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.data.status[0]).toBe('status must be one of [open, accepted, dismissed]');
    expect(await statusOf(snippetId, first.id)).toBe('open');
  });

  it('answers 400 when the status is missing', async () => {
    const { first } = await twoFindings();
    const res = await api().patch(`${V1}/findings/${first.id}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.data).toEqual({ status: ['status is required'] });
  });

  it('answers 404 for a finding that does not exist', async () => {
    const res = await api().patch(`${V1}/findings/999999`).send({ status: 'accepted' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Finding not found', data: null, success: false });
  });

  it('answers 400 for a non-numeric id', async () => {
    const res = await api().patch(`${V1}/findings/abc`).send({ status: 'accepted' });
    expect(res.status).toBe(400);
    expect(res.body.data).toHaveProperty('id');
  });
});
