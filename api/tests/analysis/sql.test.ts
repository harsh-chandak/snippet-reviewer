import { describe, expect, it } from 'vitest';
import { sqlAnalyzer } from '../../src/service/analysis/sql';
import { SQL_RULE_IDS } from '../../src/service/analysis/sql/rules';
import { splitStatements } from '../../src/service/analysis/sql/split';
import { FixReplacement } from '../../src/service/analysis/types';
import { codeLines } from '../../src/utils/codeLines';

// The SQL analyzer is pure (no database), so these tests call it directly.

const analyze = (code: string) => sqlAnalyzer.analyze(code, 'sql');
const ids = async (code: string) => (await analyze(code)).findings.map((f) => f.ruleId);
const only = async (code: string, ruleId: string) => (await analyze(code)).findings.filter((f) => f.ruleId === ruleId);

function applyFix(code: string, fix: FixReplacement): string {
  const lines = codeLines(code);
  return [...lines.slice(0, fix.lineStart - 1), ...fix.replacement.split('\n'), ...lines.slice(fix.lineEnd)].join('\n');
}

describe('sql analyzer: shape', () => {
  it('is registered for sql and exports the rule ids it ships', () => {
    expect(sqlAnalyzer.languages).toEqual(['sql']);
    for (const id of SQL_RULE_IDS) expect(id).toMatch(/^sql\/[a-z]+(-[a-z]+)*$/);
  });

  it('always detects the query context, with signals naming the statement types', async () => {
    const out = await analyze('SELECT id FROM a;\nDELETE FROM b WHERE id = 1;\nSELECT 1;');
    expect(out.detected).toEqual({
      context: 'query',
      signals: ['language is SQL', 'has SELECT statement', 'has DELETE statement'],
    });
    expect((await analyze('')).detected).toEqual({ context: 'query', signals: ['language is SQL'] });
  });

  it('still runs the rules when the user sets another context', async () => {
    const out = await sqlAnalyzer.analyze('DELETE FROM a', 'sql', 'backend');
    expect(out.detected.context).toBe('query');
    expect(out.findings.map((f) => f.ruleId)).toEqual(['sql/delete-without-where']);
  });

  it('outlines one item per statement with 1-based lines', async () => {
    const code = '-- header comment\nSELECT id\nFROM a\nWHERE id = 1;\n\nUPDATE a\n  SET x = 1\n  WHERE id = 2;\nINSERT INTO a (x) VALUES (1)\n';
    const out = await analyze(code);
    expect(out.parseOk).toBe(true);
    expect(out.outline).toEqual([
      { kind: 'statement', name: 'select', lineStart: 2, lineEnd: 4 },
      { kind: 'statement', name: 'update', lineStart: 6, lineEnd: 8 },
      { kind: 'statement', name: 'insert', lineStart: 9, lineEnd: 9 },
    ]);
    expect(out.findings).toEqual([]);
  });

  it('a clean query has no findings', async () => {
    const out = await analyze('SELECT u.id, u.name\nFROM users u\nJOIN orders o ON o.user_id = u.id\nWHERE u.name LIKE $1');
    expect(out).toMatchObject({ parseOk: true, parseError: null, findings: [] });
  });
});

describe('sql analyzer: statement splitting', () => {
  it('does not split on ; inside strings, quoted identifiers, comments or dollar quotes', () => {
    const code = [
      "SELECT 'a;b', \"c;d\", `e;f` FROM t; -- x; y",
      '/* a; b */ SELECT $$ ; $$, $tag$ ; $tag$;',
      "SELECT 'it''s; fine'",
    ].join('\n');
    const { statements } = splitStatements(code);
    expect(statements.map((s) => s.text)).toEqual([
      "SELECT 'a;b', \"c;d\", `e;f` FROM t",
      'SELECT $$ ; $$, $tag$ ; $tag$',
      "SELECT 'it''s; fine'",
    ]);
  });

  it('masks strings and comments but keeps lengths and newlines', () => {
    const code = "SELECT 'x = NULL' -- = NULL\nFROM t";
    const { masked } = splitStatements(code);
    expect(masked.length).toBe(code.length);
    expect(masked).not.toMatch(/NULL/);
    expect(masked.split('\n')[1]).toBe('FROM t');
  });

  it('ignores empty statements and comment-only snippets', async () => {
    expect((await analyze(';;\n-- only a comment\n')).outline).toEqual([]);
  });
});

