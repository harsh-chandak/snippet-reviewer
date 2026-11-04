import Link from 'next/link';
import type { FindingCounts, SnippetListItem } from '@/lib/dashboardTypes';
import type { Severity, SnippetReviewStatus } from '@/lib/types';
import { LanguageTag, ReviewStatusBadge, SEVERITY_LABELS } from '@/components/shared';

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const FULL_DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });

function formatDate(iso: string, format: Intl.DateTimeFormat): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : format.format(date);
}

const SEVERITY_TEXT: Record<Severity, string> = {
  critical: 'text-red-700 dark:text-red-400',
  warning: 'text-amber-700 dark:text-amber-400',
  info: 'text-blue-700 dark:text-blue-400',
};
const SEVERITY_DOT: Record<Severity, string> = {
  critical: 'bg-red-500',
  warning: 'bg-amber-500',
  info: 'bg-blue-500',
};

// '3 open · 1 critical': the open findings on the latest review and how many share the highest
// severity among them, in that severity's colour. Nothing to count before a review.
export function OpenFindings({ counts, status }: { counts?: FindingCounts; status: SnippetReviewStatus }) {
  if (status === 'not_reviewed' || !counts) return <span className="text-[var(--muted)]">&mdash;</span>;
  if (counts.open === 0) {
    return <span className="text-[var(--muted)]">{status === 'in_progress' ? 'None yet' : 'None open'}</span>;
  }
  const top = (['critical', 'warning', 'info'] as const).find((s) => counts[s] > 0);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {top && <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[top]}`} />}
      <span className="font-medium tabular-nums">{counts.open} open</span>
      {top && (
        <span className={`tabular-nums ${SEVERITY_TEXT[top]}`}>
          &middot; {counts[top]} {SEVERITY_LABELS[top].toLowerCase()}
        </span>
      )}
    </span>
  );
}

export const TABLE_FRAME_CLASS = 'overflow-x-auto rounded-md border border-[var(--border)]';
export const TH_CLASS = 'px-4 py-2 font-medium';

export function SnippetTableHead() {
  return (
    <thead className="border-b border-[var(--border)] bg-[var(--surface)] text-xs text-[var(--muted)]">
      <tr>
        <th scope="col" className={TH_CLASS}>
          Title
        </th>
        <th scope="col" className={TH_CLASS}>
          Language
        </th>
        <th scope="col" className={TH_CLASS}>
          Review status
        </th>
        <th scope="col" className={TH_CLASS}>
          Open findings
        </th>
        <th scope="col" className={`${TH_CLASS} text-right`}>
          Created
        </th>
      </tr>
    </thead>
  );
}

// One row per snippet, newest first (the API already orders them).
export function SnippetTable({ snippets }: { snippets: SnippetListItem[] }) {
  return (
    <div className={TABLE_FRAME_CLASS}>
      <table className="w-full min-w-[44rem] text-left text-sm">
        <SnippetTableHead />
        <tbody className="divide-y divide-[var(--border)]">
          {snippets.map((snippet) => (
            <tr key={snippet.id} className="hover:bg-[var(--surface)]">
              <td className="px-4 py-3">
                <Link
                  href={`/snippets/${snippet.id}`}
                  className="break-words font-semibold hover:text-blue-600 hover:underline dark:hover:text-blue-400"
                >
                  {snippet.title}
                </Link>
              </td>
              <td className="px-4 py-3">
                <LanguageTag language={snippet.language} />
              </td>
              <td className="px-4 py-3">
                <ReviewStatusBadge status={snippet.reviewStatus} />
              </td>
              <td className="px-4 py-3">
                <OpenFindings counts={snippet.findingCounts} status={snippet.reviewStatus} />
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right text-[var(--muted)]">
                <time dateTime={snippet.createdAt} title={formatDate(snippet.createdAt, FULL_DATE_FORMAT)}>
                  {formatDate(snippet.createdAt, DATE_FORMAT)}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
