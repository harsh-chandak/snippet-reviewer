// Same rule as api/src/utils/codeLines.ts: a final newline doesn't add an empty line,
// so line N on screen is line N the API numbered for the model.
export function codeLines(code: string): string[] {
  return code.replace(/\r?\n$/, '').split('\n');
}
