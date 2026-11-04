import { LanguageAnalyzer } from '../types';
import { placeholderAnalyzer } from '../placeholder';

// Placeholder until the analyzer-python unit lands: parses nothing, finds nothing.
export const pythonAnalyzer: LanguageAnalyzer = placeholderAnalyzer(['python']);
