import { Transaction } from 'sequelize';
import { Finding, Review } from '../schema';
import { ACTIVE_REVIEW_STATUSES, CodeContext, ReviewPhase, ReviewStatus } from '../constants';
import type { CostSource, PhaseTimings } from '../schema/Review';

export type ReviewUpdate = Partial<{
  status: ReviewStatus;
  phase: ReviewPhase;
  phaseTimings: PhaseTimings;
  error: string | null;
  rejectedCount: number;
  duplicateCount: number;
  context: CodeContext;
  contextSignals: string[];
  staticSupported: boolean;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  costSource: CostSource | null;
  startedAt: Date;
  completedAt: Date;
}>;

const withFindings = {
  include: [{ model: Finding, as: 'findings' }],
  order: [[{ model: Finding, as: 'findings' }, 'lineStart', 'ASC'], [{ model: Finding, as: 'findings' }, 'id', 'ASC']] as any,
};

class ReviewDao {
  async create(
    data: { snippetId: number; provider: string; promptVersion: string; rulesetVersion: string },
    transaction?: Transaction,
  ) {
    return Review.create(data, { transaction });
  }

  async findById(id: number) {
    return Review.findByPk(id);
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
