import { GenerateInput, GenerateResult, LlmError, LlmProvider, LlmUsage, tokenCount } from './types';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const TOOL_NAME = 'submit_review';

// Production provider: calls the Anthropic Messages API with an API key.
// Structured output comes from forcing one tool whose input schema is our review schema.
class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';

  private model = process.env.LLM_MODEL || 'claude-sonnet-5-5';
  private timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 120000;
  private maxTokens = 8192;

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
          tools: [
            {
              name: TOOL_NAME,
              description: 'Submit the review findings for the snippet.',
              input_schema: input.jsonSchema,
            },
          ],
          tool_choice: { type: 'tool', name: TOOL_NAME },
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

    // A cut-off answer can still contain a tool_use block with partial input; don't trust it.
    if (body?.stop_reason === 'max_tokens') {
      throw new LlmError('The model ran out of room before finishing the review', body);
    }

    const block = Array.isArray(body?.content)
      ? body.content.find((b: any) => b?.type === 'tool_use' && b?.name === TOOL_NAME)
      : undefined;
    if (!block) {
      throw new LlmError('The model did not return structured output', body);
    }
    return { output: block.input, usage: usageFrom(body, this.model) };
  }
}

const PRICE_SETTINGS = [
  'LLM_PRICE_INPUT_PER_MTOK',
  'LLM_PRICE_OUTPUT_PER_MTOK',
  'LLM_PRICE_CACHE_READ_PER_MTOK',
  'LLM_PRICE_CACHE_WRITE_PER_MTOK',
] as const;

// USD per million tokens, from the environment. No price is ever written into the code: unless
// all four settings are present and valid numbers, the call is not priced at all.
function priceConfig(): number[] | null {
  const prices = PRICE_SETTINGS.map((name) => {
    const raw = process.env[name]?.trim();
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= 0 ? value : null;
  });
  return prices.every((p) => p !== null) ? (prices as number[]) : null;
}

// Tokens from the Messages API response's `usage`; the model is the one the API says answered.
export function usageFrom(body: any, requestedModel: string): LlmUsage | null {
  const usage = body?.usage;
  if (typeof usage !== 'object' || usage === null) return null;

  const tokens = {
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
    cacheReadTokens: tokenCount(usage.cache_read_input_tokens),
    cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens),
  };
  const prices = priceConfig();
  const costUsd = prices
    ? (tokens.inputTokens * prices[0] +
        tokens.outputTokens * prices[1] +
        tokens.cacheReadTokens * prices[2] +
        tokens.cacheWriteTokens * prices[3]) /
      1_000_000
    : null;
  const model = typeof body?.model === 'string' && body.model ? body.model : requestedModel;

  return { model: model.slice(0, 80), ...tokens, costUsd, costSource: prices ? 'price-config' : null };
}

export const anthropicProvider = new AnthropicProvider();
