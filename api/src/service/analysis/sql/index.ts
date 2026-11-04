import { Parser } from 'node-sql-parser';
import { CodeContext, Language } from '../../../model/constants';
import { AnalysisOutput, LanguageAnalyzer, OutlineItem, RuleFinding } from '../types';
import { runRules } from './rules';
import { Statement, lineAt, splitStatements } from './split';

// SQL analyzer on node-sql-parser. Each statement (split on ';' by split.ts, since the parser gives
// statements no lines) is parsed as PostgreSQL, then as MySQL. The context is always 'query'.

const parser = new Parser();
const DIALECTS = ['PostgresQL', 'MySQL'] as const;

interface ParsedStatement {
  stmt: Statement;
  lineStart: number;
  lineEnd: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ast: any | null;
  // description: the finding's text when it is not the usual "does not parse" sentence.
  error: { line: number; message: string; description?: string } | null;
}

// Deepest parenthesis nesting the parser is given. node-sql-parser backtracks exponentially on
// unbalanced parentheses: 19 open ones in 35 characters ran the API out of memory (STA-1). So a
// statement whose parentheses don't balance, or nest deeper than this, is reported as
// sql/syntax-error without calling the parser.
export const MAX_PAREN_DEPTH = 8;

// Checks one statement's parentheses on the masked code (strings and comments blanked), skipping
// quoted identifiers. Returns the problem, or null when they balance within MAX_PAREN_DEPTH.
function parenProblem(code: string, masked: string, stmt: Statement): ParsedStatement['error'] {
  const opens: number[] = [];
  let quote: string | null = null;
  for (let k = stmt.start; k < stmt.end; k++) {
    const c = masked[k];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === '`') {
      quote = c;
    } else if (c === '(') {
      opens.push(k);
      if (opens.length > MAX_PAREN_DEPTH) {
        const line = lineAt(code, k);
        return {
          line,
          message: `parentheses nested more than ${MAX_PAREN_DEPTH} deep`,
          description: `This statement nests parentheses more than ${MAX_PAREN_DEPTH} deep on line ${line}, deeper than the SQL checker parses, so it was not parsed.`,
        };
      }
    } else if (c === ')') {
      if (!opens.length) return { line: lineAt(code, k), message: 'a ")" with no "(" before it' };
      opens.pop();
    }
  }
  if (opens.length) return { line: lineAt(code, opens[opens.length - 1]), message: 'a "(" that is never closed' };
  return null;
}

function parseStatement(code: string, masked: string, stmt: Statement): ParsedStatement {
  const lineStart = lineAt(code, stmt.start);
  const lineEnd = lineAt(code, stmt.end - 1);
  const parens = parenProblem(code, masked, stmt);
  if (parens) return { stmt, lineStart, lineEnd, ast: null, error: parens };
  let best: { offset: number; line: number; message: string } | null = null;
  for (const database of DIALECTS) {
    try {
      const result = parser.astify(stmt.text, { database, parseOptions: { includeLocations: true } });
      const ast = Array.isArray(result) ? result[0] : result;
      return { stmt, lineStart, lineEnd, ast: ast ?? null, error: null };
    } catch (err) {
      // Keep the error from the dialect that got furthest into the statement.
      const e = err as { location?: { start?: { offset: number; line: number } }; found?: string | null };
      const offset = e.location?.start?.offset ?? -1;
      if (!best || offset > best.offset) {
        const line = lineStart + (e.location?.start?.line ?? 1) - 1;
        const found = typeof e.found === 'string' ? e.found : null;
        best = { offset, line, message: found ? `unexpected "${found}"` : 'unexpected end of statement' };
      }
    }
  }
  return { stmt, lineStart, lineEnd, ast: null, error: { line: best!.line, message: best!.message } };
}

function statementName(p: ParsedStatement): string {
  return p.ast && typeof p.ast.type === 'string' ? p.ast.type.toLowerCase() : 'unknown';
}

function parseAll(code: string) {
  const { statements, masked } = splitStatements(code);
  return { parsed: statements.map((s) => parseStatement(code, masked, s)), masked };
}

export const sqlAnalyzer: LanguageAnalyzer = {
  languages: ['sql'],

  async analyze(code: string, _language: Language, _context?: CodeContext): Promise<AnalysisOutput> {
    const { parsed, masked } = parseAll(code);
    const outline: OutlineItem[] = parsed.map((p) => ({
      kind: 'statement',
      name: statementName(p),
      lineStart: p.lineStart,
      lineEnd: p.lineEnd,
    }));
    const types = [...new Set(parsed.filter((p) => p.ast).map(statementName))];
    const detected = {
      context: 'query' as const,
      signals: ['language is SQL', ...types.map((t) => `has ${t.toUpperCase()} statement`)],
    };

    const failed = parsed.find((p) => p.error);
    if (failed?.error) {
      const { line, message, description } = failed.error;
      return {
        parseOk: false,
        parseError: `line ${line}: ${message}`,
        detected,
        outline,
        findings: [
          {
            ruleId: 'sql/syntax-error',
            lineStart: line,
            lineEnd: line,
            severity: 'critical',
            category: 'bug',
            description: description ?? `This statement does not parse as PostgreSQL or MySQL: ${message} on line ${line}.`,
            suggestedFix: 'Fix the syntax error; the other SQL checks run once the snippet parses.',
            fix: null,
          },
        ],
      };
    }

    const findings: RuleFinding[] = parsed.flatMap((p) =>
      runRules(p.ast, { code, masked, stmt: p.stmt, lineStart: p.lineStart, lineEnd: p.lineEnd }),
    );
    findings.sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd || a.ruleId.localeCompare(b.ruleId));
    return { parseOk: true, parseError: null, detected, outline, findings };
  },

  async parses(code: string, _language: Language) {
    const failed = parseAll(code).parsed.find((p) => p.error);
    return failed?.error ? { ok: false, error: `line ${failed.error.line}: ${failed.error.message}` } : { ok: true, error: null };
  },
};
