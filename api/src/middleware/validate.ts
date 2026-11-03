import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { errorResponseHandler } from '../utils/responseHandler';

interface ValidationError {
  [key: string]: string[];
}

const convertJoiError = (error: Joi.ValidationError): ValidationError => {
  const validationError: ValidationError = {};
  error.details.forEach((detail) => {
    const key = detail.path.join('.');
    if (!validationError[key]) {
      validationError[key] = [];
    }
    validationError[key].push(detail.message.replace(/"/g, ''));
  });
  return validationError;
};

// Validates req.body, req.query or req.params against a Joi schema.
// On failure it answers 400 and stops; the controller never runs.
// On success it replaces the input with Joi's cleaned value.
const validate = (schema: Joi.Schema, source: 'body' | 'query' | 'params' = 'body') => {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.validate(req[source], { abortEarly: false, stripUnknown: true });
    if (result.error) {
      return errorResponseHandler(res, {
        message: 'Validation Error',
        data: convertJoiError(result.error),
        statusCode: 400,
      });
    }
    req[source] = result.value;
    next();
  };
};

export default validate;
