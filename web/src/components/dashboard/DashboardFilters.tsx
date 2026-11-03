import Link from 'next/link';
import { LANGUAGES, SNIPPET_REVIEW_STATUSES, type Language, type SnippetReviewStatus } from '@/lib/types';
import { LANGUAGE_LABELS, REVIEW_STATUS_LABELS } from '@/components/shared';

export interface DashboardFilterValues {
  language?: Language;
  status?: SnippetReviewStatus;
}

const SELECT_CLASS =
  'rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-blue-500';

// The language and status selects. An empty value means "All".
export function DashboardFilters({
  filters,
  onChange,
}: {
  filters: DashboardFilterValues;
  onChange: (key: keyof DashboardFilterValues, value: string) => void;
}) {
  const hasFilters = Boolean(filters.language || filters.status);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-2">
        <label htmlFor="filter-language" className="text-sm font-medium">
          Language
        </label>
        <select
          id="filter-language"
          className={SELECT_CLASS}
          value={filters.language ?? ''}
          onChange={(e) => onChange('language', e.target.value)}
        >
          <option value="">All languages</option>
          {LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {LANGUAGE_LABELS[language]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor="filter-status" className="text-sm font-medium">
          Status
        </label>
        <select
          id="filter-status"
          className={SELECT_CLASS}
          value={filters.status ?? ''}
          onChange={(e) => onChange('status', e.target.value)}
        >
          <option value="">All statuses</option>
          {SNIPPET_REVIEW_STATUSES.map((status) => (
            <option key={status} value={status}>
              {REVIEW_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>
      {hasFilters && (
        <Link href="/" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
          Clear filters
        </Link>
      )}
    </div>
  );
}
