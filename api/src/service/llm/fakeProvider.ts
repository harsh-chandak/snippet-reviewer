import { LlmError, LlmProvider } from './types';

type GenerateInput = { system: string; prompt: string; jsonSchema: object };
type Queued = { kind: 'value'; value: unknown; delayMs: number } | { kind: 'error'; message: string; delayMs: number };

// Test provider: never calls a model. Each test queues the answer it wants,
// including bad findings and failures, so the validation and error paths can be proven.
class FakeProvider implements LlmProvider {
  readonly name = 'fake';

  private queue: Queued[] = [];
  lastInput: GenerateInput | undefined;
  callCount = 0;

  // Queues the raw structured output for the next call (not validated, on purpose).
  respondWith(value: unknown, opts: { delayMs?: number } = {}) {
    this.queue.push({ kind: 'value', value, delayMs: opts.delayMs ?? 0 });
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

  async generateStructured(input: GenerateInput): Promise<unknown> {
    this.lastInput = input;
    this.callCount++;
    const next = this.queue.shift();
    if (!next) return { findings: [] };

    if (next.delayMs > 0) await new Promise((r) => setTimeout(r, next.delayMs));
    if (next.kind === 'error') throw new LlmError(next.message);
    return next.value;
  }
}

export const fakeProvider = new FakeProvider();
