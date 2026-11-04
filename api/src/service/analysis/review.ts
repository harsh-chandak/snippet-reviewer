import { CodeContext, Language } from '../../model/constants';
import { analyzeSnippet } from './index';
import { AnalysisResult, RuleFinding } from './types';

// The same rule hit, found by both runs of the analyzer.
const ruleKey = (f: RuleFinding) => `${f.ruleId}:${f.lineStart}`;

// The static step of a review (run in the worker, see ./guard.ts). A user-set context can add
// rules, never remove them (the decision 'user context and rules'): when it differs from the
// detected one, the rules run for both contexts and the findings are merged, one per
// (ruleId, lineStart), in line order. The result's context is the user's choice; its detected
// signals are what detection saw.
export async function analyzeForReview(language: Language, code: string, userContext: CodeContext | null): Promise<AnalysisResult> {
  const chosen = await analyzeSnippet(language, code, userContext ?? undefined);
  if (!userContext || userContext === chosen.detected.context) return chosen;
  const detected = await analyzeSnippet(language, code);
  const seen = new Set(chosen.findings.map(ruleKey));
  const findings = [...chosen.findings, ...detected.findings.filter((f) => !seen.has(ruleKey(f)))]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.lineStart - b.f.lineStart || a.i - b.i)
    .map(({ f }) => f);
  return { ...chosen, findings, durationMs: chosen.durationMs + detected.durationMs };
}
