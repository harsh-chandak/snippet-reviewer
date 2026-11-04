import { GenerateInput, GenerateResult, LlmError, LlmProvider, LlmUsage, tokenCount } from './types';
import { listPrice, ModelPrice } from './prices';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// Structured outputs accept a subset of JSON Schema: no numeric or length limits, and every object
// must say additionalProperties: false. Those limits are still enforced on our side after the
// answer comes back (reviewSchema's validators), so dropping them here loses nothing.
const UNSUPPORTED_KEYWORDS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems']);

export function toApiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toApiSchema);
  if (typeof schema !== 'object' || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    out[key] = key === 'enum' || key === 'required' ? value : toApiSchema(value);
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

// Production provider: calls the Anthropic Messages API with an API key.
// Structured output comes from output_config.format with our review schema. (Current models
// refuse a forced tool_choice, which is how this used to be done.)
class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';

  private model = process.env.LLM_MODEL || 'claude-sonnet-5-5';
  private timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 120000;
  // The model thinks before answering, and thinking counts against this too.
  private maxTokens = 16000;

  async generateStructured(input: GenerateInput): Promise<GenerateResult> {
    // Read at call time, so the app still starts (and tests still run) without a key.
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY;
    if (!apiKey) {
      throw new LlmError('No Anthropic API key configured. Set ANTHROPIC_API_KEY, or use another LLM_PROVIDER.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          system: input.system,
          messages: [{ role: 'user', content: input.prompt }],
          output_config: { format: { type: 'json_schema', schema: toApiSchema(input.jsonSchema) } },
        }),
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new LlmError(`The review timed out after ${this.timeoutMs / 1000}s`, err);
      }
      throw new LlmError('Could not reach the Anthropic API', err);
    } finally {
      clearTimeout(timer);
    }

    let body: any;
    try {
      body = await res.json();
    } catch (err) {
      throw new LlmError(`The Anthropic API returned an unreadable response (HTTP ${res.status})`, err);
    }

    if (!res.ok) {
      const detail = body?.error?.message || res.statusText;
      throw new LlmError(`The Anthropic API returned ${res.status}: ${detail}`, body);
    }

    // A cut-off answer is partial JSON; don't trust it.
    if (body?.stop_reason === 'max_tokens') {
      throw new LlmError('The model ran out of room before finishing the review', body);
    }
    // A declined request carries no answer that matches the schema.
    if (body?.stop_reason === 'refusal') {
      throw new LlmError('The model declined to review this snippet', body);
    }

    const text = Array.isArray(body?.content)
      ? body.content
          .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('')
      : '';
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch (err) {
      throw new LlmError('The model did not return structured output', body);
    }
    return { output, usage: usageFrom(body, this.model) };
  }
}

const PRICE_SETTINGS = [
  'LLM_PRICE_INPUT_PER_MTOK',
  'LLM_PRICE_OUTPUT_PER_MTOK',
  'LLM_PRICE_CACHE_READ_PER_MTOK',
  'LLM_PRICE_CACHE_WRITE_PER_MTOK',
] as const;

// An override from the environment, USD per million tokens: used only when all four settings are
// present and valid numbers (for a negotiated rate, or a model the list doesn't have).
function priceOverride(): ModelPrice | null {
  const prices = PRICE_SETTINGS.map((name) => {
    const raw = process.env[name]?.trim();
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= 0 ? value : null;
  });
  if (!prices.every((p) => p !== null)) return null;
  const [input, output, cacheRead, cacheWrite] = prices as number[];
  return { input, output, cacheRead, cacheWrite };
}

// Tokens from the Messages API response's `usage`; the model is the one the API says answered.
// Priced from the LLM_PRICE_* override if it's complete, else from the list price for that model,
// else not priced at all.
export function usageFrom(body: any, requestedModel: string): LlmUsage | null {
  const usage = body?.usage;
  if (typeof usage !== 'object' || usage === null) return null;

  const tokens = {
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
    cacheReadTokens: tokenCount(usage.cache_read_input_tokens),
    cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens),
  };
  const model = (typeof body?.model === 'string' && body.model ? body.model : requestedModel).slice(0, 80);

  const override = priceOverride();
  const promptTokens = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
  const price = override ?? listPrice(model, promptTokens);
  const costUsd = price
    ? (tokens.inputTokens * price.input +
        tokens.outputTokens * price.output +
        tokens.cacheReadTokens * price.cacheRead +
        tokens.cacheWriteTokens * price.cacheWrite) /
      1_000_000
    : null;
  const costSource = override ? 'price-config' : price ? 'price-table' : null;

  return { model, ...tokens, costUsd, costSource };
}

export const anthropicProvider = new AnthropicProvider();
