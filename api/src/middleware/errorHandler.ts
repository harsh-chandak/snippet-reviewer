import { NextFunction, Request, Response } from 'express';
import { errorResponseHandler } from '../utils/responseHandler';
import { HttpError } from '../utils/httpError';

export const notFoundHandler = (req: Request, res: Response) => {
  return errorResponseHandler(res, { message: `No route for ${req.method} ${req.path}`, statusCode: 404 });
};

// What express.json() throws for a bad body: a 4xx status and a type such as 'entity.parse.failed'.
interface BodyParserError {
  status: number;
  type: string;
}

const isBodyParserError = (err: unknown): err is BodyParserError =>
  typeof err === 'object' &&
  err !== null &&
  typeof (err as BodyParserError).type === 'string' &&
  typeof (err as BodyParserError).status === 'number' &&
  (err as BodyParserError).status >= 400 &&
  (err as BodyParserError).status < 500;

const BODY_ERROR_MESSAGES: Record<string, string> = {
  'entity.parse.failed': 'The request body is not valid JSON',
  'entity.too.large': 'The request body is too large',
};

// Last middleware in the chain. Known errors keep their status;
// anything else is logged and returned as a plain 500.
export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    return errorResponseHandler(res, { message: err.message, data: err.data, statusCode: err.statusCode });
  }
  // A bad request body is the client's mistake: keep body-parser's 400 or 413.
  if (isBodyParserError(err)) {
    const message = BODY_ERROR_MESSAGES[err.type] || 'The request body could not be read';
    return errorResponseHandler(res, { message, statusCode: err.status });
  }
  console.error(`[${req.method} ${req.path}]`, err);
  return errorResponseHandler(res, { message: 'Internal Server Error', statusCode: 500 });
};
