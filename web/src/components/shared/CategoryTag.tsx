import type { Category } from '@/lib/types';
import { Badge } from './Badge';

export const CATEGORY_LABELS: Record<Category, string> = {
  bug: 'Bug',
  security: 'Security',
  performance: 'Performance',
  style: 'Style',
};

// Neutral on purpose: severity carries the colour, category is just a label.
export function CategoryTag({ category }: { category: Category }) {
  return (
    <Badge className="border-gray-300 bg-white text-gray-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300">
      {CATEGORY_LABELS[category]}
    </Badge>
  );
}
