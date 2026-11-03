import Joi from 'joi';
import { LANGUAGES, MAX_CODE_CHARS, MAX_CODE_LINES, SNIPPET_REVIEW_STATUSES } from '../model/constants';
import { codeLines } from '../utils/codeLines';

export const createSnippetSchema = Joi.object({
  title: Joi.string().trim().min(1).max(200).required(),
  language: Joi.string().valid(...LANGUAGES).required(),
  code: Joi.string()
    .min(1)
    .max(MAX_CODE_CHARS)
    .custom((value: string, helpers) => {
      if (!value.trim()) return helpers.error('string.empty');
      if (codeLines(value).length > MAX_CODE_LINES) return helpers.error('code.tooManyLines');
      return value;
    })
    .messages({ 'code.tooManyLines': `code must be at most ${MAX_CODE_LINES} lines` })
    .required(),
});

export const listSnippetsSchema = Joi.object({
  language: Joi.string().valid(...LANGUAGES),
  status: Joi.string().valid(...SNIPPET_REVIEW_STATUSES),
  cursor: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

export const idParamsSchema = Joi.object({
  id: Joi.number().integer().min(1).required(),
});
