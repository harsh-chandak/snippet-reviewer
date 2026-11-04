import { describe, expect, it } from 'vitest';
import { CodeContext, Language } from '../../src/model/constants';
import { javascriptAnalyzer } from '../../src/service/analysis/javascript';
import { FixReplacement, RuleFinding } from '../../src/service/analysis/types';
import { codeLines } from '../../src/utils/codeLines';

// Unit tests for the JS/TS analyzer. No database or model is involved; the suite's globalSetup
// still builds the test database, as for every file.

const analyze = (code: string, language: Language = 'javascript', context?: CodeContext) =>
  javascriptAnalyzer.analyze(code, language, context);

const ids = (findings: RuleFinding[]) => findings.map((f) => f.ruleId);
const only = (findings: RuleFinding[], ruleId: string) => findings.filter((f) => f.ruleId === ruleId);

// Replace lines lineStart..lineEnd (inclusive) with the replacement, as FixReplacement says.
function applyFix(code: string, fix: FixReplacement): string {
  const lines = codeLines(code);
  lines.splice(fix.lineStart - 1, fix.lineEnd - fix.lineStart + 1, ...(fix.replacement === '' ? [] : fix.replacement.split('\n')));
  return lines.join('\n');
}

// A rule's fix must parse, clear that rule on its lines and bring in no new rule.
async function expectFixWorks(code: string, finding: RuleFinding, language: Language = 'javascript', context?: CodeContext) {
  expect(finding.fix).not.toBeNull();
  const fix = finding.fix!;
  const before = await analyze(code, language, context);
  const fixed = applyFix(code, fix);
  expect(await javascriptAnalyzer.parses(fixed, language)).toEqual({ ok: true, error: null });
  const after = await analyze(fixed, language, context);
  const stillThere = after.findings.filter(
    (f) => f.ruleId === finding.ruleId && f.lineStart <= fix.lineEnd && f.lineEnd >= fix.lineStart,
  );
  expect(stillThere).toEqual([]);
  const beforeIds = new Set(ids(before.findings));
  expect(ids(after.findings).filter((id) => !beforeIds.has(id))).toEqual([]);
  return fixed;
}

