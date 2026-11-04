import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { claudeHeadlessProvider } from '../../src/service/llm/claudeHeadlessProvider';

// The provider against stub CLIs that print what the real `claude -p --output-format json` prints.
// Never the real `claude`.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-usage-'));
function stub(name: string, body: string) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\ncat > /dev/null\n${body}\n`, { mode: 0o755 });
  return file;
}
function answer(name: string, json: object) {
  const data = path.join(dir, `${name}.json`);
  fs.writeFileSync(data, JSON.stringify(json));
  return stub(`${name}.sh`, `cat '${data}'`);
}
const input = { system: 'review', prompt: '1: x', jsonSchema: { type: 'object' } };
const saved = { bin: process.env.CLAUDE_BIN, model: process.env.LLM_MODEL, timeout: process.env.LLM_TIMEOUT_MS };

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
afterEach(() => {
  restore('CLAUDE_BIN', saved.bin);
  restore('LLM_MODEL', saved.model);
  restore('LLM_TIMEOUT_MS', saved.timeout);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const success = { type: 'result', subtype: 'success', is_error: false, structured_output: { findings: [] } };

describe('claude-headless usage', () => {
  it('takes tokens from usage and the cost from total_cost_usd', async () => {
    process.env.CLAUDE_BIN = answer('full', {
      ...success,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 9, cache_creation_input_tokens: 1500, cache_read_input_tokens: 300, output_tokens: 210 },
      modelUsage: {
        'claude-haiku-x': { inputTokens: 50, outputTokens: 5, costUSD: 0.0001 },
        'claude-sonnet-x-20260101': { inputTokens: 9, outputTokens: 210, costUSD: 0.0122 },
      },
    });
    const result = await claudeHeadlessProvider.generateStructured(input);
    expect(result).toEqual({
      output: { findings: [] },
      usage: {
        model: 'claude-sonnet-x-20260101',
        inputTokens: 9,
        outputTokens: 210,
        cacheReadTokens: 300,
        cacheWriteTokens: 1500,
        costUsd: 0.0123,
        costSource: 'cli',
      },
    });
  });

  it('names the requested model when the CLI gives no modelUsage', async () => {
    process.env.LLM_MODEL = 'sonnet';
    process.env.CLAUDE_BIN = answer('nomodel', { ...success, total_cost_usd: 0, usage: { input_tokens: 3, output_tokens: 4 } });
    const { usage } = await claudeHeadlessProvider.generateStructured(input);
    expect(usage).toEqual({
      model: 'sonnet',
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      costSource: 'cli',
    });
  });

  it('leaves the cost null when total_cost_usd is missing or not a number', async () => {
    process.env.CLAUDE_BIN = answer('nocost', { ...success, total_cost_usd: 'free', usage: { input_tokens: 3, output_tokens: -4 } });
    const { usage } = await claudeHeadlessProvider.generateStructured(input);
    expect(usage).toMatchObject({ inputTokens: 3, outputTokens: 0, costUsd: null, costSource: null });
  });

  it('returns usage null when the CLI reports neither usage nor cost', async () => {
    process.env.CLAUDE_BIN = answer('none', success);
    await expect(claudeHeadlessProvider.generateStructured(input)).resolves.toEqual({ output: { findings: [] }, usage: null });
  });
});

describe('claude-headless safeguards are unchanged', () => {
  it('passes every isolation flag and sends the prompt on stdin', async () => {
    const argsFile = path.join(dir, 'args.txt');
    const stdinFile = path.join(dir, 'stdin.txt');
    const data = path.join(dir, 'ok.json');
    fs.writeFileSync(data, JSON.stringify(success));
    const file = path.join(dir, 'record.sh');
    fs.writeFileSync(
      file,
      `#!/bin/sh\ncat > '${stdinFile}'\nfor a in "$@"; do printf '%s\\n' "[$a]"; done > '${argsFile}'\ncat '${data}'\n`,
      { mode: 0o755 },
    );
    process.env.CLAUDE_BIN = file;
    await claudeHeadlessProvider.generateStructured(input);
    const args = fs.readFileSync(argsFile, 'utf8');
    for (const flag of ['[-p]', '[--strict-mcp-config]', '[--disable-slash-commands]', '[--no-session-persistence]']) {
      expect(args).toContain(flag);
    }
    expect(args).toContain('[--tools]\n[]');
    expect(args).toContain('[--mcp-config]\n[{"mcpServers":{}}]');
    expect(args).toContain('[--setting-sources]\n[]');
    expect(args).toContain('[--output-format]\n[json]');
    expect(fs.readFileSync(stdinFile, 'utf8')).toBe('1: x');
  });

  it('fails cleanly instead of buffering unbounded output', async () => {
    process.env.CLAUDE_BIN = stub('flood.sh', "head -c 6000000 /dev/zero | tr '\\0' 'a'");
    await expect(claudeHeadlessProvider.generateStructured(input)).rejects.toThrow('more than 5 MB of output');
  });

  it('names the signal when the CLI is killed', async () => {
    process.env.CLAUDE_BIN = stub('killed.sh', 'kill -9 $$');
    await expect(claudeHeadlessProvider.generateStructured(input)).rejects.toThrow('was stopped by SIGKILL');
  });

  it('times out', async () => {
    process.env.LLM_TIMEOUT_MS = '300';
    process.env.CLAUDE_BIN = stub('slow.sh', 'sleep 5');
    await expect(claudeHeadlessProvider.generateStructured(input)).rejects.toThrow('timed out after 0.3s');
  });

  it('still fails on an error result', async () => {
    process.env.CLAUDE_BIN = answer('err', { subtype: 'error_max_turns', is_error: true, total_cost_usd: 0.01 });
    await expect(claudeHeadlessProvider.generateStructured(input)).rejects.toThrow('The model call failed: error_max_turns');
  });
});
