import { Response } from 'express';

interface ResponseBody {
  message: string;
  data?: unknown;
  statusCode?: number;
}

function successResponseHandler(res: Response, body: ResponseBody) {
  return res.status(body.statusCode ?? 200).json({
    message: body.message,
    data: body.data ?? null,
    success: true,
  });
}

function errorResponseHandler(res: Response, body: ResponseBody) {
  return res.status(body.statusCode ?? 500).json({
    message: body.message,
    data: body.data ?? null,
    success: false,
  });
}

export { successResponseHandler, errorResponseHandler };
