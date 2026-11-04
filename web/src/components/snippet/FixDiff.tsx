'use client';

import { useState } from 'react';
import type { FixReplacement } from '@/lib/types';

// A side with more lines than this is folded to its first FOLDED_ROWS lines behind
// 'Show all N lines', so a huge fix (adversarial WEB2-2) can't flood the page.
export const FOLD_OVER_LINES = 40;
const FOLDED_ROWS = 20;

const FOLD_BUTTON =
  'ml-[calc(var(--gutter)+1rem)] my-0.5 rounded px-1.5 py-0.5 font-sans text-xs font-medium text-blue-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-blue-400';

function DiffSide({
  rows,
  firstLine,
  kind,
}: {
  rows: readonly string[];
  firstLine: number;
  kind: 'removed' | 'added';
}) {
  const [showAll, setShowAll] = useState(false);
  const folded = rows.length > FOLD_OVER_LINES && !showAll;
  const shown = folded ? rows.slice(0, FOLDED_ROWS) : rows;
  const tone =
    kind === 'removed'
      ? 'bg-red-50 text-red-900 dark:bg-red-950/50 dark:text-red-200'
      : 'bg-green-50 text-green-900 dark:bg-green-950/50 dark:text-green-200';
  return (
    <>
      {shown.map((text, i) => (
        <div key={i} className={`flex ${tone}`}>
          <span
            className="shrink-0 select-none pr-2 text-right tabular-nums opacity-60"
            style={{ width: 'var(--gutter)' }}
          >
            {firstLine + i}
          </span>
          <span aria-hidden className="w-4 shrink-0 select-none">
            {kind === 'removed' ? '-' : '+'}
          </span>
          <span className="sr-only">{kind}: </span>
          <code className="whitespace-pre pr-4">{text}</code>
        </div>
      ))}
      {rows.length > FOLD_OVER_LINES && (
        <button type="button" className={FOLD_BUTTON} aria-expanded={showAll} onClick={() => setShowAll((s) => !s)}>
          {showAll
            ? `Show the first ${FOLDED_ROWS} lines only`
            : `Show all ${rows.length.toLocaleString('en-US')} ${kind === 'removed' ? 'removed' : 'added'} lines`}
        </button>
      )}
    </>
  );
}

// A proposed fix as a small before/after: the snippet's lines lineStart..lineEnd marked
// removed, the replacement marked added. `lines` is codeLines(code), the same rows CodeView draws.
export function FixDiff({ fix, lines }: { fix: FixReplacement; lines: readonly string[] }) {
  const last = lines.length;
  const clamp = (n: number) => Math.min(Math.max(1, n), last);
  const start = clamp(Math.min(fix.lineStart, fix.lineEnd));
  const end = clamp(Math.max(fix.lineStart, fix.lineEnd));
  const before = lines.slice(start - 1, end).map((l) => l.replace(/\r$/, ''));
  const after = fix.replacement === '' ? [] : fix.replacement.replace(/\r?\n$/, '').split('\n');
  const gutter = `${String(end + Math.max(0, after.length - before.length)).length + 1}ch`;

  return (
    <div
      role="group"
      aria-label={`Proposed change to ${start === end ? `line ${start}` : `lines ${start}–${end}`}`}
      className="overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--background)] font-mono text-[13px] leading-5"
      style={{ ['--gutter' as string]: gutter }}
    >
      <div className="w-max min-w-full py-1">
        <DiffSide rows={before} firstLine={start} kind="removed" />
        <DiffSide rows={after} firstLine={start} kind="added" />
        {after.length === 0 && (
          <p className="px-3 py-0.5 font-sans text-xs text-[var(--muted)]">
            Deletes {before.length === 1 ? 'this line' : 'these lines'}.
          </p>
        )}
      </div>
    </div>
  );
}
