import { describe, expect, it } from 'vitest';
import { pythonAnalyzer } from '../../src/service/analysis/python';
import { FixReplacement, RuleFinding } from '../../src/service/analysis/types';
import { codeLines } from '../../src/utils/codeLines';

// The Python analyzer on its own: no database, no model. Snippets are joined from lines so the
// expected line numbers can be read straight off the arrays.

const py = (...lines: string[]) => lines.join('\n');
const analyze = (code: string, context?: Parameters<typeof pythonAnalyzer.analyze>[2]) =>
  pythonAnalyzer.analyze(code, 'python', context);
const ids = (findings: RuleFinding[]) => findings.map((f) => f.ruleId);
const only = async (code: string, ruleId: string) => (await analyze(code)).findings.filter((f) => f.ruleId === ruleId);

// Replace lines lineStart..lineEnd with the replacement, the way the fix checker does.
function applyFix(code: string, fix: FixReplacement): string {
  const lines = codeLines(code);
  lines.splice(fix.lineStart - 1, fix.lineEnd - fix.lineStart + 1, ...(fix.replacement === '' ? [] : fix.replacement.split('\n')));
  return lines.join('\n');
}

describe('pythonAnalyzer shape', () => {
  it('handles python only and is exported under the agreed name', () => {
    expect(pythonAnalyzer.languages).toEqual(['python']);
  });

  it('returns no findings for clean code', async () => {
    const out = await analyze(py('def add(a, b):', '    return a + b'));
    expect(out).toMatchObject({ parseOk: true, parseError: null, findings: [] });
  });

  it('initialises the parser once even when many snippets arrive at the same time', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => analyze(`x${i} = eval(y)`)));
    expect(results.every((r) => r.findings.length === 1 && r.findings[0].ruleId === 'py/eval-exec')).toBe(true);
  });
});

describe('syntax errors', () => {
  it('a snippet that does not parse gets exactly one py/syntax-error finding at the error line', async () => {
    const out = await analyze(py('import os', 'x = eval(y)', 'def f(:', '    pass'));
    expect(out.parseOk).toBe(false);
    expect(out.parseError).toMatch(/line 3/);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      ruleId: 'py/syntax-error',
      lineStart: 3,
      lineEnd: 3,
      severity: 'critical',
      category: 'bug',
    });
  });

  it('Python 2 print and exec statements are syntax errors (the grammar accepts them, Python 3 does not)', async () => {
    const out = await analyze(py('x = 1', 'print "hello"', 'exec "y = 2"'));
    expect(out.parseOk).toBe(false);
    expect(out.parseError).toBe('Syntax error on line 2: Python 2 print statement; Python 3 needs print(...)');
    expect(out.findings.map((f) => [f.ruleId, f.lineStart])).toEqual([['py/syntax-error', 2]]);
    expect((await pythonAnalyzer.parses('exec "y = 2"', 'python')).ok).toBe(false);
    expect((await analyze(py('print("hello")', 'exec(code)'))).parseOk).toBe(true);
  });

  it('parses() says whether code parses, with the error in plain words', async () => {
    expect(await pythonAnalyzer.parses('x = 1\n', 'python')).toEqual({ ok: true, error: null });
    const bad = await pythonAnalyzer.parses(py('a = 1', 'b = (2,'), 'python');
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/^Syntax error on line 2/);
  });
});

