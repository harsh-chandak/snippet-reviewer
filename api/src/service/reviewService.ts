import { UniqueConstraintError } from 'sequelize';
import db from '../db/postgres';
import { snippetDao } from '../model/dao/SnippetDao';
import { reviewDao } from '../model/dao/ReviewDao';
import { CheckedFix, findingDao } from '../model/dao/FindingDao';
import { ReviewUpdate } from '../model/dao/ReviewDao';
import type { PhaseTimings } from '../model/schema/Review';
import { llmService, LlmUsage } from './llmService';
import { LlmError } from './llm/types';
import { analyzeSnippet } from './analysis';
import { checkFix } from './analysis/fixCheck';
import { AnalysisResult, FixReplacement, RuleFinding } from './analysis/types';
import { HttpError } from '../utils/httpError';
import { CodeContext, FindingSource, Language, ReviewPhase } from '../model/constants';
import { toUserMessage } from '../utils/userMessage';
import { event, rawSuggestion, ReviewEventBuffer, reviewEventService, totalInputTokens } from './reviewEventService';
import { PROMPT_VERSION, RULESET_VERSION } from './versions';

// Thrown inside run() when the review is no longer in the state this run expects.
class SupersededError extends Error {}

// What run() needs from the snippet, read when the review starts.
interface SnippetForRun {
  snippetId: number;
  language: Language;
  code: string;
  context: CodeContext | null; // the user's choice; null means detect it
}

const INTERRUPTED_MESSAGE = 'The server restarted before this review finished. Run it again.';

// Only our own LlmError messages are safe and useful to show the user.
function failureMessage(err: unknown): string {
  return err instanceof LlmError ? toUserMessage(err.message) : 'The review failed unexpectedly';
}

function fixCheckedEvent(findingId: number, source: FindingSource, ruleId: string | null, checked: CheckedFix) {
  return event('fix.checked', {
    findingId,
    source,
    ruleId,
    fixCheck: checked.fixCheck,
    parses: checked.fixCheckDetail?.parses ?? null,
    ruleCleared: checked.fixCheckDetail?.ruleCleared ?? null,
    newRuleIds: checked.fixCheckDetail?.newRuleIds ?? [],
  });
}

// Token counts are stored in int4 columns: a count past that (a broken or hostile CLI) is clamped
// before it is saved or logged, so it can't fail a review the model already answered (PIPE-4).
const MAX_TOKEN_COUNT = 2147483647;

function clampUsage(usage: LlmUsage | null): LlmUsage | null {
  if (!usage) return null;
  const clamp = (n: number) => Math.min(n, MAX_TOKEN_COUNT);
  return {
    ...usage,
    inputTokens: clamp(usage.inputTokens),
    outputTokens: clamp(usage.outputTokens),
    cacheReadTokens: clamp(usage.cacheReadTokens),
    cacheWriteTokens: clamp(usage.cacheWriteTokens),
  };
}

// The phases a step list shows; a failure in one of them is recorded as phaseTimings.failedPhase.
type StepPhase = NonNullable<PhaseTimings['failedPhase']>;
const STEP_PHASES: readonly StepPhase[] = ['static', 'model', 'checking'];
const isStepPhase = (phase: ReviewPhase): phase is StepPhase => (STEP_PHASES as readonly string[]).includes(phase);

// The timings to save on a failed review, with the phase it failed in (the decision 'failed step
// on the page'), so the page doesn't have to infer it from which timings are missing.
function failedTimings(timings: PhaseTimings, phase: ReviewPhase): PhaseTimings {
  return isStepPhase(phase) ? { ...timings, failedPhase: phase } : { ...timings };
}

// The same rule hit, found by both runs of the analyzer.
const ruleKey = (f: RuleFinding) => `${f.ruleId}:${f.lineStart}`;

