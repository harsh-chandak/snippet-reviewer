import { describe, expect, it, vi } from 'vitest';

// The real language analyzers are written in parallel; these tests replace them with a small stub so
// they check only the core: the language-agnostic rules, analyzeSnippet's merge, and the fix checker.
const stub = vi.hoisted(() => {
  type Finding = import('../../src/service/analysis/types').RuleFinding;
  const contexts: (string | undefined)[] = [];

  // "Parses" unless a line contains @@. THROW makes the analyzer itself fail.
  function parse(code: string): { ok: boolean; error: string | null; line: number } {
    if (code.includes('THROW')) throw new Error('analyzer crashed');
    const lines = code.replace(/\r?\n$/, '').split('\n');
    const bad = lines.findIndex((l) => l.includes('@@'));
    return bad === -1 ? { ok: true, error: null, line: 0 } : { ok: false, error: `unexpected '@@' at line ${bad + 1}`, line: bad + 1 };
  }

  const analyzer = {
    languages: ['javascript', 'typescript'],
    async parses(code: string) {
      const p = parse(code);
      return { ok: p.ok, error: p.error };
    },
    async analyze(code: string, _language: string, context?: string) {
      contexts.push(context);
      const p = parse(code);
      const detected = { context: 'backend' as const, signals: ['imports express'] };
      if (!p.ok) {
        const f: Finding = { ruleId: 'js/syntax-error', lineStart: p.line, lineEnd: p.line, severity: 'critical', category: 'bug', description: p.error!, suggestedFix: null, fix: null };
        return { parseOk: false, parseError: p.error, detected, outline: [], findings: [f] };
      }
      const findings: Finding[] = [];
      code.replace(/\r?\n$/, '').split('\n').forEach((line, i) => {
        const n = i + 1;
        if (/[^=!]==[^=]/.test(line)) {
          findings.push({ ruleId: 'js/loose-equality', lineStart: n, lineEnd: n, severity: 'warning', category: 'bug', description: 'loose equality', suggestedFix: 'use ===', fix: { lineStart: n, lineEnd: n, replacement: line.replace(/([^=!])==([^=])/g, '$1===$2') } });
        }
        if (line.includes('eval(')) {
          findings.push({ ruleId: 'js/eval', lineStart: n, lineEnd: n, severity: 'critical', category: 'security', description: 'eval', suggestedFix: null, fix: null });
        }
      });
      return { parseOk: true, parseError: null, detected, outline: [], findings };
    },
  };
  const none = (languages: string[]) => ({
    languages,
    async parses() {
      return { ok: true, error: null };
    },
    async analyze() {
      return { parseOk: true, parseError: null, detected: { context: 'unknown', signals: [] }, outline: [], findings: [] };
    },
  });
  return { analyzer, none, contexts };
});

vi.mock('../../src/service/analysis/javascript', () => ({ javascriptAnalyzer: stub.analyzer }));
vi.mock('../../src/service/analysis/python', () => ({ pythonAnalyzer: stub.none(['python']) }));
vi.mock('../../src/service/analysis/sql', () => ({ sqlAnalyzer: stub.none(['sql']) }));

import { commonFindings, hardcodedSecretFindings } from '../../src/service/analysis/common';
import { applyFix, checkFix, FixRangeError } from '../../src/service/analysis/fixCheck';
import { analyzeSnippet } from '../../src/service/analysis/index';

const AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join(''); // split so the repo itself holds no key-shaped string

