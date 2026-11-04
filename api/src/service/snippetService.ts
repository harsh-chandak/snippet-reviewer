import { snippetDao, SnippetListFilter } from '../model/dao/SnippetDao';
import { reviewDao } from '../model/dao/ReviewDao';
import { CodeContext, Language } from '../model/constants';
import { HttpError } from '../utils/httpError';

class SnippetService {
  // context 'auto' (the default) is stored as null: the review detects it from the code.
  async create(input: { title: string; language: Language; code: string; context?: CodeContext | 'auto' }) {
    const { title, language, code, context } = input;
    return snippetDao.create({ title, language, code, context: !context || context === 'auto' ? null : context });
  }

  // Cursor pagination: the client sends back `nextCursor` to get the next page.
  // Unlike page numbers, it doesn't skip or repeat rows when new snippets arrive.
  async list(filter: SnippetListFilter) {
    // Ask for one extra row: if it comes back, there is a next page.
    const rows = await snippetDao.list({ ...filter, limit: filter.limit + 1 });
    const items = rows.slice(0, filter.limit);
    const nextCursor = rows.length > filter.limit ? items[items.length - 1].id : null;
    return { items, nextCursor };
  }

  async getWithLatestReview(id: number) {
    const snippet = await snippetDao.findById(id);
    if (!snippet) throw new HttpError(404, 'Snippet not found');
    const latestReview = await reviewDao.findLatestForSnippet(id);
    return { ...snippet.toJSON(), latestReview };
  }
}

export const snippetService = new SnippetService();
