import { codeLines } from '../../../utils/codeLines';
import { FixReplacement, RuleFinding } from '../types';
import { Statement, lineAt } from './split';

// The SQL rules. Each runs on one parsed statement and reports lines in the whole snippet.
// node-sql-parser's AST differs between dialects (and is untyped where it matters), so nodes are
// read defensively; locations exist only on some nodes, so lines fall back to a text search in the
// masked statement, then to the statement's own lines.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export const SQL_RULE_IDS = [
  'sql/syntax-error',
  'sql/update-without-where',
  'sql/delete-without-where',
  'sql/select-star',
  'sql/join-without-condition',
  'sql/not-in-subquery',
  'sql/leading-wildcard-like',
  'sql/equals-null',
  'sql/drop-or-truncate',
] as const;

export interface StatementContext {
  code: string;
  masked: string; // the whole snippet with strings and comments blanked
  stmt: Statement;
  lineStart: number;
  lineEnd: number;
}

const SKIP_KEYS = new Set(['loc', 'tableList', 'columnList']);

function walk(node: Node, visit: (n: Node) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (!SKIP_KEYS.has(key) && child && typeof child === 'object') walk(child, visit);
  }
}

// A column or table name, from either dialect's shape: 'x', {type, value: 'x'} or {expr: {value: 'x'}}.
function nameOf(v: Node): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    if (typeof v.value === 'string') return v.value;
    if (v.expr) return nameOf(v.expr);
  }
  return '';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function runRules(ast: Node, ctx: StatementContext): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const add = (
    ruleId: string,
    lines: [number, number],
    severity: RuleFinding['severity'],
    category: RuleFinding['category'],
    description: string,
    suggestedFix: string | null,
    fix: FixReplacement | null = null,
  ) => findings.push({ ruleId, lineStart: lines[0], lineEnd: lines[1], severity, category, description, suggestedFix, fix });

  const stmtLines: [number, number] = [ctx.lineStart, ctx.lineEnd];
  const nullHits: NullHit[] = [];
  const stmtMasked = ctx.masked.slice(ctx.stmt.start, ctx.stmt.end);
  const nodeLines = (n: Node): [number, number] | null => {
    const span = nodeSpan(n, ctx);
    return span ? [lineAt(ctx.code, span[0]), lineAt(ctx.code, span[1] - 1)] : null;
  };
  // Line of the first match of `re` in the masked statement, as a one-line range.
  const textLine = (re: RegExp, from = 0): [number, number] | null => {
    re.lastIndex = from;
    const m = re.exec(stmtMasked);
    if (!m) return null;
    const line = lineAt(ctx.code, ctx.stmt.start + m.index);
    return [line, line];
  };

  // `SELECT *` matches in text order, so the k-th select-star node gets the k-th match.
  const starRe = /(?:\bselect\s+(?:(?:distinct|all)\s+)?|,\s*)(?:(?:[A-Za-z_][\w$]*|"[^"]*"|`[^`]*`)\s*\.\s*)?\*/gi;
  let starFrom = 0;

  walk(ast, (n) => {
    const type = typeof n.type === 'string' ? n.type.toLowerCase() : '';

    if ((type === 'update' || type === 'delete') && 'where' in n && !n.where) {
      const verb = type.toUpperCase();
      add(
        `sql/${type}-without-where`,
        stmtLines,
        'critical',
        'bug',
        `${verb} without a WHERE clause ${type === 'update' ? 'changes' : 'removes'} every row in the table.`,
        `Add a WHERE clause that selects only the rows to ${type}; if every row really is meant, say so in a comment.`,
      );
    }

    if (type === 'drop' || type === 'truncate') {
      const what = typeof n.keyword === 'string' ? ` ${n.keyword.toUpperCase()}` : '';
      add(
        'sql/drop-or-truncate',
        stmtLines,
        'warning',
        'bug',
        `${type.toUpperCase()}${what} destroys data and cannot be rolled back on most databases.`,
        'Make sure this runs only in a migration or a reviewed maintenance script, with a backup, never from application code.',
      );
    }

    if (type === 'select' && n.columns) {
      const cols = Array.isArray(n.columns) ? n.columns : [n.columns];
      const star = n.columns === '*' || cols.some((c: Node) => c?.expr?.type === 'column_ref' && nameOf(c.expr.column) === '*');
      if (star) {
        starRe.lastIndex = starFrom;
        const m = starRe.exec(stmtMasked);
        let lines = stmtLines;
        if (m) {
          starFrom = m.index + m[0].length;
          const line = lineAt(ctx.code, ctx.stmt.start + m.index + m[0].length - 1);
          lines = [line, line];
        }
        add(
          'sql/select-star',
          lines,
          'info',
          'style',
          'SELECT * returns every column, so a column added to the table later changes what this query returns and reads more data than needed.',
          'List the columns the code actually uses.',
        );
      }
    }

    if (Array.isArray(n.from) && (type === 'select' || type === 'update' || type === 'delete')) {
      checkJoins(n, textLine, stmtLines, add);
    }

    if (type === 'binary_expr' && typeof n.operator === 'string') {
      const op = n.operator.toUpperCase();
      const lines = nodeLines(n) ?? stmtLines;

      if (op === 'NOT IN') {
        const r = n.right;
        const sub = r?.ast || r?.type === 'select' || (Array.isArray(r?.value) && r.value.some((v: Node) => v?.ast));
        if (sub) {
          add(
            'sql/not-in-subquery',
            lines,
            'warning',
            'bug',
            'NOT IN (subquery) returns no rows at all if the subquery returns a single NULL.',
            'Use NOT EXISTS (SELECT 1 ... WHERE ...) instead, or filter NULLs out of the subquery.',
          );
        }
      }

      if (/^(NOT )?I?LIKE$/.test(op)) {
        const r = n.right;
        if (typeof r?.type === 'string' && r.type.endsWith('string') && typeof r.value === 'string' && r.value.startsWith('%')) {
          add(
            'sql/leading-wildcard-like',
            lines,
            'info',
            'performance',
            `${op} with a pattern that starts with % cannot use an ordinary index, so it scans every row.`,
            'Anchor the pattern at the start if you can, or use a full-text or trigram index for substring search.',
          );
        }
      }

      if ((op === '=' || op === '<>' || op === '!=') && (n.right?.type === 'null' || n.left?.type === 'null')) {
        nullHits.push({ op, lines, edit: n.right?.type === 'null' ? equalsNullEdit(n, ctx) : null });
      }
    }
  });

  // sql/equals-null: one finding per line, whose fix rewrites every hit on that line (two fixes for
  // one line would each undo the other).
  const byLine = new Map<number, NullHit[]>();
  for (const hit of nullHits) byLine.set(hit.lines[0], [...(byLine.get(hit.lines[0]) ?? []), hit]);
  for (const [line, hits] of byLine) {
    const ops = [...new Set(hits.map((h) => h.op))];
    const uses = [...new Set(hits.map((h) => (h.op === '=' ? 'IS NULL' : 'IS NOT NULL')))];
    const several = hits.length > 1;
    add(
      'sql/equals-null',
      [line, Math.max(...hits.map((h) => h.lines[1]))],
      'warning',
      'bug',
      `Comparing with ${ops.map((o) => `${o} NULL`).join(' or ')} is never true (the result is NULL), so ${several ? 'these conditions match' : 'this condition matches'} no rows.`,
      `Use ${uses.join(' / ')}.`,
      hits.every((h) => h.edit) ? combinedFix(hits.map((h) => h.edit!), ctx) : null,
    );
  }
  return findings;
}