describe('any/hardcoded-secret', () => {
  it('finds an AWS access key id without echoing it', () => {
    const findings = hardcodedSecretFindings(`package main\n\nvar k = "${AWS_KEY}"\n`, 'go');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: 'any/hardcoded-secret', lineStart: 3, lineEnd: 3, severity: 'critical', category: 'security', fix: null });
    expect(findings[0].description).not.toContain(AWS_KEY);
  });

  it('reports a private key block once, over its BEGIN..END lines', () => {
    const code = ['const key = `', '-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', 'password = "inside-the-key"', '-----END RSA PRIVATE KEY-----', '`;'].join('\n');
    const findings = hardcodedSecretFindings(code, 'javascript');
    expect(findings).toEqual([expect.objectContaining({ ruleId: 'any/hardcoded-secret', lineStart: 2, lineEnd: 5 })]);
    expect(findings[0].description).not.toContain('MIIE');
  });

  it.each([
    ['python', 'DB_PASSWORD = "hunter2-very-secret"', 'DB_PASSWORD'],
    ['javascript', "const apiKey = 'sk-live-0123456789';", 'apiKey'],
    ['go', 'clientSecret := "s3cr3t-value"', 'clientSecret'],
    ['ruby', "config.auth_token = 'tok_abcdef'", 'auth_token'],
    ['php', "$password = 'letmein';", 'password'],
    ['other', '  "api_key": "abc123def456",', 'api_key'],
    ['other', 'access-key: "AbCdEf123456"', 'access-key'],
    ['python', 'connect(user="app", password="pw-1234")', 'password'],
  ] as const)('%s: flags a credential assigned a literal (%s)', (language, line, name) => {
    const findings = hardcodedSecretFindings(`first line\n${line}\n`, language);
    expect(findings).toHaveLength(1);
    expect(findings[0].lineStart).toBe(2);
    expect(findings[0].description).toContain(name);
    const value = /["']([^"']+)["']\s*[,;)]?\s*$/.exec(line)![1];
    expect(findings[0].description).not.toContain(value);
  });

  it.each([
    'if (password == "hunter2") {}',
    'if (password === "hunter2") {}',
    'password = os.environ["DB_PASSWORD"]',
    'const password = process.env.PASSWORD;',
    'password = ""',
    'token_type = "Bearer"',
    'password_label = "Password"',
    'tokenizer = "bert-base-uncased"',
    'password = "<your password>"',
    'password = "********"',
    'password = "${DB_PASSWORD}"',
    'api_key = "your-api-key-here"',
    'let password: string;',
    'const passwordUrl = "https://example.com/reset";',
  ])('does not flag %s', (line) => {
    expect(hardcodedSecretFindings(line, 'javascript')).toEqual([]);
  });

  it('in SQL, flags a PASSWORD literal but not a comparison on a password column', () => {
    const code = "CREATE USER app WITH PASSWORD 'pg-secret-1';\nSELECT id FROM users WHERE password = 'x';\nALTER USER b IDENTIFIED BY 'other-secret';";
    const findings = commonFindings(code, 'sql');
    expect(findings.map((f) => f.lineStart)).toEqual([1, 3]);
    for (const f of findings) expect(f.description).not.toMatch(/pg-secret|other-secret/);
  });

  it('gives at most one finding per line', () => {
    expect(hardcodedSecretFindings(`AWS_SECRET_KEY = "${AWS_KEY}"; token = "abcdef"`, 'python')).toHaveLength(1);
  });

  it('counts lines like codeLines (CRLF, final newline)', () => {
    const findings = hardcodedSecretFindings('a = 1\r\nb = 2\r\npassword = "hunter22"\r\n', 'python');
    expect(findings.map((f) => f.lineStart)).toEqual([3]);
  });
});

describe('analyzeSnippet', () => {
  it('finds a hard-coded secret in a language without an analyzer', async () => {
    const result = await analyzeSnippet('go', `package main\n\nconst k = "${AWS_KEY}"`);
    expect(result.supported).toBe(false);
    expect(result.context).toBe('unknown');
    expect(result.outline).toEqual([]);
    expect(result.findings.map((f) => [f.ruleId, f.lineStart])).toEqual([['any/hardcoded-secret', 3]]);
  });

  it('a language without an analyzer and no secret has no findings', async () => {
    const result = await analyzeSnippet('rust', 'fn main() {}', 'script');
    expect(result).toMatchObject({ supported: false, findings: [], context: 'script' });
  });

  it('merges language rules and common rules, ordered by line', async () => {
    const code = ['const password = "hunter22";', 'if (a == b) {}', 'const t = eval(x);', `const k = "${AWS_KEY}";`].join('\n');
    const result = await analyzeSnippet('javascript', code);
    expect(result.supported).toBe(true);
    expect(result.context).toBe('backend');
    expect(result.findings.map((f) => [f.lineStart, f.ruleId])).toEqual([
      [1, 'any/hardcoded-secret'],
      [2, 'js/loose-equality'],
      [3, 'js/eval'],
      [4, 'any/hardcoded-secret'],
    ]);
  });

  it('still runs the common rules when the snippet does not parse', async () => {
    const result = await analyzeSnippet('typescript', 'const token = "abcdef12";\n@@');
    expect(result.parseOk).toBe(false);
    expect(result.findings.map((f) => f.ruleId).sort()).toEqual(['any/hardcoded-secret', 'js/syntax-error']);
  });

  it("the user's context wins and is passed to the analyzer", async () => {
    stub.contexts.length = 0;
    const result = await analyzeSnippet('javascript', 'x', 'frontend');
    expect(result.context).toBe('frontend');
    expect(result.detected.context).toBe('backend');
    expect(stub.contexts).toEqual(['frontend']);
  });
});

