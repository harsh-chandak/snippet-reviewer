import { NextFunction, Request, Response } from 'express';
import { errorResponseHandler } from '../utils/responseHandler';
import { HttpError } from '../utils/httpError';

export const notFoundHandler = (req: Request, res: Response) => {
  return errorResponseHandler(res, { message: `No route for ${req.method} ${req.path}`, statusCode: 404 });
};

// Errors Express and its body parser throw for a bad request: they carry a 4xx status.
// express.json() also sets a type (e.g. 'entity.parse.failed'); a URL Express can't decode
// (a malformed %-escape in an :id) is a URIError with status 400.
interface ClientError {
  status: number;
  type?: string;
}

const isClientError = (err: unknown): err is ClientError =>
  typeof err === 'object' &&
  err !== null &&
  typeof (err as ClientError).status === 'number' &&
  (err as ClientError).status >= 400 &&
  (err as ClientError).status < 500;

const CLIENT_ERROR_MESSAGES: Record<string, string> = {
  'entity.parse.failed': 'The request body is not valid JSON',
  'entity.too.large': 'The request body is too large',
};

function clientErrorMessage(err: ClientError): string {
  if (err.type && CLIENT_ERROR_MESSAGES[err.type]) return CLIENT_ERROR_MESSAGES[err.type];
  if (err instanceof URIError) return 'The URL is not valid';
  return 'The request could not be read';
}

// Last middleware in the chain. Known errors keep their status;
// anything else is logged and returned as a plain 500.
export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    return errorResponseHandler(res, { message: err.message, data: err.data, statusCode: err.statusCode });
  }
  // A bad body or URL is the client's mistake: keep Express's own 400 or 413.
  if (isClientError(err)) {
    return errorResponseHandler(res, { message: clientErrorMessage(err), statusCode: err.status });
  }
  console.error(`[${req.method} ${req.path}]`, err);
  return errorResponseHandler(res, { message: 'Internal Server Error', statusCode: 500 });
};
