import { Request, Response } from 'express';
import db from '../../db/postgres';
import { successResponseHandler } from '../../utils/responseHandler';

class HealthController {
  async check(_req: Request, res: Response) {
    await db.authenticate();
    return successResponseHandler(res, { message: 'ok', data: { db: 'up' } });
  }
}

export const healthController = new HealthController();
