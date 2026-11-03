import { Request, Response } from 'express';
import { findingService } from '../../service/findingService';
import { successResponseHandler } from '../../utils/responseHandler';

class FindingController {
  async update(req: Request, res: Response) {
    const finding = await findingService.setStatus(Number(req.params.id), req.body.status);
    return successResponseHandler(res, { message: 'Finding updated', data: finding });
  }
}

export const findingController = new FindingController();