describe('applyFix', () => {
  const code = 'one\ntwo\nthree\nfour\n';

  it('replaces one line and keeps the final newline', () => {
    expect(applyFix(code, { lineStart: 2, lineEnd: 2, replacement: 'TWO' })).toBe('one\nTWO\nthree\nfour\n');
  });

  it('replaces a range with several lines', () => {
    expect(applyFix(code, { lineStart: 2, lineEnd: 3, replacement: 'a\nb\nc' })).toBe('one\na\nb\nc\nfour\n');
  });

  it('deletes lines when the replacement is empty', () => {
    expect(applyFix(code, { lineStart: 1, lineEnd: 2, replacement: '' })).toBe('three\nfour\n');
    expect(applyFix('only', { lineStart: 1, lineEnd: 1, replacement: '' })).toBe('');
  });

  it('a replacement ending in a newline is still one line', () => {
    expect(applyFix(code, { lineStart: 4, lineEnd: 4, replacement: 'FOUR\n' })).toBe('one\ntwo\nthree\nFOUR\n');
  });

  it('works on code without a final newline, and on the last line', () => {
    expect(applyFix('a\nb', { lineStart: 2, lineEnd: 2, replacement: 'B' })).toBe('a\nB');
  });

  it.each([
    { lineStart: 0, lineEnd: 1 },
    { lineStart: 3, lineEnd: 2 },
    { lineStart: 4, lineEnd: 5 },
    { lineStart: 5, lineEnd: 5 },
    { lineStart: 1.5, lineEnd: 2 },
  ])('refuses lines outside the snippet: %o', (range) => {
    expect(() => applyFix(code, { ...range, replacement: 'x' })).toThrow(FixRangeError);
  });
});

