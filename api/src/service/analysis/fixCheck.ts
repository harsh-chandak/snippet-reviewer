import { CodeContext, FindingSource, FixCheck, Language } from '../../model/constants';
import { codeLines } from '../../utils/codeLines';
import { analyzerFor, analyzeSnippet } from './index';
import { FixReplacement, RuleFinding } from './types';

export interface FixCheckDetail {
  parses: boolean | null; // the fixed code parses; null when the language has no analyzer
  ruleCleared: boolean | null; // a rule finding's ruleId no longer fires on the fixed lines; null for model findings
  newRuleIds: string[]; // rule ids that fire on the fixed code but did not fire on the original
  note: string; // the result in plain words, for the page
}

// Thrown by applyFix when the fix's lines are not lines of the snippet.
export class FixRangeError extends RangeError {}

function validRange(fix: FixReplacement, lineCount: number): boolean {
  return (
    Number.isInteger(fix.lineStart) &&
    Number.isInteger(fix.lineEnd) &&
    fix.lineStart >= 1 &&
    fix.lineEnd >= fix.lineStart &&
    fix.lineEnd <= lineCount
  );
}

// The lines a replacement puts in: an empty replacement deletes, otherwise its lines as codeLines
// counts them (so "x = 1\n" is one line, the same as "x = 1").
function replacementLines(replacement: string): string[] {
  return replacement === '' ? [] : codeLines(replacement);
}

// Replaces lines lineStart..lineEnd (1-based, inclusive, as codeLines counts them) with the
// replacement. A final newline on the snippet is kept. Throws FixRangeError for lines outside the snippet.
export function applyFix(code: string, fix: FixReplacement): string {
  const lines = codeLines(code);
  if (!validRange(fix, lines.length)) {
    throw new FixRangeError(
      `The fix replaces lines ${fix.lineStart}-${fix.lineEnd}, but the snippet has ${lines.length} line${lines.length === 1 ? '' : 's'}.`,
    );
  }
  const finalNewline = /\r?\n$/.exec(code)?.[0] ?? '';
  const fixed = [...lines.slice(0, fix.lineStart - 1), ...replacementLines(fix.replacement), ...lines.slice(fix.lineEnd)];
  return fixed.join('\n') + finalNewline;
}

// Does a finding touch the lines the fix wrote? In the fixed code those are
// lineStart..lineStart+n-1 for n replacement lines; for a deletion (n = 0) a finding touches the
// fix only if it spans the point where the lines were removed.
function touchesFixedLines(f: RuleFinding, fix: FixReplacement): boolean {
  const start = fix.lineStart;
  const end = fix.lineStart + replacementLines(fix.replacement).length - 1;
  return f.lineStart <= end && f.lineEnd >= start;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 300);
}

// Checks a finding's proposed fix mechanically: apply it, then ask the language's analyzer whether
// the result parses, whether the finding's rule still fires on the fixed lines, and whether any rule
// fires that didn't before. 'passed' when every check that could run holds and nothing new fires,
// 'failed' when one doesn't, 'not_checked' when there is no fix or no analyzer for the language.
// Never throws: an analyzer error comes back as 'not_checked' with the error in the note.
export async function checkFix(
  finding: { source: FindingSource; ruleId: string | null; fix: FixReplacement | null },
  code: string,
  language: Language,
  context?: CodeContext,
): Promise<{ fixCheck: FixCheck; detail: FixCheckDetail | null }> {
  const { fix } = finding;
  if (!fix) return { fixCheck: 'not_checked', detail: null };

  const analyzer = analyzerFor(language);
  if (!analyzer) {
    return {
      fixCheck: 'not_checked',
      detail: {
        parses: null,
        ruleCleared: null,
        newRuleIds: [],
        note: `There are no static rules for ${language}, so this fix could not be checked.`,
      },
    };
  }

  let fixed: string;
  try {
    fixed = applyFix(code, fix);
  } catch (err) {
    if (!(err instanceof FixRangeError)) throw err;
    return { fixCheck: 'failed', detail: { parses: null, ruleCleared: null, newRuleIds: [], note: err.message } };
  }

  try {
    const parsed = await analyzer.parses(fixed, language);
    const [before, after] = await Promise.all([
      analyzeSnippet(language, code, context),
      analyzeSnippet(language, fixed, context),
    ]);

    const checksRule = finding.source === 'rule' && !!finding.ruleId;
    const ruleCleared = checksRule
      ? !after.findings.some((f) => f.ruleId === finding.ruleId && touchesFixedLines(f, fix))
      : null;
    const beforeIds = new Set(before.findings.map((f) => f.ruleId));
    const newRuleIds = [...new Set(after.findings.map((f) => f.ruleId))].filter((id) => !beforeIds.has(id)).sort();

    const passed = parsed.ok && ruleCleared !== false && newRuleIds.length === 0;
    const notes: string[] = [];
    notes.push(parsed.ok ? 'The fixed code parses' : `The fixed code does not parse${parsed.error ? `: ${errorText(parsed.error)}` : ''}`);
    if (ruleCleared === true) notes.push(`${finding.ruleId} no longer fires on the fixed lines`);
    if (ruleCleared === false) notes.push(`${finding.ruleId} still fires on the fixed lines`);
    notes.push(newRuleIds.length === 0 ? 'no new issues' : `new issues: ${newRuleIds.join(', ')}`);

    return {
      fixCheck: passed ? 'passed' : 'failed',
      detail: { parses: parsed.ok, ruleCleared, newRuleIds, note: `${notes.join('; ')}.` },
    };
  } catch (err) {
    return {
      fixCheck: 'not_checked',
      detail: {
        parses: null,
        ruleCleared: null,
        newRuleIds: [],
        note: `The fix could not be checked: ${errorText(err)}`,
      },
    };
  }
}
