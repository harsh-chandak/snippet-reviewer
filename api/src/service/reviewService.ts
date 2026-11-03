import { UniqueConstraintError } from 'sequelize';
import db from '../db/postgres';
import { snippetDao } from '../model/dao/SnippetDao';
import { reviewDao } from '../model/dao/ReviewDao';
import { findingDao } from '../model/dao/FindingDao';
import { llmService } from './llmService';
import { LlmError } from './llm/types';
import { HttpError } from '../utils/httpError';

class ReviewService {
  // Records the review and returns at once. The model call runs in the background;
  // the client polls GET /reviews/:id to follow it.
  async start(snippetId: number) {
    const snippet = await snippetDao.findById(snippetId);
    if (!snippet) throw new HttpError(404, 'Snippet not found');

    let review;
    try {
      review = await db.transaction(async (transaction) => {
        const created = await reviewDao.create({ snippetId, provider: llmService.providerName }, transaction);
        await snippetDao.setReviewStatus(snippetId, 'in_progress', transaction);
        return created;
      });
    } catch (err) {
      // The partial unique index refused a second active review for this snippet.
      if (err instanceof UniqueConstraintError) {
        throw new HttpError(409, 'A review is already in progress for this snippet');
      }
      throw err;
    }

    setImmediate(() => {
      this.run(review.id, snippetId, snippet.language, snippet.code);
    });
    return review;
  }

  async get(reviewId: number) {
    const review = await reviewDao.findByIdWithFindings(reviewId);
    if (!review) throw new HttpError(404, 'Review not found');
    return review;
  }

  // Every path ends with the review marked done or failed, so nothing is left "in progress".
  private async run(reviewId: number, snippetId: number, language: string, code: string) {
    try {
      await reviewDao.update(reviewId, { status: 'running', startedAt: new Date() });
      const result = await llmService.reviewSnippet(language, code);

      if (result.rejected.length) {
        console.warn(`[review ${reviewId}] dropped ${result.rejected.length} finding(s)`, result.rejected);
      }

      await db.transaction(async (transaction) => {
        await findingDao.createForReview(reviewId, result.findings, transaction);
        await reviewDao.update(
          reviewId,
          { status: 'done', rejectedCount: result.rejected.length, completedAt: new Date() },
          transaction,
        );
        await snippetDao.setReviewStatus(snippetId, 'reviewed', transaction);
      });
    } catch (err) {
      console.error(`[review ${reviewId}] failed`, err, err instanceof LlmError ? err.cause : '');
      // Only our own LlmError messages are safe and useful to show the user.
      const message = err instanceof LlmError ? err.message : 'The review failed unexpectedly';
      await db
        .transaction(async (transaction) => {
          await reviewDao.update(reviewId, { status: 'failed', error: message, completedAt: new Date() }, transaction);
          await snippetDao.setReviewStatus(snippetId, 'failed', transaction);
        })
        .catch((saveErr) => console.error(`[review ${reviewId}] could not record failure`, saveErr));
    }
  }

  // Runs at startup. A review still pending or running then was cut off by a restart
  // (reviews run inside this one process), so mark it failed instead of leaving it stuck.
  async failInterrupted() {
    const active = await reviewDao.findActive();
    if (!active.length) return 0;
    await db.transaction(async (transaction) => {
      await reviewDao.update(
        active.map((r) => r.id),
        { status: 'failed', error: 'The server restarted before this review finished. Run it again.', completedAt: new Date() },
        transaction,
      );
      await snippetDao.setReviewStatus(active.map((r) => r.snippetId), 'failed', transaction);
    });
    return active.length;
  }
}

export const reviewService = new ReviewService();
