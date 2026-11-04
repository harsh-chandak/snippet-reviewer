import type { FixReplacement } from '@/lib/types';

// A proposed fix as a small before/after: the snippet's lines lineStart..lineEnd marked
// removed, the replacement marked added. `lines` is codeLines(code), the same rows CodeView draws.
export function FixDiff({ fix, lines }: { fix: FixReplacement; lines: readonly string[] }) {
  const last = lines.length;
  const clamp = (n: number) => Math.min(Math.max(1, n), last);
  const start = clamp(Math.min(fix.lineStart, fix.lineEnd));
  const end = clamp(Math.max(fix.lineStart, fix.lineEnd));
  const before = lines.slice(start - 1, end);
  const after = fix.replacement === '' ? [] : fix.replacement.replace(/\r?\n$/, '').split('\n');
  const gutter = `${String(end + Math.max(0, after.length - before.length)).length + 1}ch`;

  return (
    <div
      role="group"
      aria-label={`Proposed change to ${start === end ? `line ${start}` : `lines ${start}–${end}`}`}
      className="overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--background)] font-mono text-[13px] leading-5"
    >
      <div className="w-max min-w-full py-1">
        {before.map((text, i) => (
          <div key={`b${i}`} className="flex bg-red-50 text-red-900 dark:bg-red-950/50 dark:text-red-200">
            <span className="shrink-0 select-none pr-2 text-right tabular-nums opacity-60" style={{ width: gutter }}>
              {start + i}
            </span>
            <span aria-hidden className="w-4 shrink-0 select-none">
              -
            </span>
            <span className="sr-only">removed: </span>
            <code className="whitespace-pre pr-4">{text.replace(/\r$/, '')}</code>
          </div>
        ))}
        {after.map((text, i) => (
          <div key={`a${i}`} className="flex bg-green-50 text-green-900 dark:bg-green-950/50 dark:text-green-200">
            <span className="shrink-0 select-none pr-2 text-right tabular-nums opacity-60" style={{ width: gutter }}>
              {start + i}
            </span>
            <span aria-hidden className="w-4 shrink-0 select-none">
              +
            </span>
            <span className="sr-only">added: </span>
            <code className="whitespace-pre pr-4">{text}</code>
          </div>
        ))}
        {after.length === 0 && (
          <p className="px-3 py-0.5 font-sans text-xs text-[var(--muted)]">
            Deletes {before.length === 1 ? 'this line' : 'these lines'}.
          </p>
        )}
      </div>
    </div>
  );
}