describe('security rules', () => {
  it('py/eval-exec: eval and exec are critical security findings', async () => {
    const out = await analyze(py('a = eval(data)', 'exec(code)', 'b = literal_eval(data)'));
    expect(out.findings.map((f) => [f.ruleId, f.lineStart, f.severity, f.category])).toEqual([
      ['py/eval-exec', 1, 'critical', 'security'],
      ['py/eval-exec', 2, 'critical', 'security'],
    ]);
  });

  it('py/eval-exec: a function imported under the name eval is not the builtin', async () => {
    expect(await only(py('from mylib import eval', 'eval(x)'), 'py/eval-exec')).toEqual([]);
  });

  it('py/subprocess-shell-true: flags shell=True through module, alias and from-import', async () => {
    const code = py(
      'import subprocess',
      'import subprocess as sp',
      'from subprocess import Popen',
      'subprocess.run(cmd, shell=True)',
      'sp.check_output(cmd, shell=True)',
      'Popen(cmd, shell=True)',
      'subprocess.run(["ls", path])',
      'subprocess.run(cmd, shell=False)',
    );
    const found = await only(code, 'py/subprocess-shell-true');
    expect(found.map((f) => [f.lineStart, f.severity, f.category])).toEqual([
      [4, 'critical', 'security'],
      [5, 'critical', 'security'],
      [6, 'critical', 'security'],
    ]);
  });

  it('py/sql-string-concat: SQL built with +, %, f-string or .format and passed to execute', async () => {
    const code = py(
      'def get(cur, name, uid):',
      '    cur.execute("SELECT * FROM users WHERE name = \'" + name + "\'")',
      '    cur.execute("SELECT * FROM users WHERE id = %s" % uid)',
      '    cur.execute(f"SELECT * FROM users WHERE id = {uid}")',
      '    cur.execute("SELECT * FROM users WHERE id = {}".format(uid))',
      '    cur.executemany("INSERT INTO t VALUES (" + name + ")", rows)',
      '    cur.execute("SELECT * FROM users WHERE id = %s", (uid,))',
      '    cur.execute("SELECT 1 " + "FROM dual")',
      '    cur.execute(QUERY, (uid,))',
    );
    const found = await only(code, 'py/sql-string-concat');
    expect(found.map((f) => f.lineStart)).toEqual([2, 3, 4, 5, 6]);
    expect(found.every((f) => f.severity === 'critical' && f.category === 'security')).toBe(true);
    expect(found[0].description).toMatch(/concatenation/);
    expect(found[1].description).toMatch(/% formatting/);
    expect(found[2].description).toMatch(/f-string/);
    expect(found[3].description).toMatch(/\.format/);
  });

  it('py/sql-string-concat: follows a query variable built earlier in the same function', async () => {
    const code = py(
      'def get(cur, uid):',
      '    q = f"SELECT * FROM users WHERE id = {uid}"',
      '    cur.execute(q)',
      'def safe(cur, uid):',
      '    q = "SELECT * FROM users WHERE id = %s"',
      '    cur.execute(q, (uid,))',
      'def grown(cur, uid):',
      '    q = "SELECT * FROM users"',
      '    q += " WHERE id = " + str(uid)',
      '    cur.execute(q)',
    );
    const found = await only(code, 'py/sql-string-concat');
    expect(found.map((f) => f.lineStart)).toEqual([3, 10]);
    expect(found[0].description).toMatch(/built on line 2/);
  });

  it('py/pickle-load: pickle.load and pickle.loads are security warnings', async () => {
    const code = py('import pickle', 'from pickle import loads', 'a = pickle.load(f)', 'b = loads(data)', 'c = pickle.dumps(a)');
    const found = await only(code, 'py/pickle-load');
    expect(found.map((f) => [f.lineStart, f.severity, f.category])).toEqual([
      [3, 'warning', 'security'],
      [4, 'warning', 'security'],
    ]);
  });

  it('py/requests-verify-false: requests calls and sessions with verify=False', async () => {
    const code = py(
      'import requests',
      'requests.get(url, verify=False)',
      's = requests.Session()',
      's.post(url, json=body, verify=False)',
      'requests.get(url)',
      'requests.get(url, verify=True)',
    );
    const found = await only(code, 'py/requests-verify-false');
    expect(found.map((f) => [f.lineStart, f.severity, f.category])).toEqual([
      [2, 'warning', 'security'],
      [4, 'warning', 'security'],
    ]);
  });
});

describe('bug and style rules, with their fixes', () => {
  it('py/bare-except: a bug warning with a fix to except Exception: that parses and clears the rule', async () => {
    const code = py('try:', '    run()', 'except:  # swallow', '    pass', 'try:', '    run()', 'except ValueError:', '    pass');
    const out = await analyze(code);
    expect(ids(out.findings)).toEqual(['py/bare-except']);
    const [f] = out.findings;
    expect(f).toMatchObject({ lineStart: 3, lineEnd: 3, severity: 'warning', category: 'bug' });
    expect(f.fix).toEqual({ lineStart: 3, lineEnd: 3, replacement: 'except Exception:  # swallow' });

    const fixed = applyFix(code, f.fix!);
    expect(await pythonAnalyzer.parses(fixed, 'python')).toEqual({ ok: true, error: null });
    expect((await analyze(fixed)).findings).toEqual([]);
  });

  it('py/mutable-default-arg: list, dict, set and constructor defaults, in functions and lambdas', async () => {
    const code = py(
      'def f(a, b=[], c={}, d=None, e=(), g=0):',
      '    pass',
      'def h(x: list = list(), *, y=set()):',
      '    pass',
      'k = lambda acc=[]: acc',
    );
    const found = await only(code, 'py/mutable-default-arg');
    expect(found.map((f) => [f.lineStart, f.severity, f.category, f.fix])).toEqual([
      [1, 'warning', 'bug', null],
      [1, 'warning', 'bug', null],
      [3, 'warning', 'bug', null],
      [3, 'warning', 'bug', null],
      [5, 'warning', 'bug', null],
    ]);
    expect(found[0].description).toMatch(/'b'/);
    expect(found[0].suggestedFix).toMatch(/b=None/);
  });

  it('py/none-comparison: == None and != None get a style info finding with an is / is not fix', async () => {
    const code = py('if x == None:', '    pass', 'ok = y != None', 'fine = z is None');
    const found = await only(code, 'py/none-comparison');
    expect(found.map((f) => [f.lineStart, f.severity, f.category, f.fix])).toEqual([
      [1, 'info', 'style', { lineStart: 1, lineEnd: 1, replacement: 'if x is None:' }],
      [3, 'info', 'style', { lineStart: 3, lineEnd: 3, replacement: 'ok = y is not None' }],
    ]);
    for (const f of found) {
      const fixed = applyFix(code, f.fix!);
      expect((await pythonAnalyzer.parses(fixed, 'python')).ok).toBe(true);
      expect((await only(fixed, 'py/none-comparison')).map((g) => g.lineStart)).not.toContain(f.lineStart);
    }
  });

  it('py/none-comparison: no mechanical fix for a pandas column filter, where is would change the meaning', async () => {
    const found = await only(py('import pandas as pd', 'rows = df[df.name == None]'), 'py/none-comparison');
    expect(found).toHaveLength(1);
    expect(found[0].fix).toBeNull();
    expect(found[0].suggestedFix).toMatch(/isna/);
  });

  it('a fix keeps non-ASCII text before the change intact', async () => {
    const found = await only('label = "café ☕"; ok = v == None', 'py/none-comparison');
    expect(found[0].fix?.replacement).toBe('label = "café ☕"; ok = v is None');
  });
});

