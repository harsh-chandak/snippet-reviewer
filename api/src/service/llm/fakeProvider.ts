import { GenerateInput, GenerateResult, LlmError, LlmProvider, LlmUsage } from './types';

type Queued =
  | { kind: 'value'; value: unknown; delayMs: number; usage: LlmUsage | null }
  | { kind: 'error'; message: string; delayMs: number };

// What the fake reports when a test sets no usage: zero tokens, nothing priced.
export const FAKE_USAGE: LlmUsage = {
  model: 'fake',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
  costSource: null,
};

// Test provider: never calls a model. Each test queues the answer it wants,
// including bad findings and failures, so the validation and error paths can be proven.
class FakeProvider implements LlmProvider {
  readonly name = 'fake';

  private queue: Queued[] = [];
  lastInput: GenerateInput | undefined;
  callCount = 0;

  // Queues the raw structured output for the next call (not validated, on purpose).
  // usage: fields to report instead of FAKE_USAGE's, or null for a provider that reported none.
  respondWith(value: unknown, opts: { delayMs?: number; usage?: Partial<LlmUsage> | null } = {}) {
    const usage = opts.usage === null ? null : { ...FAKE_USAGE, ...opts.usage };
    this.queue.push({ kind: 'value', value, delayMs: opts.delayMs ?? 0, usage });
  }

  // Makes the next call reject with an LlmError carrying this message.
  failWith(message: string, opts: { delayMs?: number } = {}) {
    this.queue.push({ kind: 'error', message, delayMs: opts.delayMs ?? 0 });
  }

  // Clears queued answers and recorded input; call it in beforeEach so tests don't leak into each other.
  reset() {
    this.queue = [];
    this.lastInput = undefined;
    this.callCount = 0;
  }

  async generateStructured(input: GenerateInput): Promise<GenerateResult> {
    this.lastInput = input;
    this.callCount++;
    const next = this.queue.shift();
    if (!next) return { output: { findings: [] }, usage: { ...FAKE_USAGE } };

    if (next.delayMs > 0) await new Promise((r) => setTimeout(r, next.delayMs));
    if (next.kind === 'error') throw new LlmError(next.message);
    return { output: next.value, usage: next.usage && { ...next.usage } };
  }
}

export const fakeProvider = new FakeProvider();