// The static step. A user-set context can add rules, never remove them (the decision 'user context
// and rules'): when it differs from the detected one, the rules run for both contexts and the
// findings are merged, one per (ruleId, lineStart), in line order. The result's context is the
// user's choice; its detected signals are what detection saw.
async function analyzeForReview(language: Language, code: string, userContext: CodeContext | null): Promise<AnalysisResult> {
  const chosen = await analyzeSnippet(language, code, userContext ?? undefined);
  if (!userContext || userContext === chosen.detected.context) return chosen;
  const detected = await analyzeSnippet(language, code);
  const seen = new Set(chosen.findings.map(ruleKey));
  const findings = [...chosen.findings, ...detected.findings.filter((f) => !seen.has(ruleKey(f)))]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.lineStart - b.f.lineStart || a.i - b.i)
    .map(({ f }) => f);
  return { ...chosen, findings, durationMs: chosen.durationMs + detected.durationMs };
}

function usageColumns(usage: LlmUsage | null): ReviewUpdate {
  if (!usage) return {};
  return {
    model: usage.model.slice(0, 80), // the column is varchar(80)
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    costUsd: usage.costUsd,
    costSource: usage.costSource,
  };
}

class ReviewService {
  // Records the review and returns at once. The model call runs in the background;
  // the client polls GET /reviews/:id to follow it.
  async start(snippetId: number) {
    const snippet = await snippetDao.findById(snippetId);
    if (!snippet) throw new HttpError(404, 'Snippet not found');

    let review;
    try {
      review = await db.transaction(async (transaction) => {
        const provider = llmService.providerName;
        const created = await reviewDao.create(
          { snippetId, provider, promptVersion: PROMPT_VERSION, rulesetVersion: RULESET_VERSION },
          transaction,
        );
        await snippetDao.setReviewStatus(snippetId, 'in_progress', transaction);
        await reviewEventService.append(created.id, [event('review.started', { provider })], transaction);
        return created;
      });
    } catch (err) {
      // The partial unique index refused a second active review for this snippet.
      if (err instanceof UniqueConstraintError) {
        throw new HttpError(409, 'A review is already in progress for this snippet');
      }
      throw err;
    }

    setImmediate(() => {
      this.run(review.id, { snippetId, language: snippet.language, code: snippet.code, context: snippet.context });
    });
    return review;
  }

  async get(reviewId: number) {
    const review = await reviewDao.findByIdWithFindings(reviewId);
    if (!review) throw new HttpError(404, 'Review not found');
    return review;
  }

  async events(reviewId: number) {
    return reviewEventService.listForReview(reviewId);
  }

