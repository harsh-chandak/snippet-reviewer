import { Transaction } from 'sequelize';
import { Finding, Review } from '../schema';
import { ACTIVE_REVIEW_STATUSES, ReviewStatus } from '../constants';

type ReviewUpdate = Partial<{
  status: ReviewStatus;
  error: string | null;
  rejectedCount: number;
  startedAt: Date;
  completedAt: Date;
}>;

const withFindings = {
  include: [{ model: Finding, as: 'findings' }],
  order: [[{ model: Finding, as: 'findings' }, 'lineStart', 'ASC'], [{ model: Finding, as: 'findings' }, 'id', 'ASC']] as any,
};

class ReviewDao {
  async create(data: { snippetId: number; provider: string }, transaction?: Transaction) {
    return Review.create(data, { transaction });
  }

  async findByIdWithFindings(id: number) {
    return Review.findByPk(id, withFindings);
  }

  async findLatestForSnippet(snippetId: number) {
    const latest = await Review.findOne({
      where: { snippetId },
      order: [['createdAt', 'DESC'], ['id', 'DESC']],
      attributes: ['id'],
    });
    return latest ? this.findByIdWithFindings(latest.id) : null;
  }

  async findActive() {
    return Review.findAll({ where: { status: ACTIVE_REVIEW_STATUSES } });
  }

  async update(id: number | number[], data: ReviewUpdate, transaction?: Transaction) {
    await Review.update(data, { where: { id }, transaction });
  }

  // Moves a review on only if it is still in one of `from`. Returns false when something else
  // (a restart on another instance, say) already moved it, so the caller must not overwrite it.
  async updateIfStatus(id: number, from: ReviewStatus[], data: ReviewUpdate, transaction?: Transaction) {
    const [count] = await Review.update(data, { where: { id, status: from }, transaction });
    return count > 0;
  }
}

export const reviewDao = new ReviewDao();
