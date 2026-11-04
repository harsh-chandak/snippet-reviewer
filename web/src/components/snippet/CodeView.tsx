'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { Finding, Language, Severity } from '@/lib/types';
import { LANGUAGE_LABELS } from '@/components/shared';
import { useHighlightedLines } from './highlight';

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const DOT: Record<Severity, string> = {
  critical: 'bg-red-500',
  warning: 'bg-amber-500',
  info: 'bg-blue-500',
};
const MUTED_DOT = 'bg-gray-300 dark:bg-gray-600';

// What a line carries: the most severe open finding covering it (null when every finding
// on it is resolved) and how many findings cover it.
interface LineMark {
  worstOpen: Severity | null;
  count: number;
}

function range(f: Pick<Finding, 'lineStart' | 'lineEnd'>, last: number): [number, number] {
  const clamp = (n: number) => Math.min(Math.max(1, n), last);
  return [clamp(Math.min(f.lineStart, f.lineEnd)), clamp(Math.max(f.lineStart, f.lineEnd))];
}

// Scroll the code box so lines start..end are in view, unless they already are.
function revealLines(box: HTMLElement, start: number, end: number) {
  const first = box.querySelector<HTMLElement>(`[data-line="${start}"]`);
  const last = box.querySelector<HTMLElement>(`[data-line="${end}"]`) ?? first;
  if (!first || !last) return;
  const top = first.offsetTop;
  const bottom = last.offsetTop + last.offsetHeight;
  const view = box.scrollTop;
  if (top >= view && bottom <= view + box.clientHeight) return;
  const room = box.clientHeight - (bottom - top);
  const target = room > 0 ? top - Math.min(room / 3, 96) : top - 8;
  box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}

// The code, line by line, with no findings inside it: a severity dot in the gutter for each
// line a finding covers (the colour of its most severe open finding, muted when all are
// resolved), the selected finding's lines strongly highlighted and other findings' lines
// faintly tinted. Clicking a dot selects that line's finding in the list beside it.
export function CodeView({
  code,
  lines,
  language,
  findings,
  selected,
  highlighted,
  onSelectLine,
  className = '',
}: {
  code: string;
  lines: readonly string[]; // codeLines(code), the numbering the API validated against
  language: Language;
  findings: readonly Finding[]; // the findings the list shows (after its filters)
  selected: Finding | null;
  highlighted: Finding | null; // hovered or focused in the list
  onSelectLine: (line: number) => void;
  className?: string;
}) {
  const tokens = useHighlightedLines(code, language);
  const last = lines.length;

  const marks = useMemo(() => {
    const marks = new Map<number, LineMark>();
    for (const f of findings) {
      const [start, end] = range(f, last);
      for (let n = start; n <= end; n++) {
        const m = marks.get(n) ?? { worstOpen: null, count: 0 };
        m.count++;
        if (f.status === 'open' && (m.worstOpen === null || SEVERITY_RANK[f.severity] < SEVERITY_RANK[m.worstOpen])) {
          m.worstOpen = f.severity;
        }
        marks.set(n, m);
      }
    }
    return marks;
  }, [findings, last]);

  const selectedRange = selected ? range(selected, last) : null;
  const highlightedRange = highlighted && highlighted.id !== selected?.id ? range(highlighted, last) : null;

  // The code scrolls to the selected finding's lines at once, and to a hovered or focused
  // one after a short pause, so running the mouse down the list doesn't shake the code.
  const boxRef = useRef<HTMLDivElement>(null);
  const [selStart, selEnd] = selectedRange ?? [0, 0];
  useEffect(() => {
    if (selStart && boxRef.current) revealLines(boxRef.current, selStart, selEnd);
  }, [selected?.id, selStart, selEnd]);
  const [hiStart, hiEnd] = highlightedRange ?? [0, 0];
  useEffect(() => {
    if (!hiStart) return;
    const timer = setTimeout(() => {
      if (boxRef.current) revealLines(boxRef.current, hiStart, hiEnd);
    }, 250);
    return () => clearTimeout(timer);
  }, [hiStart, hiEnd]);

  const numberWidth = `${String(last).length + 1}ch`;
  const within = (r: [number, number] | null, n: number) => !!r && r[0] <= n && n <= r[1];

  return (
    <section
      aria-label="Code"
      className={`flex min-h-0 flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--background)] ${className}`}
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-xs text-[var(--muted)]">
        <span className="font-mono">{LANGUAGE_LABELS[language]}</span>
        <span>
          {last} {last === 1 ? 'line' : 'lines'}
        </span>
      </div>
      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-auto">
        <div className="w-max min-w-full py-2">
          {lines.map((text, i) => {
            const n = i + 1;
            const mark = marks.get(n);
            const isSelected = within(selectedRange, n);
            const isHighlighted = !isSelected && within(highlightedRange, n);
            const lineTokens = tokens?.[i];
            let rowTone = '';
            if (isSelected) rowTone = 'bg-sky-200/70 dark:bg-sky-400/25';
            else if (isHighlighted) rowTone = 'bg-sky-100/80 dark:bg-sky-400/15';
            else if (mark?.worstOpen) rowTone = 'bg-amber-100/40 dark:bg-amber-400/[0.07]';
            else if (mark) rowTone = 'bg-gray-100/50 dark:bg-gray-400/[0.05]';
            const edge = isSelected
              ? 'border-sky-500'
              : isHighlighted
                ? 'border-sky-300 dark:border-sky-700'
                : 'border-transparent';
            return (
              <div key={n} data-line={n} className={`flex font-mono text-[13px] leading-5 ${rowTone}`}>
                {/* The gutter stays put when the code scrolls sideways. */}
                <span
                  className={`sticky left-0 z-[1] flex shrink-0 select-none items-center border-r-2 bg-[var(--surface)] ${edge}`}
                >
                  <span className="flex w-5 items-center justify-center">
                    {mark && (
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={() => onSelectLine(n)}
                        aria-label={`Line ${n}: ${mark.count} ${mark.count === 1 ? 'finding' : 'findings'}${
                          mark.worstOpen ? `, most severe open: ${mark.worstOpen}` : ', all resolved'
                        }. Show in the list`}
                        title={`${mark.count} ${mark.count === 1 ? 'finding' : 'findings'} on line ${n}`}
                        className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-[var(--border)]"
                      >
                        <span
                          aria-hidden
                          className={`h-2 w-2 rounded-full ${mark.worstOpen ? DOT[mark.worstOpen] : MUTED_DOT}`}
                        />
                      </button>
                    )}
                  </span>
                  <span
                    className={`pr-3 text-right tabular-nums ${
                      isSelected || mark?.worstOpen ? 'text-[var(--foreground)]' : 'text-[var(--muted)]'
                    }`}
                    style={{ width: numberWidth }}
                  >
                    {n}
                  </span>
                </span>
                {/* Light colours are inline; under a dark system theme each span switches
                    to the --shiki-dark colour shiki gave it. */}
                <code className="whitespace-pre px-4 text-[var(--foreground)] dark:[&>span]:![color:var(--shiki-dark)]">
                  {lineTokens
                    ? lineTokens.map((t, j) => (
                        <span key={j} style={t.style}>
                          {t.content}
                        </span>
                      ))
                    : text}
                </code>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
