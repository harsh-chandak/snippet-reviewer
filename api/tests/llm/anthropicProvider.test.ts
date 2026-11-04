import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicProvider, usageFrom } from '../../src/service/llm/anthropicProvider';

// The provider against a stubbed fetch; never the real API.
const PRICES = {
  LLM_PRICE_INPUT_PER_MTOK: '3',
  LLM_PRICE_OUTPUT_PER_MTOK: '15',
  LLM_PRICE_CACHE_READ_PER_MTOK: '0.3',
  LLM_PRICE_CACHE_WRITE_PER_MTOK: '3.75',
};
const ENV_NAMES = [...Object.keys(PRICES), 'ANTHROPIC_API_KEY'];
const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));

function setPrices(values: Partial<typeof PRICES>) {
  for (const name of Object.keys(PRICES)) delete process.env[name];
  Object.assign(process.env, values);
}

const body = {
  model: 'claude-sonnet-5-5-20261001',
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', name: 'submit_review', input: { findings: [] } }],
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 400 },
};

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const input = { system: 's', prompt: 'p', jsonSchema: {} };

describe('anthropic usage', () => {
  it('takes tokens from the API response and prices them when all four prices are set', async () => {
    setPrices(PRICES);
    const result = await anthropicProvider.generateStructured(input);
    expect(result.output).toEqual({ findings: [] });
    expect(result.usage).toMatchObject({
      model: 'claude-sonnet-5-5-20261001',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 5000,
      cacheWriteTokens: 400,
      costSource: 'price-config',
    });
    // (1000*3 + 200*15 + 5000*0.3 + 400*3.75) / 1e6
    expect(result.usage!.costUsd).toBeCloseTo(0.009, 10);
  });

  it('leaves the cost null unless every price is set', async () => {
    setPrices({ LLM_PRICE_INPUT_PER_MTOK: '3', LLM_PRICE_OUTPUT_PER_MTOK: '15', LLM_PRICE_CACHE_READ_PER_MTOK: '0.3' });
    const { usage } = await anthropicProvider.generateStructured(input);
    expect(usage).toMatchObject({ inputTokens: 1000, costUsd: null, costSource: null });
  });

  it('leaves the cost null when a price is not a number', async () => {
    setPrices({ ...PRICES, LLM_PRICE_OUTPUT_PER_MTOK: 'fifteen' });
    expect((await anthropicProvider.generateStructured(input)).usage).toMatchObject({ costUsd: null, costSource: null });
    setPrices({ ...PRICES, LLM_PRICE_OUTPUT_PER_MTOK: '-1' });
    expect((await anthropicProvider.generateStructured(input)).usage).toMatchObject({ costUsd: null, costSource: null });
  });

  it('returns usage null when the response has none, and the requested model when none is named', () => {
    expect(usageFrom({ content: [] }, 'claude-sonnet-5-5')).toBeNull();
    setPrices({});
    expect(usageFrom({ usage: { input_tokens: 1 } }, 'claude-sonnet-5-5')).toEqual({
      model: 'claude-sonnet-5-5',
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      costSource: null,
    });
  });

  it('still refuses a cut-off answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...body, stop_reason: 'max_tokens' }))));
    await expect(anthropicProvider.generateStructured(input)).rejects.toThrow('ran out of room');
  });
});
