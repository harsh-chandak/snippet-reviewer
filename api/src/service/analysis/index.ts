import { CodeContext, Language } from '../../model/constants';
import { javascriptAnalyzer } from './javascript';
import { pythonAnalyzer } from './python';
import { sqlAnalyzer } from './sql';
import { AnalysisResult, LanguageAnalyzer } from './types';

const ANALYZERS: LanguageAnalyzer[] = [javascriptAnalyzer, pythonAnalyzer, sqlAnalyzer];

export function analyzerFor(language: Language): LanguageAnalyzer | null {
  return ANALYZERS.find((a) => a.languages.includes(language)) ?? null;
}

// The static step of a review: parse, detect the context, run the rules. Languages without an
// analyzer come back supported: false with no findings, and the review is model-only.
export async function analyzeSnippet(language: Language, code: string, context?: CodeContext): Promise<AnalysisResult> {
  const started = Date.now();
  const analyzer = analyzerFor(language);
  if (!analyzer) {
    return {
      supported: false,
      parseOk: true,
      parseError: null,
      detected: { context: context ?? 'unknown', signals: [] },
      context: context ?? 'unknown',
      outline: [],
      findings: [],
      durationMs: Date.now() - started,
    };
  }
  const output = await analyzer.analyze(code, language, context);
  return { ...output, supported: true, context: context ?? output.detected.context, durationMs: Date.now() - started };
}
