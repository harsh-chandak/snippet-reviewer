import Joi from 'joi';
import { CATEGORIES, SEVERITIES } from '../../model/constants';

export interface LlmFinding {
  lineStart: number;
  lineEnd: number;
  severity: (typeof SEVERITIES)[number];
  category: (typeof CATEGORIES)[number];
  description: string;
  suggestedFix?: string;
}

// Sent to the model so it answers in this exact shape.
export const reviewJsonSchema = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          lineStart: { type: 'integer', minimum: 1 },
          lineEnd: { type: 'integer', minimum: 1 },
          severity: { type: 'string', enum: [...SEVERITIES] },
          category: { type: 'string', enum: [...CATEGORIES] },
          description: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        required: ['lineStart', 'lineEnd', 'severity', 'category', 'description'],
      },
    },
  },
  required: ['findings'],
};

// Checked again on our side: we don't trust the model's output just because we asked for a shape.
export const findingValidator = Joi.object<LlmFinding>({
  lineStart: Joi.number().integer().min(1).required(),
  lineEnd: Joi.number().integer().min(Joi.ref('lineStart')).required(),
  severity: Joi.string().valid(...SEVERITIES).required(),
  category: Joi.string().valid(...CATEGORIES).required(),
  description: Joi.string().trim().min(1).required(),
  suggestedFix: Joi.string().trim().allow(''),
});
