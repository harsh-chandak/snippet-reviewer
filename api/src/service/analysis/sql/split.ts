// Splits a SQL snippet into statements on ';' outside strings, quoted identifiers and comments,
// because node-sql-parser gives statements no line locations of its own. Also returns a mask of
// the code with every string and comment character blanked, so rules can search the code text
// without matching inside a literal.

export interface Statement {
  text: string; // the statement without its ';', trimmed of surrounding whitespace and comments
  start: number; // offset in the snippet of text[0]
  end: number; // offset in the snippet just past the statement's last character
}

export interface SplitResult {
  statements: Statement[];
  masked: string; // same length as the code; strings and comments replaced by spaces (newlines kept)
}

const DOLLAR_TAG = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y; // PostgreSQL dollar quote: $$ or $tag$

export function splitStatements(code: string): SplitResult {
  const masked = code.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (masked[k] !== '\n' && masked[k] !== '\r') masked[k] = ' ';
  };
  const statements: Statement[] = [];
  let first = -1; // offset of the current statement's first code character
  let last = -1; // offset just past its last code character
  const flush = () => {
    if (first >= 0) statements.push({ text: code.slice(first, last), start: first, end: last });
    first = -1;
    last = -1;
  };
  const mark = (from: number, to: number) => {
    if (first < 0) first = from;
    last = to;
  };

  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '-' && next === '-') {
      const end = skipToLineEnd(code, i);
      blank(i, end);
      i = end;
    } else if (c === '#' && atLineStart(code, i)) {
      // MySQL comment; only at the start of a line, since '#' is an operator in PostgreSQL
      const end = skipToLineEnd(code, i);
      blank(i, end);
      i = end;
      continue;
    } else if (c === '/' && next === '*') {
      const close = code.indexOf('*/', i + 2);
      const end = close < 0 ? code.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    } else if (c === "'" || c === '"' || c === '`') {
      const end = skipQuoted(code, i, c);
      // A quoted identifier stays in the mask; only string literals are blanked.
      if (c === "'") blank(i + 1, end - 1 > i && code[end - 1] === c ? end - 1 : end);
      mark(i, end);
      i = end;
      continue;
    } else if (c === '$') {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(code);
      if (tag) {
        const close = code.indexOf(tag[0], i + tag[0].length);
        const end = close < 0 ? code.length : close + tag[0].length;
        blank(i + tag[0].length, close < 0 ? end : close);
        mark(i, end);
        i = end;
        continue;
      }
      mark(i, i + 1);
      i++;
      continue;
    } else if (c === ';') {
      flush();
      i++;
      continue;
    } else {
      if (!/\s/.test(c)) mark(i, i + 1);
      i++;
      continue;
    }
  }
  flush();
  return { statements, masked: masked.join('') };
}

function skipToLineEnd(code: string, i: number): number {
  const nl = code.indexOf('\n', i);
  return nl < 0 ? code.length : nl;
}

function atLineStart(code: string, i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    if (code[k] === '\n') return true;
    if (code[k] !== ' ' && code[k] !== '\t' && code[k] !== '\r') return false;
  }
  return true;
}

// Returns the offset just past the closing quote. A doubled quote is an escaped quote; inside a
// single-quoted string a backslash escapes the next character (MySQL's default).
function skipQuoted(code: string, i: number, q: string): number {
  let k = i + 1;
  while (k < code.length) {
    const c = code[k];
    if (c === '\\' && q === "'") {
      k += 2;
      continue;
    }
    if (c === q) {
      if (code[k + 1] === q) {
        k += 2;
        continue;
      }
      return k + 1;
    }
    k++;
  }
  return code.length;
}

// 1-based line of an offset, counting '\n' the way codeLines() does. Line starts are cached for
// the last snippet seen, since the rules ask for many lines of the same code.
let cached: { code: string; starts: number[] } | null = null;
export function lineAt(code: string, offset: number): number {
  if (!cached || cached.code !== code) {
    const starts = [0];
    for (let k = 0; k < code.length; k++) if (code[k] === '\n') starts.push(k + 1);
    cached = { code, starts };
  }
  const { starts } = cached;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
