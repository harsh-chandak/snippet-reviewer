// The limits on the static step of one review (the decisions 'static analysis limits' and 'fix
// check budget'). The analysis and the fix checks run in a worker thread (./guard.ts), so a
// snippet that is slow or huge to analyse costs its own review, never the API.

// Wall-clock limit for each worker run (the static step, then the fix checks), from spawn to result.
export const STATIC_TIME_LIMIT_MS = 5000;
// Heap limit for that worker.
export const STATIC_HEAP_LIMIT_MB = 256;
// At most this many fixes are checked per review; the rest stay not_checked with OVER_FIX_LIMIT_NOTE.
export const MAX_FIX_CHECKS = 50;
export const OVER_FIX_LIMIT_NOTE = `not checked: over the ${MAX_FIX_CHECKS}-fix limit`;

// Thrown by an analyzer for input it refuses to analyse; the message is plain words for the user
// ("the code is nested too deeply to analyze") and becomes the review's analysisError.
export class AnalysisLimitError extends Error {}
