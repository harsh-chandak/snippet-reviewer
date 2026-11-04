import { CodeContext, FindingSource, FixCheck, Language } from '../../model/constants';
import { codeLines } from '../../utils/codeLines';
import { COMMON_RULE_IDS } from './common';
import { analyzerFor, analyzeSnippet } from './index';
import { MAX_FIX_CHECKS, OVER_FIX_LIMIT_NOTE } from './limits';
import { FixReplacement, RuleFinding } from './types';

export interface FixCheckDetail {
  parses: boolean | null; // the fixed code parses; null when the language has no analyzer
  ruleCleared: boolean | null; // a rule finding's ruleId no longer fires on the fixed lines; null for model findings
  newRuleIds: string[]; // rule ids that fire more times on the fixed code than on the original
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

// A model fix may write at most this many lines beyond its finding's span.
export const MODEL_FIX_EXTRA_LINES = 10;

function lineRange(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

// The lines of `fix` that lie outside `start..end`, in words ("lines 1-2 and 5"), or null if none do.
function outsideLines(fix: FixReplacement, start: number, end: number): string | null {
  const parts: string[] = [];
  if (fix.lineStart < start) parts.push(lineRange(fix.lineStart, Math.min(fix.lineEnd, start - 1)));
  if (fix.lineEnd > end) parts.push(lineRange(Math.max(fix.lineStart, end + 1), fix.lineEnd));
  return parts.length ? parts.join(' and ') : null;
}

// The locality rule for model fixes: the fix must overlap its finding's lines and may replace at
// most the finding's span plus MODEL_FIX_EXTRA_LINES. Returns the reason it fails, or null.
function localityProblem(fix: FixReplacement, lineStart: number, lineEnd: number): string | null {
  const finding = lineRange(lineStart, lineEnd);
  const outside = outsideLines(fix, lineStart, lineEnd);
  if (fix.lineEnd < lineStart || fix.lineStart > lineEnd) {
    return `the fix does not overlap its finding (${finding}): it touches ${lineRange(fix.lineStart, fix.lineEnd)} outside the finding`;
  }
  const span = lineEnd - lineStart + 1;
  const replaced = fix.lineEnd - fix.lineStart + 1;
  if (replaced > span + MODEL_FIX_EXTRA_LINES) {
    return `the fix replaces ${replaced} lines for a finding on ${finding}, more than the finding plus ${MODEL_FIX_EXTRA_LINES}; it touches ${outside} outside the finding`;
  }
  return null;
}

// How many times each rule id fires.
function hitCounts(findings: RuleFinding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.ruleId, (counts.get(f.ruleId) ?? 0) + 1);
  return counts;
}

// Rule ids that fire more times after the fix than before: comparing hits, not ids, so a second
// eval() smuggled in next to an existing one still counts as new.
function newIssues(before: RuleFinding[], after: RuleFinding[]): string[] {
  const was = hitCounts(before);
  return [...hitCounts(after)].filter(([id, n]) => n > (was.get(id) ?? 0)).map(([id]) => id).sort();
}

const isSyntaxError = (ruleId: string) => ruleId.endsWith('/syntax-error');

// Every rule on, whatever the snippet's context: 'unknown' is the context that runs them all, so
// code a fix brings in is checked even when its rules are off for this kind of snippet.
const ALL_RULES_CONTEXT: CodeContext = 'unknown';

export type FixCheckResult = { fixCheck: FixCheck; detail: FixCheckDetail | null };

// The unfixed code's rule findings with every rule on: what each fix check compares against.
export async function analyseUnfixed(code: string, language: Language): Promise<RuleFinding[]> {
  return (await analyzeSnippet(language, code, ALL_RULES_CONTEXT)).findings;
}

// The finding a fix belongs to. lineStart/lineEnd are the finding's lines; a model fix is held to
// them (the locality rule) when they are given.
export interface FixCheckInput {
  source: FindingSource;
  ruleId: string | null;
  fix: FixReplacement | null;
  lineStart?: number;
  lineEnd?: number;
}

// Checks a finding's proposed fix mechanically: apply it, then ask the language's analyzer whether
// the result parses, whether the finding's rule still fires on the fixed lines, and whether any rule
// fires more often than before (before and after both analysed with every rule on). A model fix must
// also stay near its finding. 'passed' when every check that could run holds and nothing new fires,
// 'failed' when one doesn't, 'not_checked' when there is no fix, or no analyzer and nothing failed.
// Never throws: an analyzer error comes back as 'not_checked' with the error in the note.
// `_context` is accepted for the caller's sake and ignored: the check always runs every rule.
// `before` is the unfixed code's rule findings with every rule on (analyseUnfixed), computed once
// per review and passed to every check (the decision 'fix check budget'); without it, it is computed here.
export async function checkFix(
  finding: FixCheckInput,
  code: string,
  language: Language,
  _context?: CodeContext,
  before?: RuleFinding[],
): Promise<FixCheckResult> {
  const { fix } = finding;
  if (!fix) return { fixCheck: 'not_checked', detail: null };

  let fixed: string;
  try {
    fixed = applyFix(code, fix);
  } catch (err) {
    if (!(err instanceof FixRangeError)) throw err;
    return { fixCheck: 'failed', detail: { parses: null, ruleCleared: null, newRuleIds: [], note: err.message } };
  }

  const locality =
    finding.source === 'model' && finding.lineStart !== undefined && finding.lineEnd !== undefined
      ? localityProblem(fix, finding.lineStart, finding.lineEnd)
      : null;

  try {
    const beforeFindings = before ?? (await analyseUnfixed(code, language));
    const after = await analyzeSnippet(language, fixed, ALL_RULES_CONTEXT);

    const analyzer = analyzerFor(language);
    if (!analyzer) {
      // No parser for the language, but the language-agnostic rules (any/hardcoded-secret) still
      // run on every snippet, so a fix that adds one of their hits is failed.
      const newRuleIds = newIssues(beforeFindings, after.findings);
      const notes = [`There is no parser for ${language}, so whether the fixed code parses was not checked`];
      if (locality) notes.push(locality);
      notes.push(
        newRuleIds.length === 0
          ? `the language-agnostic rules (${COMMON_RULE_IDS.join(', ')}) find no new issues`
          : `new issues: ${newRuleIds.join(', ')}`,
      );
      const failed = newRuleIds.length > 0 || !!locality;
      return {
        fixCheck: failed ? 'failed' : 'not_checked',
        detail: { parses: null, ruleCleared: null, newRuleIds, note: `${notes.join('; ')}.` },
      };
    }

    const parsed = await analyzer.parses(fixed, language);
    const checksRule = finding.source === 'rule' && !!finding.ruleId;
    const ruleCleared = checksRule
      ? !after.findings.some((f) => f.ruleId === finding.ruleId && touchesFixedLines(f, fix))
      : null;
    // A parse failure is reported once, as parses: false, not again as a new syntax-error issue.
    const newRuleIds = newIssues(beforeFindings, after.findings).filter((id) => parsed.ok || !isSyntaxError(id));

    const passed = parsed.ok && ruleCleared !== false && newRuleIds.length === 0 && !locality;
    const notes: string[] = [];
    notes.push(
      parsed.ok
        ? 'The fixed code parses'
        : `The fixed code does not parse${parsed.error ? `: ${errorText(parsed.error).replace(/[.\s]+$/, '')}` : ''}`,
    );
    if (locality) notes.push(locality);
    if (ruleCleared === true) notes.push(`${finding.ruleId} no longer fires on the fixed lines`);
    if (ruleCleared === false) notes.push(`${finding.ruleId} still fires on the fixed lines`);
    if (parsed.ok || newRuleIds.length > 0) {
      notes.push(newRuleIds.length === 0 ? 'no new issues' : `new issues: ${newRuleIds.join(', ')}`);
    }

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

// The result for a fix that was never checked, with the reason in the note.
export function notChecked(note: string): FixCheckResult {
  return { fixCheck: 'not_checked', detail: { parses: null, ruleCleared: null, newRuleIds: [], note } };
}

// Checks a review's fixes one after another, in the order given (rule findings first, then the
// model's), reporting each result as it is known so a run cut off by the time limit keeps the
// ones it finished. Entries without a fix are skipped (null). At most MAX_FIX_CHECKS fixes are
// checked; the rest come back not_checked with OVER_FIX_LIMIT_NOTE. The unfixed code is analysed
// once, only if a fix needs it.
export async function checkFixes(
  inputs: FixCheckInput[],
  code: string,
  language: Language,
  onResult: (index: number, result: FixCheckResult | null) => void,
): Promise<void> {
  let before: RuleFinding[] | null = null;
  let checked = 0;
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    if (!input.fix) {
      onResult(i, null);
    } else if (checked >= MAX_FIX_CHECKS) {
      onResult(i, notChecked(OVER_FIX_LIMIT_NOTE));
    } else {
      checked++;
      try {
        before ??= await analyseUnfixed(code, language);
        onResult(i, await checkFix(input, code, language, undefined, before));
      } catch (err) {
        onResult(i, notChecked(`The fix could not be checked: ${errorText(err)}`));
      }
    }
  }
}
