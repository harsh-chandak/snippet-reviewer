import { Request, Response } from 'express';
import { reviewService } from '../../service/reviewService';
import { successResponseHandler } from '../../utils/responseHandler';

class ReviewController {
  // 202 Accepted: the review is recorded, but its result isn't ready yet.
  async start(req: Request, res: Response) {
    const review = await reviewService.start(Number(req.params.id));
    return successResponseHandler(res, { message: 'Review started', data: review, statusCode: 202 });
  }

  async get(req: Request, res: Response) {
    const review = await reviewService.get(Number(req.params.id));
    return successResponseHandler(res, { message: 'Review', data: review });
  }
}

export const reviewController = new ReviewController();
