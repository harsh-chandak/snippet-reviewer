import ts from 'typescript';
import { Language } from '../../../model/constants';
import { codeLines } from '../../../utils/codeLines';

// Parsing for javascript and typescript with the TypeScript compiler API.
// Line numbers are 1-based and count only '\n', the way codeLines() does. TypeScript's own line
// map also breaks on '\r', U+2028 and U+2029, so it is never used for a line number here.

export interface ParseError {
  line: number;
  message: string;
  text: string; // "Line 3: ';' expected."
}

export interface Parsed {
  code: string;
  sf: ts.SourceFile;
  nodes: ts.Node[]; // every node, in source order (pre-order), collected without recursion
  lines: string[]; // codeLines(code)
  error: ParseError | null; // the first syntax error, if any
  lineOf(pos: number): number;
  lineStartOffset(line: number): number;
  start(node: ts.Node): number;
  startLine(node: ts.Node): number;
  endLine(node: ts.Node): number;
}

const FILE_NAMES: Partial<Record<ts.ScriptKind, string>> = {
  [ts.ScriptKind.JSX]: '/snippet.jsx',
  [ts.ScriptKind.TS]: '/snippet.ts',
  [ts.ScriptKind.TSX]: '/snippet.tsx',
};

// Pre-order walk with an explicit stack, so a deeply nested expression can't overflow the call stack.
function collectNodes(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const stack: ts.Node[] = [sf];
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    const kids: ts.Node[] = [];
    node.forEachChild((child) => {
      kids.push(child); // no return value: forEachChild stops on a truthy one
    });
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

interface RawParse {
  sf: ts.SourceFile;
  diagnostics: ts.Diagnostic[];
}

// Syntactic diagnostics only (no type checking). For a .jsx file these include the JS-only checks,
// such as a type annotation in JavaScript.
function parseAs(code: string, kind: ts.ScriptKind): RawParse {
  const fileName = FILE_NAMES[kind]!;
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  const host: ts.CompilerHost = {
    getSourceFile: (f) => (f === fileName ? sf : undefined),
    getDefaultLibFileName: () => '/lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => f === fileName,
    readFile: () => undefined,
  };
  const program = ts.createProgram({
    rootNames: [fileName],
    options: { noLib: true, noResolve: true, allowJs: true, noEmit: true, jsx: ts.JsxEmit.Preserve, types: [] },
    host,
  });
  // Real syntax errors first; then the 8000-range "X can only be used in TypeScript files" ones that
  // a .jsx file adds, whose wording would hide a plain missing bracket.
  const jsOnly = (d: ts.Diagnostic) => (d.code >= 8000 && d.code < 9000 ? 1 : 0);
  const diagnostics = [...program.getSyntacticDiagnostics(program.getSourceFile(fileName) ?? sf)].sort(
    (a, b) => jsOnly(a) - jsOnly(b) || (a.start ?? 0) - (b.start ?? 0),
  );
  return { sf, diagnostics };
}

const LOOKS_LIKE_JSX = /<\/[A-Za-z]|\/>/;

// TypeScript is parsed as .ts, and as .tsx when that is the one that parses (or, when neither does,
// when the code looks like JSX). JavaScript is always parsed with JSX allowed.
function parseRaw(code: string, language: Language): RawParse {
  if (language !== 'typescript') return parseAs(code, ts.ScriptKind.JSX);
  const asTs = parseAs(code, ts.ScriptKind.TS);
  if (asTs.diagnostics.length === 0) return asTs;
  const asTsx = parseAs(code, ts.ScriptKind.TSX);
  if (asTsx.diagnostics.length === 0) return asTsx;
  return LOOKS_LIKE_JSX.test(code) ? asTsx : asTs;
}

function lineIndex(code: string, lineCount: number) {
  const newlines: number[] = [];
  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) newlines.push(i);
  // Line of an offset = 1 + the number of '\n' before it, clamped to the lines codeLines() counts.
  const lineOf = (pos: number): number => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid] < pos) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(Math.max(lo + 1, 1), lineCount);
  };
  const lineStartOffset = (line: number): number => (line <= 1 ? 0 : newlines[line - 2] + 1);
  return { lineOf, lineStartOffset };
}

export function parseSnippet(code: string, language: Language): Parsed {
  const lines = codeLines(code);
  const { lineOf, lineStartOffset } = lineIndex(code, lines.length);
  let raw: RawParse;
  let nodes: ts.Node[];
  let error: ParseError | null = null;
  try {
    raw = parseRaw(code, language);
    nodes = collectNodes(raw.sf);
    const first = raw.diagnostics[0];
    if (first) {
      const line = lineOf(first.start ?? 0);
      const message = ts.flattenDiagnosticMessageText(first.messageText, ' ');
      error = { line, message, text: `Line ${line}: ${message}` };
    }
  } catch (err) {
    // The compiler recurses while parsing; code nested thousands of levels deep overflows the stack.
    if (!(err instanceof RangeError)) throw err;
    raw = { sf: ts.createSourceFile('/empty.jsx', '', ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX), diagnostics: [] };
    nodes = [raw.sf];
    const message = 'the code is nested too deeply to be parsed';
    error = { line: 1, message, text: `Line 1: ${message}` };
  }
  const sf = raw.sf;
  const start = (node: ts.Node) => node.getStart(sf);
  return {
    code,
    sf,
    nodes,
    lines,
    error,
    lineOf,
    lineStartOffset,
    start,
    startLine: (node) => lineOf(start(node)),
    endLine: (node) => lineOf(Math.max(start(node), node.getEnd() - 1)),
  };
}
