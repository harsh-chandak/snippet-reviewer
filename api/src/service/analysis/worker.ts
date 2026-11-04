import { parentPort } from 'worker_threads';
import { checkFixes } from './fixCheck';
import type { WorkerMessage, WorkerTask } from './guard';
import { AnalysisLimitError } from './limits';
import { analyzeForReview } from './review';

// The worker thread that runs one review's static step or its fix checks (see ./guard.ts). It is
// kept loaded between runs, takes one task at a time as a message, posts the results, and is
// terminated by the main thread when it runs out of time or fails. Nothing here
// touches the database.

const post = (message: WorkerMessage) => parentPort!.postMessage(message);

async function main(task: WorkerTask) {
  if (task.kind === 'analyze') {
    post({ type: 'result', value: await analyzeForReview(task.language, task.code, task.userContext) });
  } else {
    await checkFixes(task.fixes, task.code, task.language, (index, result) => post({ type: 'fix', index, result }));
    post({ type: 'result', value: null });
  }
}

// One task at a time: the main thread hands over the next only after this one's result.
parentPort!.on('message', (task: WorkerTask) => {
  main(task).catch((err: unknown) => {
    // An analyzer's own refusal is already in plain words; anything else is logged by the main thread.
    if (err instanceof AnalysisLimitError) post({ type: 'error', reason: err.message, detail: null });
    else post({ type: 'error', reason: null, detail: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  });
});
