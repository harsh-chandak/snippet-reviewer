import Joi from 'joi';
import { CATEGORIES, SEVERITIES } from '../../model/constants';
import type { FixReplacement } from '../analysis/types';

export interface LlmFinding {
  lineStart: number;
  lineEnd: number;
  severity: (typeof SEVERITIES)[number];
  category: (typeof CATEGORIES)[number];
  description: string;
  suggestedFix?: string | null;
  fix?: FixReplacement | null;
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
          // Optional mechanical fix: replace lines lineStart..lineEnd (inclusive) with `replacement`.
          fix: {
            type: 'object',
            properties: {
              lineStart: { type: 'integer', minimum: 1 },
              lineEnd: { type: 'integer', minimum: 1 },
              replacement: { type: 'string' },
            },
            required: ['lineStart', 'lineEnd', 'replacement'],
          },
        },
        required: ['lineStart', 'lineEnd', 'severity', 'category', 'description'],
      },
    },
  },
  required: ['findings'],
};

// Limits on what we store from the model: a real finding is a few sentences and a short fix.
export const MAX_FINDINGS = 100;
export const MAX_DESCRIPTION_CHARS = 2000;
export const MAX_FIX_CHARS = 4000;

// A model fix that is malformed is dropped (fix: null), but the finding it came with is kept.
export const fixValidator = Joi.object<FixReplacement>({
  lineStart: Joi.number().integer().min(1).required(),
  lineEnd: Joi.number().integer().min(Joi.ref('lineStart')).required(),
  // Not trimmed: indentation is part of the code. Empty means "delete these lines".
  replacement: Joi.string().max(MAX_FIX_CHARS).allow('').required(),
});

// Checked again on our side: we don't trust the model's output just because we asked for a shape.
export const findingValidator = Joi.object<LlmFinding>({
  lineStart: Joi.number().integer().min(1).required(),
  lineEnd: Joi.number().integer().min(Joi.ref('lineStart')).required(),
  severity: Joi.string().valid(...SEVERITIES).required(),
  category: Joi.string().valid(...CATEGORIES).required(),
  description: Joi.string().trim().min(1).max(MAX_DESCRIPTION_CHARS).required(),
  // Optional: a model that writes null or "" means "no fix", which is not a reason to drop the finding.
  suggestedFix: Joi.string().trim().max(MAX_FIX_CHARS).allow('', null),
  // Checked separately (fixValidator) so a bad fix doesn't cost the finding.
  fix: Joi.any(),
});
