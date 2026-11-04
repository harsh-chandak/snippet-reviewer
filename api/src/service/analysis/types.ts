import { CATEGORIES, CodeContext, Language, SEVERITIES } from '../../model/constants';

// The shapes every static analyzer, the fix checker and the review pipeline share.
// Line numbers are 1-based and follow codeLines() (a final newline adds no line).

// "Replace lines lineStart..lineEnd (inclusive) with `replacement`." The replacement may span
// several lines, or be empty to delete them. Used by rule fixes and model fixes alike.
export interface FixReplacement {
  lineStart: number;
  lineEnd: number;
  replacement: string;
}

export interface RuleFinding {
  ruleId: string; // stable id like 'js/sql-string-concat'; the fix checker re-runs it by this id
  lineStart: number;
  lineEnd: number;
  severity: (typeof SEVERITIES)[number];
  category: (typeof CATEGORIES)[number];
  description: string;
  suggestedFix: string | null; // a sentence for the user
  fix: FixReplacement | null; // a mechanical fix, when the rule can produce one
}

export interface OutlineItem {
  kind: 'function' | 'class' | 'method' | 'statement';
  name: string; // function/class name, or the statement type for SQL ('select', 'delete', ...)
  lineStart: number;
  lineEnd: number;
}

export interface DetectedContext {
  context: CodeContext;
  signals: string[]; // why, in plain words: "imports express", "uses req and res"
}

// What one language analyzer returns for one snippet.
export interface AnalysisOutput {
  parseOk: boolean;
  parseError: string | null; // first parse error in plain words, with its line, when parseOk is false
  detected: DetectedContext;
  outline: OutlineItem[];
  findings: RuleFinding[];
}

export interface LanguageAnalyzer {
  languages: Language[];
  // Rules run for `context` (the user's choice) when given, else for the detected context.
  analyze(code: string, language: Language, context?: CodeContext): Promise<AnalysisOutput>;
  // Does this code parse? Used by the fix checker on code with a fix applied.
  parses(code: string, language: Language): Promise<{ ok: boolean; error: string | null }>;
}

// What the pipeline gets for any snippet, from analysis/index.ts.
export interface AnalysisResult extends AnalysisOutput {
  supported: boolean; // false: no analyzer for this language, so findings/outline are empty
  context: CodeContext; // the context actually used: the user's choice, else the detected one
  durationMs: number;
}
