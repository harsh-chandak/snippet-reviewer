import { Op, QueryTypes, Transaction, WhereOptions } from 'sequelize';
import db from '../../db/postgres';
import { Snippet } from '../schema';
import { CodeContext, Language, SnippetReviewStatus } from '../constants';

// Open findings on a snippet's latest review, by severity. All zero when it was never reviewed.
export interface FindingCounts {
  open: number;
  critical: number;
  warning: number;
  info: number;
}

const NO_FINDINGS: FindingCounts = { open: 0, critical: 0, warning: 0, info: 0 };

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

    const rows = await Snippet.findAll({
      where,
      attributes: { exclude: ['code'] },
      order: [['id', 'DESC']],
      limit: filter.limit,
    });
    const counts = await this.openFindingCounts(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r.toJSON(), findingCounts: counts.get(r.id) ?? { ...NO_FINDINGS } }));
  }

  // One grouped query: each snippet's latest review (the same order findLatestForSnippet uses),
  // and the open findings on it counted by severity. Snippets with no review, or none open, are absent.
  async openFindingCounts(snippetIds: number[]): Promise<Map<number, FindingCounts>> {
    const counts = new Map<number, FindingCounts>();
    if (!snippetIds.length) return counts;
    const rows = await db.query<FindingCounts & { snippetId: number }>(
      `SELECT latest."snippetId" AS "snippetId",
              count(*)::int AS open,
              count(*) FILTER (WHERE f.severity = 'critical')::int AS critical,
              count(*) FILTER (WHERE f.severity = 'warning')::int AS warning,
              count(*) FILTER (WHERE f.severity = 'info')::int AS info
         FROM (SELECT DISTINCT ON (r."snippetId") r."snippetId", r.id
                 FROM reviews r
                WHERE r."snippetId" IN (:snippetIds)
                ORDER BY r."snippetId", r."createdAt" DESC, r.id DESC) latest
         JOIN findings f ON f."reviewId" = latest.id AND f.status = 'open'
        GROUP BY latest."snippetId"`,
      { replacements: { snippetIds }, type: QueryTypes.SELECT },
    );
    for (const { snippetId, ...c } of rows) counts.set(snippetId, c);
    return counts;
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
