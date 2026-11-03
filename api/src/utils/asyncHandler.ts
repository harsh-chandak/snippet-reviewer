import { NextFunction, Request, RequestHandler, Response } from 'express';

// Express 4 doesn't catch errors from async handlers on its own.
// Wrap each async controller so a thrown error reaches the error handler.
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