describe('checkFix', () => {
  const code = ['const a = 1;', 'if (a == b) {}', 'if (c == d) {}', ''].join('\n');
  const ruleFix = (replacement: string, line = 2) => ({
    source: 'rule' as const,
    ruleId: 'js/loose-equality',
    fix: { lineStart: line, lineEnd: line, replacement },
  });

  it('no fix: not_checked with no detail', async () => {
    expect(await checkFix({ source: 'rule', ruleId: 'js/loose-equality', fix: null }, code, 'javascript')).toEqual({ fixCheck: 'not_checked', detail: null });
  });

  it('no analyzer for the language: not_checked, and says why', async () => {
    const result = await checkFix({ source: 'model', ruleId: null, fix: { lineStart: 1, lineEnd: 1, replacement: 'x' } }, 'a\nb', 'go');
    expect(result.fixCheck).toBe('not_checked');
    expect(result.detail).toMatchObject({ parses: null, ruleCleared: null, newRuleIds: [] });
    expect(result.detail!.note).toMatch(/no static rules for go/i);
  });

  it('a rule fix that clears its rule passes, even though the rule still fires on another line', async () => {
    const result = await checkFix(ruleFix('if (a === b) {}'), code, 'javascript');
    expect(result).toEqual({
      fixCheck: 'passed',
      detail: { parses: true, ruleCleared: true, newRuleIds: [], note: expect.stringContaining('no longer fires') },
    });
  });

  it('a fix that does not parse fails', async () => {
    const result = await checkFix(ruleFix('if (a === b) {@@'), code, 'javascript');
    expect(result.fixCheck).toBe('failed');
    expect(result.detail).toMatchObject({ parses: false, newRuleIds: ['js/syntax-error'] });
    expect(result.detail!.note).toContain("unexpected '@@' at line 2");
  });

  it('a fix that leaves its rule firing on the fixed lines fails', async () => {
    const result = await checkFix(ruleFix('if (a == b && b == c) {}'), code, 'javascript');
    expect(result.fixCheck).toBe('failed');
    expect(result.detail).toMatchObject({ parses: true, ruleCleared: false, newRuleIds: [] });
    expect(result.detail!.note).toContain('js/loose-equality still fires');
  });

  it('a fix that brings in a new rule fails and names it', async () => {
    const result = await checkFix(ruleFix('if (eval("a === b")) {}'), code, 'javascript');
    expect(result.fixCheck).toBe('failed');
    expect(result.detail).toMatchObject({ parses: true, ruleCleared: true, newRuleIds: ['js/eval'] });
  });

  it('a new hard-coded secret counts as a new rule', async () => {
    const result = await checkFix(ruleFix('if (a === "x") { password = "hunter22"; }'), code, 'javascript');
    expect(result.fixCheck).toBe('failed');
    expect(result.detail!.newRuleIds).toEqual(['any/hardcoded-secret']);
  });

  it('a rule that already fired elsewhere is not new', async () => {
    const withEval = `${code}eval(x);\n`;
    const result = await checkFix(ruleFix('if (eval(a) === b) {}'), withEval, 'javascript');
    expect(result).toMatchObject({ fixCheck: 'passed', detail: { newRuleIds: [] } });
  });

  it('a model fix is checked for parsing and new rules, with ruleCleared null', async () => {
    const fix = { lineStart: 1, lineEnd: 1, replacement: 'const a = 2;\nconst z = 3;' };
    expect(await checkFix({ source: 'model', ruleId: null, fix }, code, 'javascript')).toMatchObject({
      fixCheck: 'passed',
      detail: { parses: true, ruleCleared: null, newRuleIds: [] },
    });
    const bad = await checkFix({ source: 'model', ruleId: null, fix: { ...fix, replacement: '@@' } }, code, 'javascript');
    expect(bad).toMatchObject({ fixCheck: 'failed', detail: { parses: false, ruleCleared: null } });
  });

  it('a model finding is not judged by a ruleId it happens to carry', async () => {
    const result = await checkFix({ source: 'model', ruleId: 'js/loose-equality', fix: { lineStart: 1, lineEnd: 1, replacement: 'const a = 3;' } }, code, 'javascript');
    expect(result.detail!.ruleCleared).toBeNull();
  });

  it('clears a hard-coded secret by its fix', async () => {
    const secret = 'const password = "hunter22";\nlogin(password);\n';
    const result = await checkFix(
      { source: 'rule', ruleId: 'any/hardcoded-secret', fix: { lineStart: 1, lineEnd: 1, replacement: 'const password = process.env.PASSWORD;' } },
      secret,
      'typescript',
    );
    expect(result).toMatchObject({ fixCheck: 'passed', detail: { parses: true, ruleCleared: true, newRuleIds: [] } });
  });

  it('a deletion clears the rule unless a finding still spans the removed lines', async () => {
    const result = await checkFix(ruleFix('', 2), code, 'javascript');
    expect(result).toMatchObject({ fixCheck: 'passed', detail: { ruleCleared: true } });
  });

  it('a fix outside the snippet fails without running anything', async () => {
    const result = await checkFix(ruleFix('x', 9), code, 'javascript');
    expect(result.fixCheck).toBe('failed');
    expect(result.detail).toMatchObject({ parses: null, ruleCleared: null, newRuleIds: [] });
    expect(result.detail!.note).toBe('The fix replaces lines 9-9, but the snippet has 3 lines.');
  });

  it('an analyzer that throws gives not_checked with the error, not an exception', async () => {
    const result = await checkFix(ruleFix('THROW'), code, 'javascript');
    expect(result.fixCheck).toBe('not_checked');
    expect(result.detail!.note).toBe('The fix could not be checked: analyzer crashed');
  });

  it('runs the rules for the given context, before and after', async () => {
    stub.contexts.length = 0;
    await checkFix(ruleFix('if (a === b) {}'), code, 'javascript', 'test');
    expect(stub.contexts).toEqual(['test', 'test']);
  });
});
