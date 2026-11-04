import { describe, expect, it } from 'vitest';
import { analyzeSnippet } from '../../src/service/analysis';
import { analyseUnfixed, checkFix, checkFixes, FixCheckInput, FixCheckResult } from '../../src/service/analysis/fixCheck';
import { runGuarded } from '../../src/service/analysis/guard';
import { MAX_FIX_CHECKS, OVER_FIX_LIMIT_NOTE } from '../../src/service/analysis/limits';
import { AnalysisResult } from '../../src/service/analysis/types';

// The worker guard (the decision 'static analysis limits') and the fix check budget (the decision
// 'fix check budget'), without the database.

const SLOW_SQL = 'SELECT ((((((((1 +)))))))) FROM t;\n'.repeat(200); // ~90 ms of parser work per statement

describe('runGuarded', () => {
  it('returns the analysis from the worker, the same as analyzeSnippet in-process', async () => {
    const code = 'function f(x) {\n  return x == 0;\n}';
    const run = await runGuarded<AnalysisResult>({ kind: 'analyze', language: 'javascript', code, userContext: null });
    expect(run.ok).toBe(true);
    const direct = await analyzeSnippet('javascript', code);
    expect(run.ok && { ...run.value, durationMs: 0 }).toEqual({ ...direct, durationMs: 0 });
  });

  it('stops a run at the time limit, and the main thread is free meanwhile', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const t = Date.now();
    const run = await runGuarded({ kind: 'analyze', language: 'sql', code: SLOW_SQL, userContext: null }, { limits: { timeMs: 1000 } });
    clearInterval(timer);
    expect(run).toEqual({ ok: false, reason: 'it took longer than 1 s' });
    expect(Date.now() - t).toBeLessThan(1500);
    expect(ticks).toBeGreaterThan(30); // the event loop kept turning while the worker was busy
  });

  it('reports a worker that runs out of heap in plain words, and the API process survives', async () => {
    const run = await runGuarded({ kind: 'analyze', language: 'javascript', code: 'x', userContext: null }, { limits: { heapMb: 4 } });
    expect(run).toEqual({ ok: false, reason: 'it needed more than 4 MB of memory' });
  });

  it('reports an unexpected error in the worker as an internal error, not its stack', async () => {
    const run = await runGuarded({ kind: 'checkFixes', language: 'javascript', code: 'x', fixes: null as unknown as FixCheckInput[] });
    expect(run).toEqual({ ok: false, reason: 'the analyzer stopped with an internal error' });
  });

  it('passes fix results as they arrive, so a cut-off run keeps the ones it finished', async () => {
    const code = 'SELECT a FROM t WHERE b = NULL;\n'.repeat(3) + SLOW_SQL;
    const fixes: FixCheckInput[] = [1, 2, 3].map((line) => ({
      source: 'rule',
      ruleId: 'sql/equals-null',
      fix: { lineStart: line, lineEnd: line, replacement: 'SELECT a FROM t WHERE b IS NULL;' },
    }));
    const got: (FixCheckResult | null)[] = [];
    const run = await runGuarded({ kind: 'checkFixes', language: 'sql', code, fixes }, { limits: { timeMs: 1500 }, onFix: (_i, r) => got.push(r) });
    expect(run.ok).toBe(false);
    // Each check re-parses the 200 slow statements, so not all three finish in time.
    expect(got.length).toBeLessThan(3);
  });
});

describe('fix check budget', () => {
  const code = Array.from({ length: 60 }, (_, i) => `if (a == b) f(${i});`).join('\n');

  it(`checks at most ${MAX_FIX_CHECKS} fixes; the rest are not_checked with the decided note`, async () => {
    const findings = (await analyzeSnippet('javascript', code, 'unknown')).findings;
    expect(findings).toHaveLength(60);
    const inputs: FixCheckInput[] = [
      { source: 'rule', ruleId: 'js/loose-equality', fix: null }, // no fix: skipped, not counted
      ...findings.map((f) => ({ source: 'rule' as const, ruleId: f.ruleId, fix: f.fix })),
    ];
    const results: (FixCheckResult | null)[] = [];
    await checkFixes(inputs, code, 'javascript', (i, r) => (results[i] = r));
    expect(results[0]).toBeNull();
    expect(results.slice(1, 51).every((r) => r?.fixCheck === 'passed')).toBe(true);
    expect(results.slice(51).map((r) => r)).toEqual(
      Array(10).fill({ fixCheck: 'not_checked', detail: { parses: null, ruleCleared: null, newRuleIds: [], note: OVER_FIX_LIMIT_NOTE } }),
    );
  });

  it('a check uses the unfixed analysis it is given instead of analysing the code again', async () => {
    const small = 'if (a == b) f();\neval(x);';
    const fix = { lineStart: 1, lineEnd: 1, replacement: 'if (a === b) f();' };
    const before = await analyseUnfixed(small, 'javascript');
    expect((await checkFix({ source: 'rule', ruleId: 'js/loose-equality', fix }, small, 'javascript', undefined, before)).fixCheck).toBe('passed');
    // Told the unfixed code had no findings, the eval on line 2 now counts as new: proof `before` was used.
    const told = await checkFix({ source: 'rule', ruleId: 'js/loose-equality', fix }, small, 'javascript', undefined, []);
    expect(told.detail?.newRuleIds).toEqual(['js/eval']);
  });
});
