import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicProvider, toApiSchema, usageFrom } from '../../src/service/llm/anthropicProvider';
import { reviewJsonSchema } from '../../src/service/llm/reviewSchema';

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
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: '{"findings":[]}' }],
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

  it('ignores an override that is missing a price, and uses the list price instead', async () => {
    setPrices({ LLM_PRICE_INPUT_PER_MTOK: '3', LLM_PRICE_OUTPUT_PER_MTOK: '15', LLM_PRICE_CACHE_READ_PER_MTOK: '0.3' });
    const { usage } = await anthropicProvider.generateStructured(input);
    expect(usage).toMatchObject({ inputTokens: 1000, costSource: 'price-table' });
  });

  it('ignores an override with a price that is not a number', async () => {
    setPrices({ ...PRICES, LLM_PRICE_OUTPUT_PER_MTOK: 'fifteen' });
    expect((await anthropicProvider.generateStructured(input)).usage).toMatchObject({ costSource: 'price-table' });
    setPrices({ ...PRICES, LLM_PRICE_OUTPUT_PER_MTOK: '-1' });
    expect((await anthropicProvider.generateStructured(input)).usage).toMatchObject({ costSource: 'price-table' });
  });

  it('returns usage null when the response has none, and the requested model when none is named', () => {
    expect(usageFrom({ content: [] }, 'claude-sonnet-5-5')).toBeNull();
    setPrices({});
    expect(usageFrom({ usage: { input_tokens: 1 } }, 'some-unlisted-model')).toEqual({
      model: 'some-unlisted-model',
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

describe('anthropic structured output', () => {
  it('asks for the review schema through output_config, not a forced tool', async () => {
    await anthropicProvider.generateStructured({ system: 's', prompt: 'p', jsonSchema: reviewJsonSchema });
    const sent = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(sent.tool_choice).toBeUndefined();
    expect(sent.tools).toBeUndefined();
    expect(sent.output_config.format.type).toBe('json_schema');
    expect(sent.output_config.format.schema).toEqual(toApiSchema(reviewJsonSchema));
  });

  it('drops the limits the API does not accept and closes every object', () => {
    const schema = toApiSchema(reviewJsonSchema) as any;
    const text = JSON.stringify(schema);
    expect(text).not.toMatch(/"(minimum|maxLength)"/);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.findings.items.additionalProperties).toBe(false);
    expect(schema.properties.findings.items.properties.fix.additionalProperties).toBe(false);
    // enum values and required lists come through as they are
    expect(schema.properties.findings.items.required).toEqual(reviewJsonSchema.properties.findings.items.required);
    // the shared schema itself is not changed
    expect(reviewJsonSchema.properties.summary.maxLength).toBe(400);
  });

  it('refuses an answer that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...body, content: [{ type: 'text', text: 'Sure! Here is' }] }))));
    await expect(anthropicProvider.generateStructured(input)).rejects.toThrow('did not return structured output');
  });

  it('says so when the model declines', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...body, stop_reason: 'refusal', content: [] }))));
    await expect(anthropicProvider.generateStructured(input)).rejects.toThrow('declined');
  });
});

describe('anthropic list prices', () => {
  beforeEach(() => setPrices({}));
  const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 400 };

  it('prices claude-sonnet-5-5 at its list price, dated id or not', () => {
    // (1000*2 + 200*10 + 5000*0.10 + 400*2.50) / 1e6
    for (const model of ['claude-sonnet-5-5', 'claude-sonnet-5-5-20261001']) {
      const priced = usageFrom({ model, usage }, 'x')!;
      expect(priced.costSource).toBe('price-table');
      expect(priced.costUsd).toBeCloseTo(0.0055, 12);
    }
  });

  it('the review on the page: 1,229 in and 76 out on claude-sonnet-5-5', () => {
    const priced = usageFrom({ model: 'claude-sonnet-5-5', usage: { input_tokens: 1229, output_tokens: 76 } }, 'x')!;
    // (1229*2 + 76*10) / 1e6
    expect(priced.costUsd).toBeCloseTo(0.003218, 12);
  });

  it('charges Haiku 5.5 its higher prices once the prompt, cache included, is over 100,000 tokens', () => {
    const short = usageFrom({ model: 'claude-haiku-5-5', usage: { input_tokens: 50_000, cache_read_input_tokens: 50_000, output_tokens: 1000 } }, 'x')!;
    // (50000*0.10 + 50000*0.01 + 1000*0.50) / 1e6
    expect(short.costUsd).toBeCloseTo(0.006, 12);
    const long = usageFrom({ model: 'claude-haiku-5-5', usage: { input_tokens: 50_001, cache_read_input_tokens: 50_000, output_tokens: 1000 } }, 'x')!;
    // (50001*0.50 + 50000*0.05 + 1000*2.50) / 1e6
    expect(long.costUsd).toBeCloseTo(0.0300005, 12);
  });

  it('leaves a model it has no price for unpriced, even one whose name starts like a listed one', () => {
    for (const model of ['claude-sonnet-5-5-preview', 'claude-sonnet-4-6', 'constructor', '__proto__']) {
      expect(usageFrom({ model, usage }, 'x')).toMatchObject({ costUsd: null, costSource: null });
    }
  });

  it('lets a complete override win over the list price', () => {
    setPrices(PRICES);
    expect(usageFrom({ model: 'claude-sonnet-5-5', usage }, 'x')).toMatchObject({ costSource: 'price-config' });
  });
});
