'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Finding, FindingSource, FindingStatus, Review, Severity } from '@/lib/types';
import { FindingCard } from './FindingCard';

export type StatusFilter = 'all' | FindingStatus;
export type SourceFilter = 'all' | FindingSource;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

// The list order: critical, warning, info, then by line, then as the API sent them (id).
// Status is not part of the order, so marking a finding never moves it.
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      Math.min(a.lineStart, a.lineEnd) - Math.min(b.lineStart, b.lineEnd) ||
      a.id - b.id,
  );
}

function matches(f: Finding, status: StatusFilter, source: SourceFilter): boolean {
  return (status === 'all' || f.status === status) && (source === 'all' || f.source === source);
}

export interface FindingsView {
  sorted: Finding[];
  visible: Finding[]; // sorted, filtered; what both the list and the code's marks show
  statusFilter: StatusFilter;
  sourceFilter: SourceFilter;
  setStatusFilter: (f: StatusFilter) => void;
  setSourceFilter: (f: SourceFilter) => void;
  selectedId: number | null;
  select: (id: number | null) => void;
  highlightedId: number | null;
  highlight: (id: number | null) => void;
  // Call when the user changes a finding's status: it stays in the list until the filters
  // change, so marking a finding under the Open filter doesn't make it vanish under the cursor.
  keep: (id: number) => void;
  // A gutter dot was clicked: select that line's most severe visible finding, and on a
  // second click the next one on the same line.
  selectLine: (line: number) => void;
}

export function useFindingsView(findings: readonly Finding[]): FindingsView {
  const [statusFilter, setStatus] = useState<StatusFilter>('all');
  const [sourceFilter, setSource] = useState<SourceFilter>('all');
  const [kept, setKept] = useState<ReadonlySet<number>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const [highlighted, setHighlighted] = useState<number | null>(null);

  const sorted = useMemo(() => sortFindings(findings), [findings]);
  const visible = useMemo(
    () => sorted.filter((f) => matches(f, statusFilter, sourceFilter) || kept.has(f.id) || f.id === selected),
    [sorted, statusFilter, sourceFilter, kept, selected],
  );

  // A new review brings new findings: a selection that no longer exists is dropped.
  const selectedId = selected !== null && sorted.some((f) => f.id === selected) ? selected : null;
  const highlightedId = highlighted !== null && sorted.some((f) => f.id === highlighted) ? highlighted : null;

  const refilter = (status: StatusFilter, source: SourceFilter) => {
    setKept(new Set());
    const current = sorted.find((f) => f.id === selected);
    if (current && !matches(current, status, source)) setSelected(null);
  };
  const setStatusFilter = (f: StatusFilter) => {
    setStatus(f);
    refilter(f, sourceFilter);
  };
  const setSourceFilter = (f: SourceFilter) => {
    setSource(f);
    refilter(statusFilter, f);
  };

  const keep = useCallback((id: number) => setKept((s) => (s.has(id) ? s : new Set(s).add(id))), []);

  const selectLine = (line: number) => {
    const onLine = visible.filter(
      (f) => Math.min(f.lineStart, f.lineEnd) <= line && line <= Math.max(f.lineStart, f.lineEnd),
    );
    if (!onLine.length) return;
    // Open findings first, then resolved ones, each in list order.
    const ordered = [...onLine.filter((f) => f.status === 'open'), ...onLine.filter((f) => f.status !== 'open')];
    const at = ordered.findIndex((f) => f.id === selectedId);
    setSelected(ordered[(at + 1) % ordered.length].id);
  };

  return {
    sorted,
    visible,
    statusFilter,
    sourceFilter,
    setStatusFilter,
    setSourceFilter,
    selectedId,
    select: setSelected,
    highlightedId,
    highlight: setHighlighted,
    keep,
    selectLine,
  };
}

// Scroll `el` into view inside `container` when the container scrolls itself (side by side);
// otherwise (stacked on a narrow screen) let the page scroll to it.
function revealIn(container: HTMLElement | null, el: HTMLElement) {
  if (container && container.scrollHeight > container.clientHeight + 1) {
    const top = el.offsetTop; // the container is the offsetParent (it is `relative`)
    const bottom = top + el.offsetHeight;
    const view = container.scrollTop;
    if (top < view) container.scrollTo({ top: top - 8, behavior: 'smooth' });
    else if (bottom > view + container.clientHeight) {
      container.scrollTo({ top: Math.min(top - 8, bottom - container.clientHeight + 8), behavior: 'smooth' });
    }
  } else {
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'accepted', label: 'Valid' },
  { value: 'dismissed', label: 'Not an issue' },
];
const SOURCE_FILTERS: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'rule', label: 'Rule' },
  { value: 'model', label: 'AI' },
];

function Segmented<T extends string>({
  label,
  options,
  value,
  counts,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  counts: Record<T, number>;
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      <span className="mr-0.5 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">{label}</span>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={`rounded-full border px-2 py-0.5 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 ${
              on
                ? 'border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]'
                : 'border-[var(--border)] bg-[var(--background)] hover:bg-[var(--surface)]'
            }`}
          >
            {o.label} <span className="tabular-nums opacity-70">{counts[o.value]}</span>
          </button>
        );
      })}
    </div>
  );
}

