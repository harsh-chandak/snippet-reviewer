import type { Severity } from '@/lib/types';
import { Badge } from './Badge';

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

const STYLES: Record<Severity, string> = {
  critical: 'border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-300',
  warning: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300',
  info: 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-300',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge className={STYLES[severity]}>{SEVERITY_LABELS[severity]}</Badge>;
}