describe('sql analyzer: syntax errors', () => {
  it('reports one sql/syntax-error at the line of the error, and no other findings', async () => {
    const out = await analyze('SELECT * FROM a;\nDELETE FROM b;\nSELECT x\nFROM t WHERE');
    expect(out.parseOk).toBe(false);
    expect(out.parseError).toMatch(/^line 4: /);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      ruleId: 'sql/syntax-error',
      lineStart: 4,
      lineEnd: 4,
      severity: 'critical',
      category: 'bug',
      fix: null,
    });
    expect(out.outline.map((o) => o.name)).toEqual(['select', 'delete', 'unknown']);
  });

  it('names the unexpected token', async () => {
    const out = await analyze('SELEC x FROM t');
    expect(out.parseError).toBe('line 1: unexpected "x"');
  });

  it('accepts MySQL-only syntax when PostgreSQL rejects it', async () => {
    const out = await analyze('SELECT `id` FROM a LIMIT 1, 2');
    expect(out.parseOk).toBe(true);
  });

  it('parses() agrees with analyze()', async () => {
    expect(await sqlAnalyzer.parses('SELECT 1; SELECT 2', 'sql')).toEqual({ ok: true, error: null });
    expect(await sqlAnalyzer.parses('SELECT 1;\nSELECT FROM WHERE', 'sql')).toMatchObject({ ok: false, error: expect.stringMatching(/^line 2: /) });
  });
});

describe('sql analyzer: rules', () => {
  it('sql/update-without-where and sql/delete-without-where are critical bugs on the statement lines', async () => {
    const out = await analyze('UPDATE users\nSET active = false;\nDELETE FROM logs;\nDELETE FROM logs WHERE id = 1;\nUPDATE users SET a = 1 WHERE id = 2');
    expect(out.findings.map((f) => [f.ruleId, f.lineStart, f.lineEnd, f.severity, f.category])).toEqual([
      ['sql/update-without-where', 1, 2, 'critical', 'bug'],
      ['sql/delete-without-where', 3, 3, 'critical', 'bug'],
    ]);
  });

  it('sql/select-star is style info on the line of the *, including t.* and subqueries', async () => {
    const out = await only('SELECT id\nFROM a\nWHERE id IN (\n  SELECT * FROM b\n);\nSELECT a.*\nFROM a', 'sql/select-star');
    expect(out.map((f) => [f.lineStart, f.severity, f.category])).toEqual([
      [4, 'info', 'style'],
      [6, 'info', 'style'],
    ]);
    expect(await ids('SELECT count(*) FROM a')).toEqual([]);
  });

  it('sql/join-without-condition: a JOIN with no ON or USING', async () => {
    const out = await only('SELECT u.id\nFROM users u\nJOIN orders o\nWHERE u.id = 1', 'sql/join-without-condition');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ lineStart: 3, lineEnd: 3, severity: 'warning', category: 'bug' });
    expect(await ids('SELECT 1 FROM a JOIN b USING (id)')).toEqual([]);
    expect(await ids('SELECT 1 FROM a JOIN b ON a.id = b.a_id')).toEqual([]);
  });

  it('sql/join-without-condition: CROSS and NATURAL joins are intended', async () => {
    expect(await ids('SELECT 1 FROM a CROSS JOIN b')).toEqual([]);
    expect(await ids('SELECT 1 FROM a NATURAL JOIN b')).toEqual([]);
  });

  it('sql/join-without-condition: a comma join that WHERE does not relate', async () => {
    const out = await only('SELECT a.x\nFROM a,\n  b\nWHERE a.id = 1', 'sql/join-without-condition');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ lineStart: 2, severity: 'warning', category: 'bug' });
    expect(await ids('SELECT a.x FROM a, b')).toEqual(['sql/join-without-condition']);
    expect(await ids('SELECT a.x FROM a, b WHERE a.id = b.a_id')).toEqual([]);
    expect(await ids('SELECT x FROM a t1, b t2 WHERE t2.a_id = t1.id AND t1.x > 3')).toEqual([]);
    // Unqualified columns could belong to either table: no false alarm.
    expect(await ids('SELECT x FROM a, b WHERE a_id = id')).toEqual([]);
  });

  it('sql/not-in-subquery is a bug warning; NOT IN a literal list is fine', async () => {
    const out = await analyze('SELECT id FROM users\nWHERE id NOT IN (SELECT user_id FROM bans)');
    expect(out.findings.map((f) => [f.ruleId, f.lineStart, f.severity, f.category])).toEqual([
      ['sql/not-in-subquery', 2, 'warning', 'bug'],
    ]);
    expect(await ids('SELECT id FROM users WHERE id NOT IN (1, 2, 3)')).toEqual([]);
  });

  it('sql/leading-wildcard-like is performance info for LIKE, ILIKE and NOT LIKE with a leading %', async () => {
    const out = await analyze("SELECT id FROM a\nWHERE name LIKE '%bob'\n  OR name ILIKE '%x%'\n  OR name NOT LIKE '%y'\n  OR name LIKE 'bob%'");
    expect(out.findings.map((f) => [f.ruleId, f.lineStart, f.severity, f.category])).toEqual([
      ['sql/leading-wildcard-like', 2, 'info', 'performance'],
      ['sql/leading-wildcard-like', 3, 'info', 'performance'],
      ['sql/leading-wildcard-like', 4, 'info', 'performance'],
    ]);
  });

  it('sql/drop-or-truncate is a bug warning', async () => {
    const out = await analyze('DROP TABLE users;\nTRUNCATE TABLE logs;\nDROP INDEX idx_a');
    expect(out.findings.map((f) => [f.ruleId, f.lineStart, f.severity, f.category])).toEqual([
      ['sql/drop-or-truncate', 1, 'warning', 'bug'],
      ['sql/drop-or-truncate', 2, 'warning', 'bug'],
      ['sql/drop-or-truncate', 3, 'warning', 'bug'],
    ]);
  });

  it('reports the line in the whole snippet for a statement that starts lower down', async () => {
    const out = await analyze('SELECT id FROM a WHERE id = 1;\n\n\nSELECT id\nFROM b\nWHERE name LIKE \'%z\'');
    expect(out.findings.map((f) => [f.ruleId, f.lineStart])).toEqual([['sql/leading-wildcard-like', 6]]);
  });

  it('does not see rules inside strings or comments', async () => {
    expect(await ids("SELECT 'DELETE FROM a' AS q FROM t WHERE id = 1 -- SELECT * FROM x")).toEqual([]);
  });
});