interface NullEdit {
  from: number; // snippet offsets of the operator through NULL
  to: number;
  insert: string;
}

interface NullHit {
  op: string;
  lines: [number, number];
  edit: NullEdit | null;
}

function checkJoins(
  n: Node,
  textLine: (re: RegExp) => [number, number] | null,
  stmtLines: [number, number],
  add: (
    ruleId: string,
    lines: [number, number],
    severity: RuleFinding['severity'],
    category: RuleFinding['category'],
    description: string,
    suggestedFix: string | null,
  ) => void,
): void {
  const items: Node[] = n.from;
  for (let i = 1; i < items.length; i++) {
    const item = items[i];
    const prev = items[i - 1];
    const table = typeof item?.table === 'string' ? item.table : null;
    const name = typeof item?.as === 'string' && item.as ? item.as : table;
    const tableRe = table ? `(?:(?:[\\w$]+|"[^"]*"|\`[^\`]*\`)\\.)?["\`]?${escapeRe(table)}\\b` : null;

    if (item?.join) {
      const kind = String(item.join).toUpperCase();
      // PostgreSQL's grammar reads "a CROSS JOIN b" as table a aliased CROSS, then a plain JOIN.
      const prevAlias = typeof prev?.as === 'string' ? prev.as.toUpperCase() : '';
      const intended = kind.includes('CROSS') || kind.includes('NATURAL') || prevAlias === 'CROSS' || prevAlias === 'NATURAL';
      if (!intended && !item.on && !(Array.isArray(item.using) && item.using.length)) {
        const lines = (tableRe && textLine(new RegExp(`\\bjoin\\s+(?:lateral\\s+)?${tableRe}`, 'gi'))) || textLine(/\bjoin\b/gi) || stmtLines;
        add(
          'sql/join-without-condition',
          lines,
          'warning',
          'bug',
          `JOIN ${table ?? 'subquery'} has no ON or USING, so every row is paired with every row of the other tables.`,
          'Add ON (or USING) with the columns that relate the tables; write CROSS JOIN if the cartesian product is intended.',
        );
      }
      continue;
    }

    // A comma join: only plain tables, since a function or subquery may refer to earlier tables.
    if (!table || !name) continue;
    if (!linkedInWhere(name, n.where)) {
      const lines = (tableRe && textLine(new RegExp(`,\\s*${tableRe}`, 'gi'))) || stmtLines;
      add(
        'sql/join-without-condition',
        lines,
        'warning',
        'bug',
        `${table} is joined with a comma but no WHERE condition relates it to the other tables, so every row is paired with every row.`,
        'Use an explicit JOIN ... ON with the columns that relate the tables.',
      );
    }
  }
}

