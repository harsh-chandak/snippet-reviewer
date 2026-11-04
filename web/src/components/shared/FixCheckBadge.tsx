import type { FixCheck, FixCheckDetail } from '@/lib/types';
import { Badge } from './Badge';

const STYLES: Record<FixCheck, string> = {
  passed: 'border-green-300 bg-green-50 text-green-800 dark:border-green-700 dark:bg-green-950 dark:text-green-300',
  failed: 'border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-300',
  not_checked: 'border-gray-300 bg-gray-50 text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300',
};

// The words on the badge. Only the checks that ran are named: a null check (no analyzer
// for the language, or "rule cleared" on an AI finding) is left out, never shown as passed.
// Only a rule finding whose rule cleared may say 'Fix checked ✓'. Nothing checks a model fix
// against its finding (ruleCleared is null), so a passing one is only partly checked.
export function fixCheckLabel(fixCheck: FixCheck, detail: FixCheckDetail | null): string {
  if (fixCheck === 'not_checked' || !detail) return 'Fix not checked';
  if (fixCheck === 'passed') {
    if (detail.ruleCleared !== true) {
      const held = [
        detail.parses === true && 'parses',
        detail.newRuleIds.length === 0 && 'no new rule issues',
        'not verified to fix the issue',
      ].filter(Boolean);
      return `Partly checked: ${held.join(' · ')}`;
    }
    const held = [
      detail.parses === true && 'parses',
      'rule cleared',
      detail.newRuleIds.length === 0 && 'no new issues',
    ].filter(Boolean);
    return `Fix checked ✓ ${held.join(' · ')}`;
  }
  const failed = [
    detail.parses === false && "doesn't parse",
    detail.ruleCleared === false && 'rule still fires',
    detail.newRuleIds.length > 0 && `new issues: ${detail.newRuleIds.join(', ')}`,
  ].filter(Boolean);
  return `Fix check failed: ${failed.length ? failed.join(' · ') : 'see detail'}`;
}

// Did the proposed fix survive a mechanical check (parses, its rule no longer fires,
// no new rule issues)? A passing model fix is labelled partly checked, never 'Fix checked ✓'. `checking` says the check has not run yet but will.
export function FixCheckBadge({
  fixCheck,
  detail,
  checking = false,
}: {
  fixCheck: FixCheck;
  detail: FixCheckDetail | null;
  checking?: boolean;
}) {
  if (checking && fixCheck === 'not_checked') {
    return <Badge className={STYLES.not_checked}>Fix not checked yet</Badge>;
  }
  return (
    // The label can be long ('Partly checked: parses · no new rule issues · not verified to fix
    // the issue'), so it wraps inside a narrow card rather than pushing past its edge.
    <Badge className={`${STYLES[fixCheck]} !whitespace-normal`} title={detail?.note || undefined}>
      {fixCheckLabel(fixCheck, detail)}
    </Badge>
  );
}
