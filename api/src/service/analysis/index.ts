import { CodeContext, Language } from '../../model/constants';
import { commonFindings } from './common';
import { javascriptAnalyzer } from './javascript';
import { pythonAnalyzer } from './python';
import { sqlAnalyzer } from './sql';
import { AnalysisResult, LanguageAnalyzer, RuleFinding } from './types';

const ANALYZERS: LanguageAnalyzer[] = [javascriptAnalyzer, pythonAnalyzer, sqlAnalyzer];

export function analyzerFor(language: Language): LanguageAnalyzer | null {
  return ANALYZERS.find((a) => a.languages.includes(language)) ?? null;
}

// Language rules first, then the language-agnostic ones, ordered by line (stable within a line).
function mergeFindings(languageFindings: RuleFinding[], common: RuleFinding[]): RuleFinding[] {
  return [...languageFindings, ...common]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.lineStart - b.f.lineStart || a.i - b.i)
    .map(({ f }) => f);
}

// The static step of a review: parse, detect the context, run the rules. Languages without an
// analyzer come back supported: false with no outline, and only the language-agnostic findings
// (hard-coded secrets); the rest of their review is model-only.
export async function analyzeSnippet(language: Language, code: string, context?: CodeContext): Promise<AnalysisResult> {
  const started = Date.now();
  const common = commonFindings(code, language);
  const analyzer = analyzerFor(language);
  if (!analyzer) {
    return {
      supported: false,
      parseOk: true,
      parseError: null,
      detected: { context: context ?? 'unknown', signals: [] },
      context: context ?? 'unknown',
      outline: [],
      findings: common,
      durationMs: Date.now() - started,
    };
  }
  const output = await analyzer.analyze(code, language, context);
  return {
    ...output,
    findings: mergeFindings(output.findings, common),
    supported: true,
    context: context ?? output.detected.context,
    durationMs: Date.now() - started,
  };
}