describe('javascriptAnalyzer', () => {
  it('handles javascript and typescript', () => {
    expect(javascriptAnalyzer.languages).toEqual(['javascript', 'typescript']);
  });

  describe('parsing', () => {
    it('reports one js/syntax-error at the line of the first error, and runs no other rule', async () => {
      const code = 'const a = 1;\neval(a);\nif (a {\n  run();\n}\n';
      const out = await analyze(code);
      expect(out.parseOk).toBe(false);
      expect(out.parseError).toMatch(/^Line 3: /);
      expect(out.findings).toHaveLength(1);
      expect(out.findings[0]).toMatchObject({
        ruleId: 'js/syntax-error',
        lineStart: 3,
        lineEnd: 3,
        severity: 'critical',
        category: 'bug',
        fix: null,
      });
      expect(await javascriptAnalyzer.parses(code, 'javascript')).toEqual({ ok: false, error: out.parseError });
    });

    it('parses JSX as javascript, and refuses TypeScript syntax there', async () => {
      expect((await analyze('const el = <div className="x">{a}</div>;')).parseOk).toBe(true);
      const ts = await analyze('let n: number = 1;');
      expect(ts.parseOk).toBe(false);
      expect(ts.findings[0].ruleId).toBe('js/syntax-error');
    });

    it('parses typescript with type assertions and generic arrows, and TSX, using the js/ rule ids', async () => {
      expect((await analyze('const id = <T>(x: T): T => x;\nlet y = <number>z;', 'typescript')).parseOk).toBe(true);
      expect((await analyze('export const A = (p: { n: number }) => <b>{p.n}</b>;', 'typescript')).parseOk).toBe(true);
      const bad = await analyze('interface A {\n  x: number\n\nconst b = 1;', 'typescript');
      expect(bad.parseOk).toBe(false);
      expect(bad.findings[0].ruleId).toBe('js/syntax-error');
    });

    it('counts lines on \\n only, like codeLines (CRLF, U+2028 inside a string, a final newline)', async () => {
      const crlf = await analyze('const a = 1;\r\nif (a == 2) {}\r\nrun();\r\n');
      expect(only(crlf.findings, 'js/loose-equality')[0]).toMatchObject({ lineStart: 2, lineEnd: 2 });
      expect(only(crlf.findings, 'js/loose-equality')[0].fix!.replacement).toBe('if (a === 2) {}\r');

      const ls = await analyze("const s = 'a b';\nif (s == 'x') {}\n");
      expect(only(ls.findings, 'js/loose-equality')[0]).toMatchObject({ lineStart: 2, lineEnd: 2 });

      const lastLine = await analyze('let a;\nif (a != 1) {}\n');
      expect(lastLine.findings[0].lineStart).toBe(2);
    });

    it('treats an empty snippet as parsing with nothing to report', async () => {
      const out = await analyze('');
      expect(out).toMatchObject({ parseOk: true, parseError: null, outline: [], findings: [] });
      expect(out.detected).toEqual({ context: 'unknown', signals: [] });
    });

    it('survives very deep nesting without crashing', async () => {
      const longChain = await analyze('x' + '+x'.repeat(9000));
      expect(longChain.parseOk).toBe(true);
      const deep = await analyze('('.repeat(6000) + 'x' + ')'.repeat(6000));
      expect(deep.findings.length).toBeLessThanOrEqual(1);
    });
  });

  describe('context detection', () => {
    it('detects frontend from react imports, hooks, JSX and document', async () => {
      const out = await analyze(
        "import { useState } from 'react';\nexport function A() {\n  const [n] = useState(0);\n  document.title = 'x';\n  return <p>{n}</p>;\n}",
      );
      expect(out.detected.context).toBe('frontend');
      expect(out.detected.signals).toEqual(expect.arrayContaining(['imports react', 'calls useState', 'uses JSX', 'uses document']));
    });

    it('detects backend from express, (req, res) handlers and process.env', async () => {
      const out = await analyze(
        "const express = require('express');\nconst app = express();\napp.get('/', (req, res) => res.send(process.env.NAME));",
      );
      expect(out.detected.context).toBe('backend');
      expect(out.detected.signals).toEqual(expect.arrayContaining(['imports express', 'has a (req, res) handler', 'reads process.env']));
    });

    it('detects backend from database imports, node:fs and SQL run through .query()', async () => {
      expect((await analyze("import { Pool } from 'pg';")).detected).toEqual({ context: 'backend', signals: ['imports pg'] });
      expect((await analyze("import { readFile } from 'node:fs/promises';")).detected.signals).toEqual(['imports node:fs/promises']);
      expect((await analyze("await db.query('SELECT 1 FROM users');")).detected).toEqual({
        context: 'backend',
        signals: ['runs SQL through .query()'],
      });
    });

    it('detects test from describe/it/expect and test-framework imports, even with other signals', async () => {
      const out = await analyze(
        "import { describe, it, expect } from 'vitest';\nimport { render } from 'react';\ndescribe('x', () => { it('y', () => expect(1).toBe(1)); });",
      );
      expect(out.detected.context).toBe('test');
      expect(out.detected.signals).toEqual(expect.arrayContaining(['imports vitest', 'calls describe()', 'calls it()', 'calls expect()']));
    });

    it('detects script from process.argv and console logging', async () => {
      const out = await analyze("const [, , file] = process.argv;\nconsole.log('reading', file);");
      expect(out.detected).toEqual({ context: 'script', signals: ['reads process.argv', 'logs to the console'] });
      // A node CLI that reads files is still a script.
      expect((await analyze("const fs = require('fs');\nconsole.log(fs.readFileSync(process.argv[2], 'utf8'));")).detected.context).toBe(
        'script',
      );
    });

    it("says 'unknown' with no signals when nothing fires", async () => {
      expect((await analyze('function add(a, b) {\n  return a + b;\n}')).detected).toEqual({ context: 'unknown', signals: [] });
      // regex.test() and str.exec() are not test or child_process calls.
      expect((await analyze("const ok = /a/.test(s) && /b/.exec(s);")).detected).toEqual({ context: 'unknown', signals: [] });
    });

    it('runs the rules for the context the user set, and still reports what it detected', async () => {
      // No signal: only the chosen context's rules run.
      const code = 'el.innerHTML = html;';
      const detected = await analyze(code, 'javascript', 'backend');
      expect(detected.detected.context).toBe('unknown');
      expect(ids(detected.findings)).toEqual([]);
      const asFrontend = await analyze(code, 'javascript', 'frontend');
      expect(asFrontend.detected.context).toBe('unknown');
      expect(ids(asFrontend.findings)).toEqual(['js/inner-html-assignment']);
    });

    it('runs the rules of every context with a signal, not only the winning one (rules for detected contexts)', async () => {
      // express (backend) wins, but JSX is a frontend signal, so the frontend rules run too.
      const code =
        "const express = require('express');\napp.get('/', (req, res) => res.send(<div dangerouslySetInnerHTML={{ __html: req.query.x }} />));";
      const out = await analyze(code);
      expect(out.detected.context).toBe('backend');
      expect(ids(out.findings)).toContain('js/dangerously-set-inner-html');
      expect(ids((await analyze(code, 'javascript', 'frontend')).findings)).toContain('js/dangerously-set-inner-html');
    });
  });

  describe('outline', () => {
    it('lists named functions, arrow functions, classes and methods with their lines', async () => {
      const code = [
        'export function load(id) {', // 1
        '  return id;', // 2
        '}', // 3
        'export const save = async (x) => {', // 4
        '  return x;', // 5
        '};', // 6
        'class Repo {', // 7
        '  constructor() {}', // 8
        '  find(id) {', // 9
        '    return id;', // 10
        '  }', // 11
        '  remove = () => 1;', // 12
        '}', // 13
        'items.map((x) => x);', // 14 (anonymous: left out)
      ].join('\n');
      expect((await analyze(code)).outline).toEqual([
        { kind: 'function', name: 'load', lineStart: 1, lineEnd: 3 },
        { kind: 'function', name: 'save', lineStart: 4, lineEnd: 6 },
        { kind: 'class', name: 'Repo', lineStart: 7, lineEnd: 13 },
        { kind: 'method', name: 'Repo.constructor', lineStart: 8, lineEnd: 8 },
        { kind: 'method', name: 'Repo.find', lineStart: 9, lineEnd: 11 },
        { kind: 'method', name: 'Repo.remove', lineStart: 12, lineEnd: 12 },
      ]);
    });
  });

  describe('rules for any context', () => {
    it('js/eval flags eval() and new Function() as critical security', async () => {
      const out = await analyze('eval(input);\nconst f = new Function("a", body);\nwindow.eval(x);');
      expect(only(out.findings, 'js/eval').map((f) => [f.lineStart, f.severity, f.category])).toEqual([
        [1, 'critical', 'security'],
        [2, 'critical', 'security'],
        [3, 'critical', 'security'],
      ]);
      expect(ids((await analyze('obj.eval(x); const evaluate = 1;')).findings)).not.toContain('js/eval');
    });

    it('js/loose-equality flags == and != with a fix to === and !==, one finding per line', async () => {
      const code = "if (a == b && c != 'x') {\n  go();\n}\nif (d == 1) {}";
      const out = await analyze(code);
      const found = only(out.findings, 'js/loose-equality');
      expect(found).toHaveLength(2);
      expect(found[0]).toMatchObject({ lineStart: 1, lineEnd: 1, severity: 'warning', category: 'bug' });
      expect(found[0].fix).toEqual({ lineStart: 1, lineEnd: 1, replacement: "if (a === b && c !== 'x') {" });
      const fixed = await expectFixWorks(code, found[0]);
      await expectFixWorks(fixed, only((await analyze(fixed)).findings, 'js/loose-equality')[0]);
    });

    it('js/loose-equality leaves == null / != undefined and === alone', async () => {
      const out = await analyze('if (a == null || b != undefined || c === d || e !== f) {}');
      expect(ids(out.findings)).not.toContain('js/loose-equality');
    });

    it('js/empty-catch flags an empty catch but not one with a comment or a statement', async () => {
      const out = await analyze('try {\n  run();\n} catch (e) {\n}\ntry { run(); } catch { /* best effort */ }\ntry { run(); } catch (e) { log(e); }');
      const found = only(out.findings, 'js/empty-catch');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ lineStart: 3, lineEnd: 4, severity: 'warning', category: 'bug', fix: null });
    });
  });

  describe('backend rules', () => {
    it('js/sql-string-concat flags SQL built with + or a template literal and passed to .query/.execute/.raw', async () => {
      const code = [
        "db.query('SELECT * FROM users WHERE id = ' + id);", // 1
        'pool.query(`DELETE FROM posts WHERE id = ${req.params.id}`);', // 2
        "const sql = 'SELECT * FROM t WHERE name = \\'' + name + '\\'';", // 3
        'conn.execute(sql);', // 4
        'knex.raw(`select ${col} from t`);', // 5
      ].join('\n');
      const found = only((await analyze(code, 'javascript', 'backend')).findings, 'js/sql-string-concat');
      expect(found.map((f) => [f.lineStart, f.severity, f.category])).toEqual([
        [1, 'critical', 'security'],
        [2, 'critical', 'security'],
        [4, 'critical', 'security'],
        [5, 'critical', 'security'],
      ]);
    });

    it('js/sql-string-concat leaves parameterized queries, tagged templates and fixed strings alone', async () => {
      const code = [
        "db.query('SELECT * FROM users WHERE id = $1', [id]);",
        'prisma.$queryRaw`SELECT * FROM users WHERE id = ${id}`;',
        "db.query('SELECT * FROM users ' + 'LIMIT 10');",
        'db.query(`SELECT 1`);',
        'job.execute(`run ${name}`);',
      ].join('\n');
      expect(ids((await analyze(code, 'javascript', 'backend')).findings)).not.toContain('js/sql-string-concat');
    });

    it('js/child-process-exec flags exec/execSync from child_process with a non-literal command', async () => {
      const code = [
        "const { exec } = require('child_process');", // 1
        "import * as cp from 'node:child_process';", // 2
        "const { promisify } = require('util');", // 3
        'const run = promisify(exec);', // 4
        "exec('ls ' + dir);", // 5
        'cp.execSync(`git log ${branch}`);', // 6
        'await run(cmd);', // 7
        "exec('ls -la');", // 8: literal, fine
        '/x/.exec(input);', // 9: RegExp#exec, fine
      ].join('\n');
      const found = only((await analyze(code, 'typescript', 'backend')).findings, 'js/child-process-exec');
      expect(found.map((f) => [f.lineStart, f.severity, f.category])).toEqual([
        [5, 'critical', 'security'],
        [6, 'critical', 'security'],
        [7, 'critical', 'security'],
      ]);
    });

    it('js/fs-path-from-request flags fs reads and writes whose path comes from req', async () => {
      const code = [
        "const fs = require('fs');", // 1
        "import { readFile } from 'fs/promises';", // 2
        "app.get('/f', async (req, res) => {", // 3
        '  const { name } = req.query;', // 4
        '  const file = path.join(__dirname, name);', // 5
        "  res.send(fs.readFileSync(file, 'utf8'));", // 6
        '  await readFile(req.params.p);', // 7
        '  fs.promises.writeFile(`./up/${req.body.n}`, data);', // 8
        "  fs.readFileSync('./static.txt');", // 9: fixed path, fine
        '});', // 10
      ].join('\n');
      const out = await analyze(code, 'typescript');
      expect(out.detected.context).toBe('backend');
      expect(only(out.findings, 'js/fs-path-from-request').map((f) => [f.lineStart, f.severity, f.category])).toEqual([
        [6, 'warning', 'security'],
        [7, 'warning', 'security'],
        [8, 'warning', 'security'],
      ]);
    });
  });

  describe('frontend rules', () => {
    it('js/dangerously-set-inner-html flags the prop', async () => {
      const out = await analyze('export const A = ({ html }) => (\n  <div\n    dangerouslySetInnerHTML={{ __html: html }}\n  />\n);');
      expect(out.detected.context).toBe('frontend');
      expect(only(out.findings, 'js/dangerously-set-inner-html')).toEqual([
        expect.objectContaining({ lineStart: 3, lineEnd: 3, severity: 'warning', category: 'security', fix: null }),
      ]);
    });

    it('js/inner-html-assignment flags innerHTML/outerHTML set from a value, not from a fixed string', async () => {
      const code = "el.innerHTML = html;\nbox.outerHTML += `<b>${name}</b>`;\nel.innerHTML = '';\nel.textContent = html;";
      const found = only((await analyze(code, 'javascript', 'frontend')).findings, 'js/inner-html-assignment');
      expect(found.map((f) => [f.lineStart, f.severity, f.category])).toEqual([
        [1, 'warning', 'security'],
        [2, 'warning', 'security'],
      ]);
    });

    it('js/target-blank-noopener adds rel="noopener", or adds noopener to an existing rel', async () => {
      const code = [
        'export const L = () => (', // 1
        '  <nav>', // 2
        '    <a href={u} target="_blank">a</a>', // 3
        '    <a href={u} target="_blank" rel="nofollow">b</a>', // 4
        '    <a href={u} target="_blank" rel="noreferrer">c</a>', // 5: fine
        '    <a href={u} target="_self">d</a>', // 6: fine
        '  </nav>', // 7
        ');', // 8
      ].join('\n');
      const found = only((await analyze(code)).findings, 'js/target-blank-noopener');
      expect(found.map((f) => [f.lineStart, f.severity, f.category])).toEqual([
        [3, 'info', 'security'],
        [4, 'info', 'security'],
      ]);
      expect(found[0].fix!.replacement).toBe('    <a href={u} target="_blank" rel="noopener">a</a>');
      expect(found[1].fix!.replacement).toBe('    <a href={u} target="_blank" rel="nofollow noopener">b</a>');
      await expectFixWorks(code, found[0]);
      await expectFixWorks(code, found[1]);
    });

    it('js/target-blank-noopener fixes two links on one line in one finding', async () => {
      const code = 'const x = <p><a target="_blank">1</a><a target="_blank">2</a></p>;';
      const found = only((await analyze(code, 'typescript')).findings, 'js/target-blank-noopener');
      expect(found).toHaveLength(1);
      await expectFixWorks(code, found[0], 'typescript');
    });
  });

  describe('test rules', () => {
    it('js/focused-test flags .only on describe/it/test with a fix that removes it', async () => {
      const code = "describe.only('a', () => {\n  it.only('b', () => {});\n  test('c', () => {});\n});";
      const out = await analyze(code, 'typescript');
      expect(out.detected.context).toBe('test');
      const found = only(out.findings, 'js/focused-test');
      expect(found.map((f) => [f.lineStart, f.severity, f.category])).toEqual([
        [1, 'warning', 'bug'],
        [2, 'warning', 'bug'],
      ]);
      expect(found[0].fix).toEqual({ lineStart: 1, lineEnd: 1, replacement: "describe('a', () => {" });
      expect(found[1].fix).toEqual({ lineStart: 2, lineEnd: 2, replacement: "  it('b', () => {});" });
      await expectFixWorks(code, found[0], 'typescript');
      await expectFixWorks(code, found[1], 'typescript');
    });
  });

  describe('rules per context', () => {
    const backendOnly = "db.query('SELECT * FROM t WHERE id = ' + id);";
    const frontendOnly = 'el.innerHTML = html;';
    const testOnly = "it.only('x', () => {});";

    it('runs backend rules for backend and script, and for any context when the code signals backend', async () => {
      for (const ctx of ['backend', 'script'] as const) {
        expect(ids((await analyze(backendOnly, 'javascript', ctx)).findings)).toContain('js/sql-string-concat');
      }
      // "runs SQL through .query()" is a backend signal, so a frontend or test choice can't switch the rule off.
      for (const ctx of ['frontend', 'test'] as const) {
        expect(ids((await analyze(backendOnly, 'javascript', ctx)).findings)).toContain('js/sql-string-concat');
      }
    });

    it('runs frontend rules only for frontend when nothing signals it; test rules whenever the code signals test', async () => {
      expect(ids((await analyze(frontendOnly, 'javascript', 'backend')).findings)).toEqual([]);
      expect(ids((await analyze(frontendOnly, 'javascript', 'frontend')).findings)).toEqual(['js/inner-html-assignment']);
      // "calls it()" is a test signal.
      expect(ids((await analyze(testOnly, 'javascript', 'backend')).findings)).toEqual(['js/focused-test']);
      expect(ids((await analyze(testOnly, 'javascript', 'test')).findings)).toEqual(['js/focused-test']);
    });

    it("runs every rule when the context is 'unknown'", async () => {
      const out = await analyze(`${backendOnly}\n${frontendOnly}`, 'javascript', 'unknown');
      expect(ids(out.findings)).toEqual(['js/sql-string-concat', 'js/inner-html-assignment']);
    });

    it('runs the any-context rules everywhere, including query', async () => {
      for (const ctx of ['frontend', 'backend', 'script', 'test', 'query', 'unknown'] as const) {
        expect(ids((await analyze('eval(x);', 'javascript', ctx)).findings)).toEqual(['js/eval']);
      }
    });

    it('orders findings by line', async () => {
      const out = await analyze("if (a == 1) {}\ntry { x(); } catch (e) {}\neval(s);");
      expect(out.findings.map((f) => [f.lineStart, f.ruleId])).toEqual([
        [1, 'js/loose-equality'],
        [2, 'js/empty-catch'],
        [3, 'js/eval'],
      ]);
    });
  });
});
