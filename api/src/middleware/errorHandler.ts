import { NextFunction, Request, Response } from 'express';
import { errorResponseHandler } from '../utils/responseHandler';
import { HttpError } from '../utils/httpError';

export const notFoundHandler = (req: Request, res: Response) => {
  return errorResponseHandler(res, { message: `No route for ${req.method} ${req.path}`, statusCode: 404 });
};

// Last middleware in the chain. Known errors keep their status;
// anything else is logged and returned as a plain 500.
export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    return errorResponseHandler(res, { message: err.message, data: err.data, statusCode: err.statusCode });
  }
  console.error(`[${req.method} ${req.path}]`, err);
  return errorResponseHandler(res, { message: 'Internal Server Error', statusCode: 500 });
};
