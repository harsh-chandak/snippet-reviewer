import Link from 'next/link';
import type { Snippet } from '@/lib/types';
import { LanguageTag, ReviewStatusBadge } from '@/components/shared';

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const FULL_DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });

function formatDate(iso: string, format: Intl.DateTimeFormat): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : format.format(date);
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
        <th scope="col" className={`${TH_CLASS} text-right`}>
          Created
        </th>
      </tr>
    </thead>
  );
}

// One row per snippet, newest first (the API already orders them).
export function SnippetTable({ snippets }: { snippets: Snippet[] }) {
  return (
    <div className={TABLE_FRAME_CLASS}>
      <table className="w-full min-w-[36rem] text-left text-sm">
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
