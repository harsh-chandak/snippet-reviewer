import { spawn } from 'child_process';
import os from 'os';
import { LlmError, LlmProvider } from './types';

// Development provider: runs the local Claude Code CLI (`claude -p`) on the
// developer's own subscription. Needs Claude Code installed and logged in.
class ClaudeHeadlessProvider implements LlmProvider {
  readonly name = 'claude-headless';

  private bin = process.env.CLAUDE_BIN || 'claude';
  private model = process.env.LLM_MODEL || 'sonnet';
  private timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 120000;

  generateStructured(input: { system: string; prompt: string; jsonSchema: object }): Promise<unknown> {
    const args = [
      '-p',
      '--system-prompt', input.system,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(input.jsonSchema),
      '--tools', '',
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

      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));

      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        const message =
          err.code === 'ENOENT'
            ? 'Claude Code CLI not found. Install it and log in, or set LLM_PROVIDER to an API provider.'
            : 'Could not start the Claude Code CLI';
        reject(new LlmError(message, err));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          return reject(new LlmError(`Claude Code CLI exited with code ${code}`, stderr.trim()));
        }
        try {
          const result = JSON.parse(stdout);
          if (result.is_error || result.subtype !== 'success') {
            return reject(new LlmError(`The model call failed: ${result.result || result.subtype}`, result));
          }
          if (result.structured_output === undefined) {
            return reject(new LlmError('The model did not return structured output', result));
          }
          resolve(result.structured_output);
        } catch (err) {
          reject(new LlmError('Could not read the Claude Code CLI output', err));
        }
      });

      child.stdin.end(input.prompt);
    });
  }
}

export const claudeHeadlessProvider = new ClaudeHeadlessProvider();
