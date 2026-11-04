import type { FindingSource } from '@/lib/types';
import { Badge } from './Badge';

export const SOURCE_LABELS: Record<FindingSource, string> = {
  rule: 'Rule',
  model: 'AI',
};

const STYLES: Record<FindingSource, string> = {
  rule: 'border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-300',
  model: 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-300',
};

// Who raised a finding: a deterministic rule (with its id on hover) or the model.
export function SourceBadge({ source, ruleId }: { source: FindingSource; ruleId?: string | null }) {
  const title =
    source === 'rule'
      ? `Found by a static rule${ruleId ? ` (${ruleId})` : ''}: exact, no model involved`
      : 'Found by the AI model';
  return (
    <Badge className={STYLES[source]} title={title}>
      {SOURCE_LABELS[source]}
    </Badge>
  );
}
