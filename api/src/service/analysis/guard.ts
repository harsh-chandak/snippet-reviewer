import path from 'path';
import { Worker } from 'worker_threads';
import { CodeContext, Language } from '../../model/constants';
import type { FixCheckInput, FixCheckResult } from './fixCheck';
import { STATIC_HEAP_LIMIT_MB, STATIC_TIME_LIMIT_MS } from './limits';
import type { AnalysisResult } from './types';

// Runs a review's static work in a worker thread with a wall-clock and a heap limit (the decision
// 'static analysis limits'). The analyzers are synchronous CPU work: on the main thread one hostile
// snippet froze every request (STA-2) or ran the whole API out of memory (STA-1). In a worker it
// can only use up its own limits; the API keeps answering, and the worker is terminated when the
// time is up. Never throws: the caller gets the value, or the reason in plain words.

export type WorkerTask =
  | { kind: 'analyze'; language: Language; code: string; userContext: CodeContext | null }
  | { kind: 'checkFixes'; language: Language; code: string; fixes: FixCheckInput[] };

export type WorkerMessage =
  | { type: 'result'; value: AnalysisResult | null }
  | { type: 'fix'; index: number; result: FixCheckResult | null }
  // reason: plain words for the user, or null for an unexpected error (detail is logged, not shown).
  | { type: 'error'; reason: string | null; detail: string | null };

export type GuardedResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface GuardLimits {
  timeMs: number;
  heapMb: number;
}

const DEFAULT_LIMITS: GuardLimits = { timeMs: STATIC_TIME_LIMIT_MS, heapMb: STATIC_HEAP_LIMIT_MB };
const INTERNAL_ERROR = 'the analyzer stopped with an internal error';

// Under ts-node (development, tests) the worker registers ts-node itself, transpile-only, since a
// worker doesn't inherit the main thread's require hook; after a build it is plain worker.js.
const WORKER_FILE = path.join(__dirname, `worker${path.extname(__filename) || '.js'}`);

function spawn(heapMb: number): Worker {
  const options = {
    resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: Math.min(32, heapMb) },
  };
  const worker = WORKER_FILE.endsWith('.ts')
    ? new Worker(
        `require('ts-node').register({ transpileOnly: true, projectSearchDir: ${JSON.stringify(__dirname)} });
require(${JSON.stringify(WORKER_FILE)});`,
        { ...options, eval: true },
      )
    : new Worker(WORKER_FILE, options);
  return worker;
}

// Workers are kept between runs (at most MAX_IDLE idle ones), because loading the analyzers (the
// TypeScript compiler, node-sql-parser, the tree-sitter wasm) takes a few hundred ms. A worker runs
// one task at a time; one that hit a limit or failed is terminated, never reused, so a run starts
// with a heap holding nothing but the analyzers and what earlier runs left as garbage.
// Listeners are added and removed one by one: Worker keeps internal listeners of its own, so
// removeAllListeners() would break its message delivery.
const MAX_IDLE = 2;
const idle: { worker: Worker; dropped: () => void }[] = [];

function park(worker: Worker) {
  // An idle worker must not keep the process alive, and one that dies while idle is dropped.
  worker.unref();
  const entry = {
    worker,
    dropped: () => {
      const i = idle.indexOf(entry);
      if (i >= 0) idle.splice(i, 1);
    },
  };
  worker.once('exit', entry.dropped);
  worker.on('error', entry.dropped);
  idle.push(entry);
}

function takeWorker(heapMb: number): Worker {
  const entry = heapMb === STATIC_HEAP_LIMIT_MB ? idle.pop() : undefined;
  if (entry) {
    entry.worker.off('exit', entry.dropped);
    entry.worker.off('error', entry.dropped);
  }
  const taken = entry?.worker ?? spawn(heapMb);
  taken.ref();
  return taken;
}

// After a run that ended with its result: keep the worker for the next one, or end it.
function release(worker: Worker, heapMb: number) {
  if (heapMb === STATIC_HEAP_LIMIT_MB && idle.length < MAX_IDLE) park(worker);
  else worker.terminate().catch(() => undefined);
}

function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))} s`;
}

// Runs `task` in a worker; the time limit counts from when the task is handed over. onFix receives
// each fix check result as it arrives, so the caller keeps those even if the run is then cut off.
export function runGuarded<T extends AnalysisResult | null>(
  task: WorkerTask,
  options: { limits?: Partial<GuardLimits>; onFix?: (index: number, result: FixCheckResult | null) => void; label?: string } = {},
): Promise<GuardedResult<T>> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const label = options.label ?? 'static analysis';
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker | undefined;
    const detach = () => {
      worker?.off('message', onMessage);
      worker?.off('error', onError);
      worker?.off('exit', onExit);
    };
    // reuse: the worker finished its task normally and can run another one.
    const finish = (result: GuardedResult<T>, reuse = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker) {
        detach();
        // A terminated worker can still emit 'error'; with no listener left that would throw here.
        if (!reuse) worker.on('error', () => undefined);
        if (reuse) release(worker, limits.heapMb);
        // terminate() stops the worker even in the middle of synchronous work.
        else worker.terminate().catch(() => undefined);
      }
      resolve(result);
    };
    const onMessage = (message: WorkerMessage) => {
      if (settled) return;
      if (message.type === 'fix') options.onFix?.(message.index, message.result);
      else if (message.type === 'result') finish({ ok: true, value: message.value as T }, true);
      else {
        if (message.detail) console.error(`[${label}] the worker threw`, message.detail);
        finish({ ok: false, reason: message.reason ?? INTERNAL_ERROR });
      }
    };
    const onError = (err: Error & { code?: string }) => {
      if (err.code === 'ERR_WORKER_OUT_OF_MEMORY') {
        finish({ ok: false, reason: `it needed more than ${limits.heapMb} MB of memory` });
      } else {
        if (!settled) console.error(`[${label}] the worker failed`, err);
        finish({ ok: false, reason: INTERNAL_ERROR });
      }
    };
    const onExit = () => finish({ ok: false, reason: INTERNAL_ERROR });
    const timer = setTimeout(() => finish({ ok: false, reason: `it took longer than ${seconds(limits.timeMs)}` }), limits.timeMs);
    try {
      worker = takeWorker(limits.heapMb);
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.postMessage(task);
    } catch (err) {
      console.error(`[${label}] could not start the worker`, err);
      finish({ ok: false, reason: INTERNAL_ERROR });
    }
  });
}

// Load one worker with the API, so the first review doesn't wait for it.
try {
  park(spawn(STATIC_HEAP_LIMIT_MB));
} catch (err) {
  console.error('[static analysis] could not start a worker', err);
}