describe('context detection', () => {
  it.each([
    ['from flask import Flask', 'backend', ['imports flask']],
    ['from django.db import models', 'backend', ['imports django']],
    ['import fastapi', 'backend', ['imports fastapi']],
    ['from sqlalchemy.orm import Session', 'backend', ['imports sqlalchemy']],
    ['import sqlite3', 'backend', ['imports sqlite3']],
    ['import psycopg2', 'backend', ['imports psycopg2']],
    ['import psycopg', 'backend', ['imports psycopg']],
    ['import pandas as pd\nimport numpy as np', 'script', ['imports pandas', 'imports numpy']],
    ['import argparse', 'script', ['imports argparse']],
    ['def main():\n    pass\nif __name__ == "__main__":\n    main()', 'script', ['has an if __name__ == "__main__" block']],
    ["if __name__ == '__main__':\n    pass", 'script', ['has an if __name__ == "__main__" block']],
    ['import pytest', 'test', ['imports pytest']],
    ['import unittest', 'test', ['imports unittest']],
    ['def f():\n    return 1', 'unknown', []],
  ])('%j -> %s', async (code, context, signals) => {
    expect((await analyze(code)).detected).toEqual({ context, signals });
  });

  it('a test of a Flask app is a test; a Flask app with a __main__ block is a backend', async () => {
    expect((await analyze(py('import pytest', 'from flask import Flask'))).detected).toEqual({
      context: 'test',
      signals: ['imports pytest'],
    });
    expect((await analyze(py('from flask import Flask', 'app = Flask(__name__)', 'if __name__ == "__main__":', '    app.run()'))).detected).toEqual({
      context: 'backend',
      signals: ['imports flask'],
    });
  });

  it('a user-set context still runs the rules and does not change what was detected', async () => {
    const out = await analyze(py('import flask', 'eval(x)'), 'script');
    expect(out.detected.context).toBe('backend');
    expect(ids(out.findings)).toEqual(['py/eval-exec']);
  });
});

describe('outline and line numbers', () => {
  it('lists functions, classes and methods with their 1-based lines, decorators included', async () => {
    const code = py(
      'import os',
      '',
      'class Repo:',
      '    @property',
      '    def name(self):',
      '        return self._name',
      '',
      '    async def load(self):',
      '        pass',
      '',
      'def helper():',
      '    def inner():',
      '        pass',
      '    return inner',
    );
    expect((await analyze(code)).outline).toEqual([
      { kind: 'class', name: 'Repo', lineStart: 3, lineEnd: 9 },
      { kind: 'method', name: 'Repo.name', lineStart: 4, lineEnd: 6 },
      { kind: 'method', name: 'Repo.load', lineStart: 8, lineEnd: 9 },
      { kind: 'function', name: 'helper', lineStart: 11, lineEnd: 14 },
      { kind: 'function', name: 'inner', lineStart: 12, lineEnd: 13 },
    ]);
  });

  it('a final newline adds no line, and CRLF line endings keep the same numbers', async () => {
    const lf = await analyze('x = 1\ny = eval(z)\n');
    const crlf = await analyze('x = 1\r\ny = eval(z)\r\n');
    for (const out of [lf, crlf]) {
      expect(out.findings.map((f) => [f.lineStart, f.lineEnd])).toEqual([[2, 2]]);
    }
    const fix = (await analyze('try:\r\n    a()\r\nexcept:\r\n    pass\r\n')).findings[0].fix;
    expect(fix).toEqual({ lineStart: 3, lineEnd: 3, replacement: 'except Exception:\r' });
  });

  it('a finding spanning several lines reports its first and last line', async () => {
    const found = await only(py('cur.execute(', '    "SELECT * FROM t WHERE id = " + uid,', ')'), 'py/sql-string-concat');
    expect(found.map((f) => [f.lineStart, f.lineEnd])).toEqual([[1, 3]]);
  });
});
