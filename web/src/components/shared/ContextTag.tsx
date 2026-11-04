import type { CodeContext } from '@/lib/types';
import { Badge } from './Badge';

export const CONTEXT_LABELS: Record<CodeContext, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  script: 'Script',
  test: 'Test',
  query: 'Query',
  unknown: 'Unknown',
};

export function ContextTag({ context, title }: { context: CodeContext; title?: string }) {
  return (
    <Badge
      title={title}
      className="border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-700 dark:bg-teal-950 dark:text-teal-300"
    >
      {CONTEXT_LABELS[context]}
    </Badge>
  );
}
