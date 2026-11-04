import { describe, expect, it } from 'vitest';
import { analyzeSnippet } from '../src/service/analysis';
import { sqlAnalyzer } from '../src/service/analysis/sql';
import { api, createSnippet, fakeProvider, startReview, useTestDatabase, V1, waitForReview } from './helpers';

useTestDatabase();

// The breaks from .concord-engine/adversarial-2/attack-static.md that this unit fixes (STA-1, STA-2,
// STA-4, STA-5, STA-10), through the public paths only (analyzeSnippet and the HTTP API), so each
// test also runs against the code before the fix. The worker guard itself is in analysis/guard.test.ts.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ids = (findings: { ruleId: string }[]) => findings.map((f) => f.ruleId);

// Hits GET /health every 100 ms until `stop` resolves; returns each response time in ms.
async function probeHealth(stop: Promise<unknown>): Promise<number[]> {
  let done = false;
  void stop.finally(() => (done = true));
  const times: number[] = [];
  while (!done) {
    const t = Date.now();
    const res = await api().get(`${V1}/health`);
    expect(res.status).toBe(200);
    times.push(Date.now() - t);
    await sleep(100);
  }
  return times;
}

async function review(language: string, code: string, timeoutMs = 20_000) {
  fakeProvider.respondWith({ findings: [] });
  const snippet = await createSnippet({ language, code });
  const started = await startReview(snippet.id);
  return waitForReview(started.id, { timeoutMs });
}

describe('STA-1: SQL parentheses that do not balance or nest more than 8 deep', () => {
  it('the 35-character snippet comes back as sql/syntax-error in milliseconds, without the parser', async () => {
    const code = 'SELECT (((((((((((((((((((1 FROM t;';
    const t = Date.now();
    const out = await analyzeSnippet('sql', code);
    expect(Date.now() - t).toBeLessThan(200);
    expect(out.parseOk).toBe(false);
    expect(out.findings.map((f) => [f.ruleId, f.lineStart, f.severity, f.category])).toEqual([['sql/syntax-error', 1, 'critical', 'bug']]);
  });

  it('an unclosed "(" or a stray ")" is a syntax error on its line, and the fix checker sees it too', async () => {
    const open = await analyzeSnippet('sql', 'SELECT 1;\nSELECT (((1 FROM t;');
    expect(open.findings.map((f) => [f.ruleId, f.lineStart])).toEqual([['sql/syntax-error', 2]]);
    expect(open.parseError).toBe('line 2: a "(" that is never closed');
    const stray = await analyzeSnippet('sql', 'SELECT 1)\nFROM t;');
    expect(stray.parseError).toBe('line 1: a ")" with no "(" before it');
    expect(await sqlAnalyzer.parses('SELECT ((((((((((1 FROM t;', 'sql')).toEqual({ ok: false, error: 'line 1: parentheses nested more than 8 deep' });
  });

  it('balanced nesting up to 8 deep still parses; 9 deep is refused', async () => {
    const at = (n: number) => `SELECT ${'('.repeat(n)}1${')'.repeat(n)} FROM t;`;
    expect((await analyzeSnippet('sql', at(8))).parseOk).toBe(true);
    const nine = await analyzeSnippet('sql', at(9));
    expect(nine.parseOk).toBe(false);
    expect(nine.findings[0].description).toMatch(/more than 8 deep on line 1/);
  });

  it('parentheses inside strings, comments and quoted identifiers are not counted', async () => {
    const code = `SELECT '(((', "a(" AS x -- ((((\nFROM t /* )) */ WHERE a = ')';`;
    expect((await analyzeSnippet('sql', code)).parseOk).toBe(true);
  });

  it('end to end: the review finishes with the syntax error, and the model still runs', async () => {
    const done = await review('sql', 'SELECT (((((((((((((((((((1 FROM t;');
    expect(done.status).toBe('done');
    expect(done.analysisError).toBeNull();
    expect(ids(done.findings)).toEqual(['sql/syntax-error']);
    expect(fakeProvider.lastInput).toBeDefined();
  });
});

describe('STA-1/STA-2: a snippet whose analysis is too slow is cut off, and the API keeps answering', () => {
  it('answers /health while the analysis of a hostile snippet runs and is stopped at 5 s; the review goes on model-only', async () => {
    // 570 statements within the parenthesis limit, each ~90 ms of parser backtracking: about 50 s in all.
    const code = 'SELECT ((((((((1 +)))))))) FROM t;\n'.repeat(570);
    fakeProvider.respondWith({ findings: [] });
    const snippet = await createSnippet({ language: 'sql', code });
    const started = await startReview(snippet.id);
    const finished = waitForReview(started.id, { timeoutMs: 20_000 });
    const probes = await probeHealth(finished);
    const done = await finished;

    expect(done.status).toBe('done');
    expect(done.analysisError).toBe('it took longer than 5 s');
    expect(done.phaseTimings.static).toBeGreaterThanOrEqual(5000);
    expect(done.phaseTimings.static).toBeLessThan(7000);
    expect(done.findings).toEqual([]);
    expect(done.staticSupported).toBe(true);
    expect(fakeProvider.lastInput).toBeDefined(); // the model reviewed the code alone
    expect(probes.length).toBeGreaterThan(20);
    expect(Math.max(...probes)).toBeLessThan(500);

    const events = (await api().get(`${V1}/reviews/${started.id}/events`)).body.data.items;
    const parsed = events.find((e: { type: string }) => e.type === 'static.parsed');
    expect(parsed.payload.parseError).toBe('static analysis stopped: it took longer than 5 s');
    expect(events.map((e: { type: string }) => e.type)).toContain('review.done');
  });
});

