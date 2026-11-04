// List prices for the Anthropic API, in USD per million tokens, so a review is priced from its
// token counts without anyone filling in settings. The API reports tokens, never dollars, so the
// price has to live somewhere we control; cost = tokens x price is then exact.
//
// Source: https://platform.claude.com/docs/en/about-claude/pricing, read on 2026-11-03.
// Standard (global) Claude API rates. Not covered, because this app uses none of them: the Batch
// API discount, fast mode, US-only inference (1.1x), and partner platforms' own prices.
// Cache writes use the 5-minute rate: the app never asks for the 1-hour cache.
// A model not listed here gets no cost unless LLM_PRICE_* is set; nothing is ever guessed.

export const PRICES_AS_OF = "2026-11-03";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface PriceEntry extends ModelPrice {
  // Claude Haiku 5.5 charges more for a request whose prompt is over 100,000 tokens. The prompt
  // counts every input token, cache reads and writes included.
  longPrompt?: { overTokens: number; price: ModelPrice };
}

const PRICE_TABLE: Record<string, PriceEntry> = {
  "claude-fable-5-1": {
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 12.5,
  },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
  },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longPrompt: {
      overTokens: 100_000,
      price: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    },
  },
};

// The list price for one request on `model`, or null for a model we have no price for. Accepts a
// dated id (claude-sonnet-5-5-20261001) as the same model.
export function listPrice(
  model: string,
  promptTokens: number,
): ModelPrice | null {
  const id = model.replace(/-\d{8}$/, "");
  const entry = Object.prototype.hasOwnProperty.call(PRICE_TABLE, id)
    ? PRICE_TABLE[id]
    : undefined;
  if (!entry) return null;
  if (entry.longPrompt && promptTokens > entry.longPrompt.overTokens)
    return entry.longPrompt.price;
  const { input, output, cacheRead, cacheWrite } = entry;
  return { input, output, cacheRead, cacheWrite };
}