// The findings beside the code, most severe first. It scrolls on its own, keeps the selected
// card in view, and moves between cards with the arrow keys (Enter opens one).
export function FindingsPanel({
  view,
  review,
  lines,
  reviewActive,
  pendingFindings,
  findingErrors,
  onSetFindingStatus,
  className = '',
}: {
  view: FindingsView;
  review: Review | null;
  lines: readonly string[];
  reviewActive: boolean;
  pendingFindings: ReadonlySet<number>;
  findingErrors: Readonly<Record<number, string>>;
  onSetFindingStatus: (findingId: number, status: FindingStatus) => void;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { sorted, visible, selectedId } = view;

  // Keep the selected card in view, wherever the selection came from (a gutter dot, a key).
  useEffect(() => {
    if (selectedId === null) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-finding-id="${selectedId}"]`);
    if (el) revealIn(scrollRef.current, el);
  }, [selectedId]);

  const statusCounts = useMemo(() => {
    const bySource = sorted.filter((f) => view.sourceFilter === 'all' || f.source === view.sourceFilter);
    return {
      all: bySource.length,
      open: bySource.filter((f) => f.status === 'open').length,
      accepted: bySource.filter((f) => f.status === 'accepted').length,
      dismissed: bySource.filter((f) => f.status === 'dismissed').length,
    };
  }, [sorted, view.sourceFilter]);
  const sourceCounts = useMemo(() => {
    const byStatus = sorted.filter((f) => view.statusFilter === 'all' || f.status === view.statusFilter);
    return {
      all: byStatus.length,
      rule: byStatus.filter((f) => f.source === 'rule').length,
      model: byStatus.filter((f) => f.source === 'model').length,
    };
  }, [sorted, view.statusFilter]);

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const target = e.target as HTMLElement;
    if (!target.matches('[data-finding-button]')) return;
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-finding-button]'));
    const at = buttons.indexOf(target);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? buttons.length - 1
          : Math.min(buttons.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)));
    e.preventDefault();
    buttons[next]?.focus();
    const li = buttons[next]?.closest<HTMLElement>('[data-finding-id]');
    if (li) revealIn(scrollRef.current, li);
  };

  const ruleCount = sorted.filter((f) => f.source === 'rule').length;
  const filtered = view.statusFilter !== 'all' || view.sourceFilter !== 'all';

  let empty: string | null = null;
  if (!review) empty = 'Findings will be listed here once the snippet is reviewed.';
  else if (sorted.length === 0) {
    empty = reviewActive
      ? 'Findings appear here as each step finishes.'
      : review.status === 'failed'
        ? 'The review failed before it found anything.'
        : 'No findings.';
  } else if (visible.length === 0) empty = 'No findings match these filters.';

  return (
    <section
      aria-label="Findings"
      className={`flex min-h-0 flex-col rounded-md border border-[var(--border)] bg-[var(--surface)] ${className}`}
    >
      <div className="space-y-2 border-b border-[var(--border)] px-3 py-2.5">
        <h2 className="text-sm font-semibold">
          Findings <span className="font-normal tabular-nums text-[var(--muted)]">{sorted.length}</span>
        </h2>
        {sorted.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Segmented
              label="Status"
              options={STATUS_FILTERS}
              value={view.statusFilter}
              counts={statusCounts}
              onChange={view.setStatusFilter}
            />
            <Segmented
              label="Source"
              options={SOURCE_FILTERS}
              value={view.sourceFilter}
              counts={sourceCounts}
              onChange={view.setSourceFilter}
            />
          </div>
        )}
      </div>
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto p-2">
        {empty ? (
          <div className="px-2 py-6 text-center text-sm text-[var(--muted)]">
            <p>{empty}</p>
            {filtered && visible.length === 0 && sorted.length > 0 && (
              <button
                type="button"
                className="mt-2 text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
                onClick={() => {
                  view.setStatusFilter('all');
                  view.setSourceFilter('all');
                }}
              >
                Show all findings
              </button>
            )}
          </div>
        ) : (
          <ul aria-label="Findings, most severe first" className="space-y-2" onKeyDown={onKeyDown}>
            {visible.map((f) => (
              <li key={f.id} data-finding-id={f.id}>
                <FindingCard
                  finding={f}
                  lines={lines}
                  checking={reviewActive}
                  pending={pendingFindings.has(f.id)}
                  error={findingErrors[f.id]}
                  selected={f.id === selectedId}
                  onToggle={() => view.select(f.id === selectedId ? null : f.id)}
                  onHighlight={(on) => view.highlight(on ? f.id : null)}
                  onSetStatus={(status) => onSetFindingStatus(f.id, status)}
                />
              </li>
            ))}
          </ul>
        )}
        {reviewActive && review && review.phase !== 'checking' && sorted.length > 0 && (
          <p className="px-2 pt-2 text-xs text-[var(--muted)]">
            {ruleCount > 0 && review.phase === 'model'
              ? 'AI findings are added here when the model answers.'
              : 'More findings may arrive as the review runs.'}
          </p>
        )}
      </div>
    </section>
  );
}