  // Every path ends with the review marked done or failed, so nothing is left "in progress".
  // Each step only moves the review on from the state it expects. If something else moved it
  // first (another instance marked it failed at startup, say), this run stops and writes nothing.
  //
  // Phases: static (parse, detect the context, run the rules; rule findings are saved when it ends,
  // so the page shows them while the model runs) -> model (the model gets the context, outline and
  // rule findings) -> checking (every finding with a fix gets it checked) -> done. A failure in any
  // phase fails the review; rule findings already saved stay.
  //
  // Each step's events go into the review's event log in the same transaction that saves the
  // step's results, so the log never claims something that wasn't saved.
  private async run(reviewId: number, snippet: SnippetForRun) {
    const { snippetId, language, code } = snippet;
    const timings: PhaseTimings = {};
    const runStart = Date.now();
    const events = new ReviewEventBuffer(reviewId);
    let phase: ReviewPhase = 'queued';
    let modelFailure: { message: string; ms: number } | null = null;
    try {
      // static
      const started = await reviewDao.updateIfStatus(reviewId, ['pending'], {
        status: 'running',
        phase: 'static',
        startedAt: new Date(),
      });
      if (!started) throw new SupersededError();
      phase = 'static';

      let phaseStart = Date.now();
      const analysis = await analyzeForReview(language, code, snippet.context);
      timings.static = Date.now() - phaseStart;
      const context = analysis.context;
      // What detection saw, also when the user chose another context: their choice is on the
      // snippet (snippets.context), so the page can show both.
      const signals = analysis.detected.signals;

      const ruleRows = await db.transaction(async (transaction) => {
        const moved = await reviewDao.updateIfStatus(
          reviewId,
          ['running'],
          {
            phase: 'model',
            phaseTimings: { ...timings },
            context,
            contextSignals: signals,
            staticSupported: analysis.supported,
          },
          transaction,
        );
        if (!moved) throw new SupersededError();
        const rows = await findingDao.createRuleFindings(reviewId, analysis.findings, transaction);
        events.add(
          event('static.parsed', {
            supported: analysis.supported,
            parseOk: analysis.parseOk,
            parseError: analysis.parseError,
            context,
            signals,
            outlineItems: analysis.outline.length,
            ms: timings.static!,
          }),
          ...analysis.findings.map((f) =>
            event('static.rule_hit', {
              ruleId: f.ruleId,
              lineStart: f.lineStart,
              lineEnd: f.lineEnd,
              severity: f.severity,
              category: f.category,
              hasFix: !!f.fix,
            }),
          ),
        );
        await events.flush(transaction);
        return rows;
      });
      phase = 'model';

      // model
      phaseStart = Date.now();
      let result;
      try {
        result = await llmService.reviewSnippet({
          language,
          code,
          context,
          signals,
          outline: analysis.outline,
          ruleFindings: analysis.findings,
        });
      } catch (err) {
        modelFailure = { message: failureMessage(err), ms: Date.now() - phaseStart };
        throw err;
      } finally {
        // Kept on failure too: "the model timed out after 120 s" is worth seeing.
        timings.model = Date.now() - phaseStart;
      }

      if (result.rejected.length) {
        console.warn(`[review ${reviewId}] dropped ${result.rejected.length} finding(s)`, result.rejected);
      }

      const modelResult = { ...result, usage: clampUsage(result.usage) };
      await db.transaction(async (transaction) => {
        const toChecking = await reviewDao.updateIfStatus(
          reviewId,
          ['running'],
          {
            phase: 'checking',
            phaseTimings: { ...timings },
            rejectedCount: modelResult.rejected.length,
            duplicateCount: modelResult.duplicates,
            ...usageColumns(modelResult.usage),
          },
          transaction,
        );
        if (!toChecking) throw new SupersededError();
        const usage = modelResult.usage;
        events.add(
          event('model.called', {
            provider: llmService.providerName,
            model: usage?.model ?? null,
            promptVersion: PROMPT_VERSION,
            context,
            ...modelResult.sent,
            inputTokens: usage?.inputTokens ?? null,
            outputTokens: usage?.outputTokens ?? null,
            cacheReadTokens: usage?.cacheReadTokens ?? null,
            cacheWriteTokens: usage?.cacheWriteTokens ?? null,
            totalInputTokens: usage ? totalInputTokens(usage) : null,
            costUsd: usage?.costUsd ?? null,
            costSource: usage?.costSource ?? null,
            ms: timings.model!,
          }),
          ...modelResult.rejected.map((r) =>
            event('model.finding_rejected', { reason: r.reason, raw: rawSuggestion(r.finding) }),
          ),
          ...modelResult.duplicateHits.map((d) => event('model.duplicate', d)),
        );
        await events.flush(transaction);
      });
      phase = 'checking';

      // checking
      phaseStart = Date.now();
      // The finding's own lines go with it, so a model fix that strays from them fails (model fix locality).
      const check = (
        source: FindingSource,
        ruleId: string | null,
        f: { fix?: FixReplacement | null; lineStart: number; lineEnd: number },
      ) =>
        f.fix
          ? this.checkOne(
              reviewId,
              { source, ruleId, fix: f.fix, lineStart: f.lineStart, lineEnd: f.lineEnd },
              code,
              language,
              context,
            )
          : Promise.resolve(undefined);
      const ruleChecks = await Promise.all(analysis.findings.map((f) => check('rule', f.ruleId, f)));
      const modelChecks = await Promise.all(modelResult.findings.map((f) => check('model', null, f)));
      timings.checking = Date.now() - phaseStart;

      // done
      await db.transaction(async (transaction) => {
        const finished = await reviewDao.updateIfStatus(
          reviewId,
          ['running'],
          { status: 'done', phase: 'done', phaseTimings: { ...timings }, completedAt: new Date() },
          transaction,
        );
        if (!finished) throw new SupersededError();
        const checkedEvents = [];
        for (let i = 0; i < ruleRows.length; i++) {
          const checked = ruleChecks[i];
          if (!checked) continue;
          await findingDao.setFixCheck(ruleRows[i].id, checked, transaction);
          checkedEvents.push(fixCheckedEvent(ruleRows[i].id, 'rule', ruleRows[i].ruleId ?? null, checked));
        }
        const modelRows = await findingDao.createModelFindings(reviewId, modelResult.findings, modelChecks, transaction);
        modelRows.forEach((row, i) => {
          const checked = modelChecks[i];
          if (checked) checkedEvents.push(fixCheckedEvent(row.id, 'model', null, checked));
        });
        await snippetDao.setReviewStatusIfLatest(snippetId, reviewId, 'reviewed', transaction);
        events.add(
          ...modelResult.findings.map((f) =>
            event('model.finding_kept', {
              lineStart: f.lineStart,
              lineEnd: f.lineEnd,
              severity: f.severity,
              category: f.category,
              hasFix: !!f.fix,
            }),
          ),
          ...checkedEvents,
          event('review.done', {
            ms: Date.now() - runStart,
            findings: ruleRows.length + modelRows.length,
            ruleFindings: ruleRows.length,
            modelFindings: modelRows.length,
          }),
        );
        await events.flush(transaction);
      });
    } catch (err) {
      if (err instanceof SupersededError) {
        console.warn(`[review ${reviewId}] was moved on by something else; leaving it as it is`);
        return;
      }
      console.error(`[review ${reviewId}] failed`, err, err instanceof LlmError ? err.cause : '');
      const message = failureMessage(err);
      // Events added for a transaction that never committed describe nothing that was saved.
      events.discard();
      await db
        .transaction(async (transaction) => {
          const failed = await reviewDao.updateIfStatus(
            reviewId,
            ['pending', 'running'],
            { status: 'failed', phase: 'failed', phaseTimings: failedTimings(timings, phase), error: message, completedAt: new Date() },
            transaction,
          );
          if (!failed) return;
          await snippetDao.setReviewStatusIfLatest(snippetId, reviewId, 'failed', transaction);
          if (modelFailure) events.add(event('model.failed', modelFailure));
          events.add(event('review.failed', { phase, message, ms: Date.now() - runStart }));
          await events.flush(transaction);
        })
        .catch((saveErr) => console.error(`[review ${reviewId}] could not record failure`, saveErr));
    }
  }

