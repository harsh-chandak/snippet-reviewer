import { LanguageAnalyzer } from '../types';
import { placeholderAnalyzer } from '../placeholder';

// Placeholder until the analyzer-js unit lands: parses nothing, finds nothing.
export const javascriptAnalyzer: LanguageAnalyzer = placeholderAnalyzer(['javascript', 'typescript']);
