import Link from 'next/link';

const BOX_CLASS =
  'rounded-md border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-12 text-center';

// No snippets exist yet.
export function NoSnippets() {
  return (
    <div className={BOX_CLASS}>
      <h2 className="text-base font-semibold">No snippets yet</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">Paste some code and get an AI review of it.</p>
      <Link
        href="/snippets/new"
        className="mt-4 inline-block rounded-md border border-green-700 bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 dark:border-green-600 dark:bg-green-700 dark:hover:bg-green-600"
      >
        Create a snippet
      </Link>
    </div>
  );
}

// Snippets exist, but none match the selected filters.
export function NoMatches() {
  return (
    <div className={BOX_CLASS}>
      <h2 className="text-base font-semibold">No snippets match these filters</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">Try another language or status.</p>
      <Link href="/" className="mt-4 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400">
        Clear filters
      </Link>
    </div>
  );
}
