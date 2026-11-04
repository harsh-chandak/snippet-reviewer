import { QueryTypes, Transaction } from 'sequelize';
import db from '../../db/postgres';
import { ReviewEvent } from '../schema';
import { ReviewEventType } from '../constants';

export interface NewReviewEvent {
  type: ReviewEventType;
  payload: Record<string, unknown>;
}

class ReviewEventDao {
  // Holds the review's event log until the transaction ends, so two writers can't both count
  // the same free room under the size limit.
  async lockReview(reviewId: number, transaction: Transaction) {
    await db.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
      replacements: { key: `review_events:${reviewId}` },
      type: QueryTypes.SELECT,
      transaction,
    });
  }

  // How many per-item rows the log holds (every type not in `notCounted`), and whether it has said
  // it dropped something. Read inside the caller's locked transaction.
  async stats(reviewId: number, transaction: Transaction, notCounted: readonly ReviewEventType[] = []) {
    const [row] = await db.query<{ perItem: number; truncated: number }>(
      `SELECT count(*) FILTER (WHERE NOT (type = ANY(ARRAY[:notCounted]::varchar[])))::int AS "perItem",
              count(*) FILTER (WHERE type = 'events.truncated')::int AS truncated
         FROM review_events WHERE "reviewId" = :reviewId`,
      { replacements: { reviewId, notCounted: notCounted.length ? [...notCounted] : [''] }, type: QueryTypes.SELECT, transaction },
    );
    return { perItem: row.perItem, truncated: row.truncated > 0 };
  }

  async insert(reviewId: number, events: NewReviewEvent[], transaction: Transaction) {
    if (!events.length) return;
    await ReviewEvent.bulkCreate(
      events.map((e) => ({ reviewId, type: e.type, payload: e.payload })),
      { transaction },
    );
  }

  async listForReview(reviewId: number) {
    return ReviewEvent.findAll({ where: { reviewId }, order: [['id', 'ASC']] });
  }
}

export const reviewEventDao = new ReviewEventDao();
