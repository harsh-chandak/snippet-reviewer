'use client';

import { Suspense } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { LANGUAGES, SNIPPET_REVIEW_STATUSES, type Language, type SnippetReviewStatus } from '@/lib/types';
import { SnippetDashboard, SnippetTableSkeleton, type DashboardFilterValues } from '@/components/dashboard';

function isLanguage(value: string | null): value is Language {
  return value !== null && (LANGUAGES as readonly string[]).includes(value);
}

function isReviewStatus(value: string | null): value is SnippetReviewStatus {
  return value !== null && (SNIPPET_REVIEW_STATUSES as readonly string[]).includes(value);
}

// The filters live in the URL (?language=&status=) so a reload or a shared link keeps them.
// Unknown values are ignored and read as "All".
function DashboardFromUrl() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const rawLanguage = searchParams.get('language');
  const rawStatus = searchParams.get('status');
  const filters: DashboardFilterValues = {
    language: isLanguage(rawLanguage) ? rawLanguage : undefined,
    status: isReviewStatus(rawStatus) ? rawStatus : undefined,
  };

  const setFilter = (key: keyof DashboardFilterValues, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return <SnippetDashboard filters={filters} onFilterChange={setFilter} />;
}

// useSearchParams needs a Suspense boundary for the production build.
export default function DashboardPage() {
  return (
    <Suspense fallback={<SnippetTableSkeleton />}>
      <DashboardFromUrl />
    </Suspense>
  );
}
