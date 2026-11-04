import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeHeadlessProvider } from '../src/service/llm/claudeHeadlessProvider';

// These run the provider against small stub CLIs, never the real `claude`.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-stub-'));
function stub(name: string, body: string) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\ncat > /dev/null\n${body}\n`, { mode: 0o755 });
  return file;
}
const input = { system: 'review', prompt: '1: x', jsonSchema: {} };
const originalBin = process.env.CLAUDE_BIN;

afterAll(() => {
  process.env.CLAUDE_BIN = originalBin;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('claude-headless provider limits', () => {
  it('fails cleanly instead of buffering unbounded output', async () => {
    process.env.CLAUDE_BIN = stub('flood.sh', "head -c 6000000 /dev/zero | tr '\\0' 'a'");
    await expect(claudeHeadlessProvider.generateStructured(input)).rejects.toThrow('more than 5 MB of output');
  });

  it('names the signal when the CLI is killed, not "exit code null"', async () => {
    process.env.CLAUDE_BIN = stub('killed.sh', 'kill -9 $$');
    await expect(claudeHeadlessProvider.generateStructured(input)).rejects.toThrow('was stopped by SIGKILL');
  });

  it('still returns the structured output of a normal answer', async () => {
    process.env.CLAUDE_BIN = stub('ok.sh', `echo '{"subtype":"success","is_error":false,"structured_output":{"findings":[]}}'`);
    // Providers resolve { output, usage }; this answer reports no usage and no cost, so usage is null.
    await expect(claudeHeadlessProvider.generateStructured(input)).resolves.toEqual({ output: { findings: [] }, usage: null });
  });
});
