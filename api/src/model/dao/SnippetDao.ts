import { Op, Transaction, WhereOptions } from 'sequelize';
import { Snippet } from '../schema';
import { Language, SnippetReviewStatus } from '../constants';

export interface SnippetListFilter {
  language?: Language;
  reviewStatus?: SnippetReviewStatus;
  // Return snippets with an id below this one (the last id of the previous page).
  before?: number;
  limit: number;
}

class SnippetDao {
  async create(data: { title: string; language: Language; code: string }) {
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
}

export const snippetDao = new SnippetDao();