describe('sql analyzer: sql/equals-null and its mechanical fix', () => {
  it('flags = NULL, <> NULL and != NULL as bug warnings', async () => {
    const out = await analyze('SELECT x FROM t\nWHERE deleted_at = NULL\n  OR y <> null\n  OR z != NULL');
    expect(out.findings.map((f) => [f.ruleId, f.lineStart, f.lineEnd, f.severity, f.category])).toEqual([
      ['sql/equals-null', 2, 2, 'warning', 'bug'],
      ['sql/equals-null', 3, 3, 'warning', 'bug'],
      ['sql/equals-null', 4, 4, 'warning', 'bug'],
    ]);
    expect(out.findings.map((f) => f.fix)).toEqual([
      { lineStart: 2, lineEnd: 2, replacement: 'WHERE deleted_at IS NULL' },
      { lineStart: 3, lineEnd: 3, replacement: '  OR y IS NOT NULL' },
      { lineStart: 4, lineEnd: 4, replacement: '  OR z IS NOT NULL' },
    ]);
    expect(await ids('SELECT x FROM t WHERE a IS NULL AND b IS NOT NULL')).toEqual([]);
  });

  it('the fix keeps the rest of the line, parses, and clears the rule without adding another', async () => {
    const code = "SELECT id FROM t WHERE (a = NULL) AND b = 'c = NULL' -- trailing\nORDER BY id\n";
    const [f] = await only(code, 'sql/equals-null');
    expect(f.fix).toEqual({
      lineStart: 1,
      lineEnd: 1,
      replacement: "SELECT id FROM t WHERE (a IS NULL) AND b = 'c = NULL' -- trailing",
    });
    const fixed = applyFix(code, f.fix!);
    expect(await sqlAnalyzer.parses(fixed, 'sql')).toEqual({ ok: true, error: null });
    expect(await ids(fixed)).toEqual([]);
  });

  it('NULL on the left is flagged without a mechanical fix', async () => {
    const [f] = await only('SELECT x FROM t WHERE NULL = x', 'sql/equals-null');
    expect(f.fix).toBeNull();
  });

  it('works with CRLF line endings', async () => {
    const code = 'SELECT x\r\nFROM t\r\nWHERE a = NULL\r\nORDER BY x\r\n';
    const [f] = await only(code, 'sql/equals-null');
    expect(f).toMatchObject({ lineStart: 3, lineEnd: 3 });
    expect(f.fix).toEqual({ lineStart: 3, lineEnd: 3, replacement: 'WHERE a IS NULL\r' });
  });
});
