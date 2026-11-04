import { Language } from '../../model/constants';
import { LanguageAnalyzer } from './types';

// Used only while a language's analyzer is being written; deleted once all three exist.
export function placeholderAnalyzer(languages: Language[]): LanguageAnalyzer {
  return {
    languages,
    async analyze() {
      return { parseOk: true, parseError: null, detected: { context: 'unknown', signals: [] }, outline: [], findings: [] };
    },
    async parses() {
      return { ok: true, error: null };
    },
  };
}