  // A fix checker that throws must not cost the review its findings: that fix is just not checked.
  private async checkOne(
    reviewId: number,
    finding: { source: FindingSource; ruleId: string | null; fix: FixReplacement; lineStart: number; lineEnd: number },
    code: string,
    language: Language,
    context: CodeContext,
  ): Promise<CheckedFix> {
    try {
      const { fixCheck, detail } = await checkFix(finding, code, language, context);
      return { fixCheck, fixCheckDetail: detail };
    } catch (err) {
      console.error(`[review ${reviewId}] fix check failed for ${finding.ruleId ?? 'a model finding'}`, err);
      return { fixCheck: 'not_checked', fixCheckDetail: null };
    }
  }

  // Runs at startup. A review still pending or running then was cut off by a restart
  // (reviews run inside this one process), so mark it failed instead of leaving it stuck.
  async failInterrupted() {
    const active = await reviewDao.findActive();
    if (!active.length) return 0;
    await db.transaction(async (transaction) => {
      await reviewDao.update(
        active.map((r) => r.id),
        {
          status: 'failed',
          phase: 'failed',
          error: INTERRUPTED_MESSAGE,
          completedAt: new Date(),
        },
        transaction,
      );
      await snippetDao.setReviewStatus(active.map((r) => r.snippetId), 'failed', transaction);
      for (const r of active) {
        await reviewDao.update(r.id, { phaseTimings: failedTimings(r.phaseTimings ?? {}, r.phase) }, transaction);
        const since = (r.startedAt ?? r.createdAt).getTime();
        await reviewEventService.append(
          r.id,
          [event('review.failed', { phase: r.phase, message: INTERRUPTED_MESSAGE, ms: Math.max(0, Date.now() - since) })],
          transaction,
        );
      }
    });
    return active.length;
  }
}

export const reviewService = new ReviewService();
