import { Request, Response } from 'express';
import { snippetService } from '../../service/snippetService';
import { successResponseHandler } from '../../utils/responseHandler';
import { LANGUAGES } from '../../model/constants';

class SnippetController {
  async create(req: Request, res: Response) {
    const snippet = await snippetService.create(req.body);
    return successResponseHandler(res, { message: 'Snippet created', data: snippet, statusCode: 201 });
  }

  async list(req: Request, res: Response) {
    const { language, status, cursor, limit } = req.query as Record<string, any>;
    const page = await snippetService.list({ language, reviewStatus: status, before: cursor, limit });
    return successResponseHandler(res, { message: 'Snippets', data: page });
  }

  async get(req: Request, res: Response) {
    const snippet = await snippetService.getWithLatestReview(Number(req.params.id));
    return successResponseHandler(res, { message: 'Snippet', data: snippet });
  }

  async languages(_req: Request, res: Response) {
    return successResponseHandler(res, { message: 'Languages', data: LANGUAGES });
  }
}

export const snippetController = new SnippetController();
