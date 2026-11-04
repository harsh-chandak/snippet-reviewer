'use client';

import { codeLines } from '@/lib/codeLines';
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Finding, FindingStatus, Language } from '@/lib/types';
import { LANGUAGE_LABELS } from '@/components/shared';
import { useHighlightedLines } from './highlight';
import { FindingCard } from './FindingCard';

type LineMark = 'open' | 'resolved';

// The code, line by line, with each finding's comment card directly under its lineEnd
// (GitHub PR review style) and its lines lineStart..lineEnd tinted.
export function CodeView({
  code,
  language,
  findings,
  reviewActive = false,
  pendingFindings,
  findingErrors,
  onSetFindingStatus,
}: {
  code: string;
  language: Language;
  findings: Finding[];
  reviewActive?: boolean; // findings may still be arriving and fixes may not be checked yet
  pendingFindings: ReadonlySet<number>;
  findingErrors: Readonly<Record<number, string>>;
  onSetFindingStatus: (findingId: number, status: FindingStatus) => void;
}) {
  // Split exactly as the API does (codeLines), so line N here is line N there.
  const lines = useMemo(() => codeLines(code).map((l) => l.replace(/\r$/, '')), [code]);
  const tokens = useHighlightedLines(code, language);

  // lineEnd -> the findings whose card sits under that line (several stack in API order),
  // and line -> tint. Out-of-range numbers are clamped rather than dropped, so no finding
  // can silently vanish.
  const { byEndLine, marks } = useMemo(() => {
    const last = lines.length;
    const clamp = (n: number) => Math.min(Math.max(1, n), last);
    const byEndLine = new Map<number, Finding[]>();
    const marks = new Map<number, LineMark>();
    for (const f of findings) {
      const start = clamp(Math.min(f.lineStart, f.lineEnd));
      const end = clamp(Math.max(f.lineStart, f.lineEnd));
      byEndLine.set(end, [...(byEndLine.get(end) ?? []), f]);
      for (let n = start; n <= end; n++) {
        if (f.status === 'open') marks.set(n, 'open');
        else if (!marks.has(n)) marks.set(n, 'resolved');
      }
    }
    return { byEndLine, marks };
  }, [findings, lines.length]);

  // Comment rows live inside the horizontally scrolling box (so they stay between their
  // lines) but must not stretch to the longest line. They are pinned to the left edge and
  // sized to the box's visible width, measured here.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const commentRowStyle: CSSProperties = viewportWidth ? { width: viewportWidth } : { width: '100%' };

  const gutterWidth = `${String(lines.length).length + 2}ch`;

  return (
    <section
      aria-label="Code"
      className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--background)]"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-xs text-[var(--muted)]">
        <span className="font-mono">{LANGUAGE_LABELS[language]}</span>
        <span>
          {lines.length} {lines.length === 1 ? 'line' : 'lines'}
        </span>
      </div>
      <div ref={scrollRef} className="overflow-x-auto">
        <div className="w-max min-w-full py-2">
          {lines.map((text, i) => {
            const n = i + 1;
            const mark = marks.get(n);
            const comments = byEndLine.get(n);
            const lineTokens = tokens?.[i];
            return (
              <Fragment key={n}>
                <div
                  className={`flex font-mono text-[13px] leading-5 ${
                    mark === 'open'
                      ? 'bg-amber-100/60 dark:bg-amber-400/10'
                      : mark === 'resolved'
                        ? 'bg-gray-100/70 dark:bg-gray-400/[0.06]'
                        : ''
                  }`}
                >
                  <span
                    className={`shrink-0 select-none border-r pr-3 text-right tabular-nums ${
                      mark === 'open'
                        ? 'border-amber-400 text-[var(--foreground)] dark:border-amber-500/60'
                        : 'border-transparent text-[var(--muted)]'
                    }`}
                    style={{ width: gutterWidth }}
                  >
                    {n}
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
                {comments && (
                  <div
                    className="sticky left-0 space-y-2 border-y border-[var(--border)] bg-[var(--surface)] px-3 py-3 sm:pl-8"
                    style={commentRowStyle}
                  >
                    {comments.map((f) => (
                      <FindingCard
                        key={f.id}
                        finding={f}
                        lines={lines}
                        checking={reviewActive}
                        pending={pendingFindings.has(f.id)}
                        error={findingErrors[f.id]}
                        onSetStatus={(status) => onSetFindingStatus(f.id, status)}
                      />
                    ))}
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
    </section>
  );
}
