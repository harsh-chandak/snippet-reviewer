import { LlmError, LlmProvider } from './types';

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

  async generateStructured(input: { system: string; prompt: string; jsonSchema: object }): Promise<unknown> {
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
    return block.input;
  }
}

export const anthropicProvider = new AnthropicProvider();
