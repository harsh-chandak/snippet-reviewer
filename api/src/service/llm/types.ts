// Tokens and cost of one model call. costUsd is null when nothing can price it: the CLI reports
// its own estimate ('cli'); the API provider prices tokens from the LLM_PRICE_* settings ('price-config').
export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  costSource: 'cli' | 'price-config' | null;
}

export interface GenerateInput {
  system: string;
  prompt: string;
  jsonSchema: object;
}

// The model's structured answer (not yet checked against our rules) and what the call used.
// usage is null only when the provider's response carried no usage at all.
export interface GenerateResult {
  output: unknown;
  usage: LlmUsage | null;
}

// What every LLM provider must do. The rest of the app only talks to this.
export interface LlmProvider {
  readonly name: string;
  generateStructured(input: GenerateInput): Promise<GenerateResult>;
}

// A failure the user should see in plain words, e.g. "The review timed out".
export class LlmError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
  }
}

// A token count from a provider response: a non-negative integer, else 0.
export function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
