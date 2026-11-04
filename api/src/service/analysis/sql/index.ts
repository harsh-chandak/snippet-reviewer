import { LanguageAnalyzer } from '../types';
import { placeholderAnalyzer } from '../placeholder';

// Placeholder until the analyzer-sql unit lands: parses nothing, finds nothing.
export const sqlAnalyzer: LanguageAnalyzer = placeholderAnalyzer(['sql']);
