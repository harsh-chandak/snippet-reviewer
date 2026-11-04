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
    // Optional: 2-3 plain sentences, what the code does and then its main risk.
    summary: { type: 'string', maxLength: 400 },
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
export const MAX_SUMMARY_CHARS = 400;

// The model's summary as we store it, or null. Optional and never a reason to fail the review or
// drop a finding: anything that isn't a string, or is blank once cleaned, is just no summary.
// Cleaned like any text from outside that a user reads: no control characters or terminal escape
// codes, no lone surrogates (Postgres text can't hold them as written), whitespace collapsed, and
// cut to MAX_SUMMARY_CHARS without splitting a surrogate pair.
export function cleanSummary(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let text = value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > MAX_SUMMARY_CHARS) {
    text = text.slice(0, MAX_SUMMARY_CHARS);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    text = text.trimEnd();
  }
  return text || null;
}

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
