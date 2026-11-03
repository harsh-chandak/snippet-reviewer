// The lines of a snippet, the way an editor counts them: a file saved with a final
// newline doesn't have an extra empty line at the end. Used everywhere a line number
// matters (the size limit, the numbered prompt, checking a finding's lines), so they agree.
// The frontend has a copy in web/src/lib/codeLines.ts.
export function codeLines(code: string): string[] {
  return code.replace(/\r?\n$/, '').split('\n');
}
