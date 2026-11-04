import { CodeContext, FindingSource, FixCheck, Language } from '../../model/constants';
import { FixReplacement } from './types';

export interface FixCheckDetail {
  parses: boolean | null;
  ruleCleared: boolean | null;
  newRuleIds: string[];
  note: string;
}

// Placeholder until the analysis-core unit lands: applies nothing, checks nothing.
export function applyFix(code: string, _fix: FixReplacement): string {
  return code;
}

export async function checkFix(
  _finding: { source: FindingSource; ruleId: string | null; fix: FixReplacement | null },
  _code: string,
  _language: Language,
  _context?: CodeContext,
): Promise<{ fixCheck: FixCheck; detail: FixCheckDetail | null }> {
  return { fixCheck: 'not_checked', detail: null };
}