describe('STA-2: a review with many fixable findings', () => {
  it('checks at most 50 fixes, against one analysis of the unfixed code, while the API keeps answering (JavaScript, 1000 findings)', async () => {
    let code = '';
    for (let i = 0; i < 1000; i++) code += `if (a == b) f(${i});\n`;
    fakeProvider.respondWith({ findings: [] });
    const snippet = await createSnippet({ language: 'javascript', code });
    const started = await startReview(snippet.id);
    const finished = waitForReview(started.id, { timeoutMs: 25_000 });
    const probes = await probeHealth(finished);
    const done = await finished;

    expect(done.status).toBe('done');
    expect(done.findings).toHaveLength(1000);
    const counts: Record<string, number> = {};
    for (const f of done.findings) counts[f.fixCheck] = (counts[f.fixCheck] ?? 0) + 1;
    expect(counts).toEqual({ passed: 50, not_checked: 950 });
    const unchecked = done.findings.filter((f: { fixCheck: string }) => f.fixCheck === 'not_checked');
    expect(new Set(unchecked.map((f: { fixCheckDetail: { note: string } }) => f.fixCheckDetail.note))).toEqual(
      new Set(['not checked: over the 50-fix limit']),
    );
    // The first 50 in line order are the ones checked.
    expect(done.findings.slice(0, 50).every((f: { fixCheck: string }) => f.fixCheck === 'passed')).toBe(true);
    expect(done.phaseTimings.checking).toBeLessThan(5000);
    expect(Math.max(...probes)).toBeLessThan(500);
  });

  it('Python, 500 bare excepts: finishes in seconds, not minutes, with 50 fixes checked', async () => {
    const code = 'try: c.execute(q)\nexcept: pass\n'.repeat(500);
    const done = await review('python', code);
    expect(done.status).toBe('done');
    expect(done.analysisError).toBeNull();
    const fixed = done.findings.filter((f: { fix: unknown }) => f.fix);
    expect(fixed).toHaveLength(500);
    expect(fixed.filter((f: { fixCheck: string }) => f.fixCheck === 'passed')).toHaveLength(50);
    expect(done.phaseTimings.static).toBeLessThan(5000);
    expect(done.phaseTimings.checking).toBeLessThan(5000);
  });
});

describe('STA-4/STA-5: the rules of every detected context run, not only the winning one', () => {
  it('STA-4: a Next.js route handler keeps js/sql-string-concat; the label stays the winning context', async () => {
    const code = [
      "import { NextResponse } from 'next/server';",
      "import { db } from '@/lib/db';",
      '',
      'export async function GET(request: Request) {',
      "  const id = new URL(request.url).searchParams.get('id');",
      "  const rows = await db.query('SELECT * FROM users WHERE id = ' + id);",
      '  return NextResponse.json(rows);',
      '}',
    ].join('\n');
    const out = await analyzeSnippet('typescript', code);
    expect(out.detected.context).toBe('frontend');
    expect(out.findings.filter((f) => f.ruleId === 'js/sql-string-concat').map((f) => f.lineStart)).toEqual([6]);
  });

  it('STA-5: an Express file that calls it.next() keeps its backend rules', async () => {
    const code = [
      "const express = require('express');",
      'const app = express();',
      '',
      "app.get('/users', async (req, res) => {",
      "  const it = req.query.ids.split(',')[Symbol.iterator]();",
      '  const first = it.next().value;',
      "  const rows = await db.query('SELECT * FROM users WHERE id = ' + first);",
      '  res.json(rows);',
      '});',
    ].join('\n');
    const out = await analyzeSnippet('javascript', code);
    expect(out.detected.context).toBe('test');
    expect(out.findings.filter((f) => f.ruleId === 'js/sql-string-concat').map((f) => f.lineStart)).toEqual([7]);
  });
});

describe('STA-10: deep recursion in the Python analyzer', () => {
  it('a valid 7000-attribute chain is analysed, not thrown on', async () => {
    const code = `x = a${'.b'.repeat(7000)}()\n`;
    const out = await analyzeSnippet('python', code);
    expect(out.parseOk).toBe(true);
  });

  it('end to end: the review is done and reached the model, not "failed unexpectedly"', async () => {
    const done = await review('python', `x = a${'.b'.repeat(7000)}()\n`);
    expect(done.status).toBe('done');
    expect(done.error).toBeNull();
    expect(fakeProvider.lastInput).toBeDefined();
  });

  it('a long chain of + inside an execute() is still read (plusOperands is iterative)', async () => {
    const code = `cur.execute("SELECT " + ${Array.from({ length: 3000 }, (_, i) => `v${i}`).join(' + ')})\n`;
    const out = await analyzeSnippet('python', code);
    expect(out.parseOk).toBe(true);
    expect(ids(out.findings)).toContain('py/sql-string-concat');
  });
});
