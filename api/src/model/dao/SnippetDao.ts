import { Op, Transaction, WhereOptions } from 'sequelize';
import db from '../../db/postgres';
import { Snippet } from '../schema';
import { CodeContext, Language, SnippetReviewStatus } from '../constants';

export interface SnippetListFilter {
  language?: Language;
  reviewStatus?: SnippetReviewStatus;
  // Return snippets with an id below this one (the last id of the previous page).
  before?: number;
  limit: number;
}

class SnippetDao {
  async create(data: { title: string; language: Language; code: string; context: CodeContext | null }) {
    return Snippet.create(data);
  }

  async findById(id: number) {
    return Snippet.findByPk(id);
  }

  // Newest first. The code body is left out: the list doesn't show it.
  async list(filter: SnippetListFilter) {
    const where: WhereOptions = {};
    if (filter.language) Object.assign(where, { language: filter.language });
    if (filter.reviewStatus) Object.assign(where, { reviewStatus: filter.reviewStatus });
    if (filter.before) Object.assign(where, { id: { [Op.lt]: filter.before } });

    return Snippet.findAll({
      where,
      attributes: { exclude: ['code'] },
      order: [['id', 'DESC']],
      limit: filter.limit,
    });
  }

  async setReviewStatus(ids: number | number[], reviewStatus: SnippetReviewStatus, transaction?: Transaction) {
    await Snippet.update({ reviewStatus }, { where: { id: ids }, transaction });
  }

  // The snippet mirrors its latest review only. An older review finishing late must not set it.
  async setReviewStatusIfLatest(
    snippetId: number,
    reviewId: number,
    reviewStatus: SnippetReviewStatus,
    transaction?: Transaction,
  ) {
    const latest = db.literal(
      `(SELECT r.id FROM reviews r WHERE r."snippetId" = ${Number(snippetId)} ` +
        `ORDER BY r."createdAt" DESC, r.id DESC LIMIT 1) = ${Number(reviewId)}`,
    );
    await Snippet.update({ reviewStatus }, { where: { id: snippetId, [Op.and]: [latest] }, transaction });
  }
}

export const snippetDao = new SnippetDao();
