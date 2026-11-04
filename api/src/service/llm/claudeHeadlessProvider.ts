import { spawn } from 'child_process';
import os from 'os';
import { GenerateInput, GenerateResult, LlmError, LlmProvider, LlmUsage, tokenCount } from './types';

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_STDERR_CHARS = 8000;

// Development provider: runs the local Claude Code CLI (`claude -p`) on the
// developer's own subscription. Needs Claude Code installed and logged in.
class ClaudeHeadlessProvider implements LlmProvider {
  readonly name = 'claude-headless';

  // Read on every call, so a changed .env (or a test) takes effect without a restart.
  private get bin() {
    return process.env.CLAUDE_BIN || 'claude';
  }
  private get model() {
    return process.env.LLM_MODEL || 'sonnet';
  }
  private get timeoutMs() {
    return Number(process.env.LLM_TIMEOUT_MS) || 120000;
  }

  generateStructured(input: GenerateInput): Promise<GenerateResult> {
    const args = [
      '-p',
      '--system-prompt', input.system,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(input.jsonSchema),
      '--tools', '',
      // `--tools ''` only removes the built-in tools. Without the next four flags the CLI also loads
      // the developer's MCP servers, plugins, skills and settings, so untrusted snippet text would sit
      // next to real tools (measured: 380 tools, ~358K input tokens per review; isolated: 1 tool, ~1.5K).
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--model', this.model,
    ];

    return new Promise((resolve, reject) => {
      // Run outside the repo so the CLI doesn't pick up this project's own files or CLAUDE.md.
      const child = spawn(this.bin, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new LlmError(`The review timed out after ${this.timeoutMs / 1000}s`));
      }, this.timeoutMs);

      // A review answer is a few KB. Anything near MAX_OUTPUT_BYTES is a broken CLI, and an
      // unbounded string would eventually crash the whole API (over 512 MB, measured).
      let tooBig = false;
      child.stdout.on('data', (chunk: Buffer) => {
        if (tooBig) return;
        if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) {
          tooBig = true;
          child.kill('SIGKILL');
          clearTimeout(timer);
          reject(new LlmError(`The model returned more than ${MAX_OUTPUT_BYTES / 1024 / 1024} MB of output`));
          return;
        }
        stdout += chunk;
      });
      // Only the end of stderr is useful for debugging; keep the last few KB.
      child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS)));

      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        const message =
          err.code === 'ENOENT'
            ? 'Claude Code CLI not found. Install it and log in, or set LLM_PROVIDER to an API provider.'
            : 'Could not start the Claude Code CLI';
        reject(new LlmError(message, err));
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (tooBig) return;
        if (code !== 0) {
          const how = code === null ? `was stopped by ${signal}` : `exited with code ${code}`;
          return reject(new LlmError(`Claude Code CLI ${how}`, stderr.trim()));
        }
        try {
          const result = JSON.parse(stdout);
          if (result.is_error || result.subtype !== 'success') {
            return reject(new LlmError(`The model call failed: ${result.result || result.subtype}`, result));
          }
          if (result.structured_output === undefined) {
            return reject(new LlmError('The model did not return structured output', result));
          }
          resolve({ output: result.structured_output, usage: this.usageFrom(result) });
        } catch (err) {
          reject(new LlmError('Could not read the Claude Code CLI output', err));
        }
      });

      child.stdin.end(input.prompt);
    });
  }

  // Tokens come from the CLI's `usage`, the price from its own `total_cost_usd` estimate.
  // The model is the one modelUsage charged most for (the CLI resolves an alias like 'sonnet'
  // to a full id there); without modelUsage, the model we asked for.
  private usageFrom(result: any): LlmUsage | null {
    const usage = result?.usage;
    const cost = result?.total_cost_usd;
    const hasCost = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0;
    if ((typeof usage !== 'object' || usage === null) && !hasCost) return null;

    let model = this.model;
    const byModel = result?.modelUsage;
    if (typeof byModel === 'object' && byModel !== null) {
      let best = -1;
      for (const [id, m] of Object.entries<any>(byModel)) {
        const weight = Number(m?.costUSD) || 0;
        if (weight > best) {
          best = weight;
          model = id;
        }
      }
    }

    return {
      model: model.slice(0, 80),
      inputTokens: tokenCount(usage?.input_tokens),
      outputTokens: tokenCount(usage?.output_tokens),
      cacheReadTokens: tokenCount(usage?.cache_read_input_tokens),
      cacheWriteTokens: tokenCount(usage?.cache_creation_input_tokens),
      costUsd: hasCost ? cost : null,
      costSource: hasCost ? 'cli' : null,
    };
  }
}

export const claudeHeadlessProvider = new ClaudeHeadlessProvider();
