import type { SnippetReviewStatus } from '@/lib/types';
import { Badge } from './Badge';

export const REVIEW_STATUS_LABELS: Record<SnippetReviewStatus, string> = {
  not_reviewed: 'Not reviewed',
  in_progress: 'In progress',
  reviewed: 'Reviewed',
  failed: 'Failed',
};

const STYLES: Record<SnippetReviewStatus, string> = {
  not_reviewed: 'border-gray-300 bg-gray-50 text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300',
  in_progress: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300',
  reviewed: 'border-green-300 bg-green-50 text-green-800 dark:border-green-700 dark:bg-green-950 dark:text-green-300',
  failed: 'border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-300',
};

const DOTS: Record<SnippetReviewStatus, string> = {
  not_reviewed: 'bg-gray-400',
  in_progress: 'bg-amber-500 animate-pulse',
  reviewed: 'bg-green-500',
  failed: 'bg-red-500',
};

export function ReviewStatusBadge({ status }: { status: SnippetReviewStatus }) {
  return (
    <Badge className={STYLES[status]}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DOTS[status]}`} />
      {REVIEW_STATUS_LABELS[status]}
    </Badge>
  );
}