// Is there a comparison in WHERE between a column of `name` and a column of another table?
// An unqualified column could belong to either side, so it counts (no false alarm on `a = b`).
function linkedInWhere(name: string, where: Node): boolean {
  if (!where) return false;
  const target = name.toLowerCase();
  const qualifiers = (e: Node): Set<string> => {
    const out = new Set<string>();
    walk(e, (x) => {
      if (x.type === 'column_ref') out.add(nameOf(x.table).toLowerCase());
    });
    return out;
  };
  const touches = (s: Set<string>) => s.has(target) || s.has('');
  const other = (s: Set<string>) => [...s].some((q) => q !== target);
  let linked = false;
  walk(where, (x) => {
    if (linked || x.type !== 'binary_expr' || /^(AND|OR)$/i.test(String(x.operator))) return;
    const l = qualifiers(x.left);
    const r = qualifiers(x.right);
    if (l.size && r.size && ((touches(l) && other(r)) || (touches(r) && other(l)))) linked = true;
  });
  return linked;
}

// A node's [start, end) offsets in the snippet, with trailing whitespace and comments trimmed
// (the parser's end location can run on to the next token).
function nodeSpan(n: Node, ctx: StatementContext): [number, number] | null {
  const loc = n?.loc;
  if (typeof loc?.start?.offset !== 'number' || typeof loc?.end?.offset !== 'number') return null;
  const start = ctx.stmt.start + loc.start.offset;
  let end = Math.min(ctx.stmt.start + loc.end.offset, ctx.stmt.end);
  while (end > start + 1 && /\s/.test(ctx.masked[end - 1])) end--;
  return end > start ? [start, end] : null;
}

// `x = NULL` -> `x IS NULL`, `x <> NULL` / `x != NULL` -> `x IS NOT NULL`: the edit from the
// operator to the end of NULL. Only when the parser gave the expression's location and the operator
// is found in code, not in a string or comment.
function equalsNullEdit(n: Node, ctx: StatementContext): NullEdit | null {
  const span = nodeSpan(n, ctx);
  if (!span) return null;
  const [from, to] = span;
  const m = /(<>|!=|=)\s*null$/i.exec(ctx.masked.slice(from, to));
  if (!m) return null;
  return { from: from + m.index, to, insert: m[1] === '=' ? 'IS NULL' : 'IS NOT NULL' };
}

// One fix applying every edit, on the lines the edits touch.
function combinedFix(edits: NullEdit[], ctx: StatementContext): FixReplacement | null {
  const lines = codeLines(ctx.code);
  const lineStart = Math.min(...edits.map((e) => lineAt(ctx.code, e.from)));
  const lineEnd = Math.max(...edits.map((e) => lineAt(ctx.code, e.to - 1)));
  if (lineEnd > lines.length) return null;
  // Offset of the first character of lineStart in the snippet.
  let lineOffset = 0;
  for (let k = 0; k < lineStart - 1; k++) lineOffset += lines[k].length + 1;
  let text = lines.slice(lineStart - 1, lineEnd).join('\n');
  for (const e of [...edits].sort((a, b) => b.from - a.from)) {
    text = text.slice(0, e.from - lineOffset) + e.insert + text.slice(e.to - lineOffset);
  }
  return { lineStart, lineEnd, replacement: text };
}
