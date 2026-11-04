import { CodeContext, Language } from '../../../model/constants';
import { AnalysisOutput, LanguageAnalyzer } from '../types';
import { detectContext } from './context';
import { buildOutline } from './outline';
import { parseSnippet } from './parse';
import { runRules, syntaxErrorFinding } from './rules';

// The javascript and typescript (incl. JSX) analyzer, on the TypeScript compiler API.
// Code that doesn't parse gets one finding, js/syntax-error, and no other rule runs on it;
// the context and outline are still read from the recovered tree.
export const javascriptAnalyzer: LanguageAnalyzer = {
  languages: ['javascript', 'typescript'],

  async analyze(code: string, language: Language, context?: CodeContext): Promise<AnalysisOutput> {
    const parsed = parseSnippet(code, language);
    const detected = detectContext(parsed);
    const outline = buildOutline(parsed);
    if (parsed.error) {
      return { parseOk: false, parseError: parsed.error.text, detected, outline, findings: [syntaxErrorFinding(parsed)] };
    }
    return { parseOk: true, parseError: null, detected, outline, findings: runRules(parsed, context ?? detected.context) };
  },

  async parses(code: string, language: Language) {
    const { error } = parseSnippet(code, language);
    return error ? { ok: false, error: error.text } : { ok: true, error: null };
  },
};
