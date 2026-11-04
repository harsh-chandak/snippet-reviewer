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
import { FixReplacement } from './analysis/types';
import { HttpError } from '../utils/httpError';
import { CodeContext, FindingSource, Language } from '../model/constants';
import { toUserMessage } from '../utils/userMessage';

// Thrown inside run() when the review is no longer in the state this run expects.
class SupersededError extends Error {}

// What run() needs from the snippet, read when the review starts.
interface SnippetForRun {
  snippetId: number;
  language: Language;
  code: string;
  context: CodeContext | null; // the user's choice; null means detect it
}

// The signal stored when the user set the context and it differs from what detection found.
const USER_SET_SIGNAL = 'set by the user';

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
        const created = await reviewDao.create({ snippetId, provider: llmService.providerName }, transaction);
        await snippetDao.setReviewStatus(snippetId, 'in_progress', transaction);
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

  // Every path ends with the review marked done or failed, so nothing is left "in progress".
  // Each step only moves the review on from the state it expects. If something else moved it
  // first (another instance marked it failed at startup, say), this run stops and writes nothing.
  //
  // Phases: static (parse, detect the context, run the rules; rule findings are saved when it ends,
  // so the page shows them while the model runs) -> model (the model gets the context, outline and
  // rule findings) -> checking (every finding with a fix gets it checked) -> done. A failure in any
  // phase fails the review; rule findings already saved stay.
  private async run(reviewId: number, snippet: SnippetForRun) {
    const { snippetId, language, code } = snippet;
    const timings: PhaseTimings = {};
    try {
      // static
      const started = await reviewDao.updateIfStatus(reviewId, ['pending'], {
        status: 'running',
        phase: 'static',
        startedAt: new Date(),
      });
      if (!started) throw new SupersededError();

      let phaseStart = Date.now();
      const analysis = await analyzeSnippet(language, code, snippet.context ?? undefined);
      timings.static = Date.now() - phaseStart;
      const context = analysis.context;
      // The why behind the context: the user's choice, or what the detection saw.
      const signals =
        snippet.context && snippet.context !== analysis.detected.context ? [USER_SET_SIGNAL] : analysis.detected.signals;

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
        return findingDao.createRuleFindings(reviewId, analysis.findings, transaction);
      });

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
      } finally {
        // Kept on failure too: "the model timed out after 120 s" is worth seeing.
        timings.model = Date.now() - phaseStart;
      }

      if (result.rejected.length) {
        console.warn(`[review ${reviewId}] dropped ${result.rejected.length} finding(s)`, result.rejected);
      }

      const toChecking = await reviewDao.updateIfStatus(reviewId, ['running'], {
        phase: 'checking',
        phaseTimings: { ...timings },
        rejectedCount: result.rejected.length,
        duplicateCount: result.duplicates,
        ...usageColumns(result.usage),
      });
      if (!toChecking) throw new SupersededError();

      // checking
      phaseStart = Date.now();
      const check = (source: FindingSource, ruleId: string | null, fix: FixReplacement | null | undefined) =>
        fix ? this.checkOne(reviewId, { source, ruleId, fix }, code, language, context) : Promise.resolve(undefined);
      const ruleChecks = await Promise.all(analysis.findings.map((f) => check('rule', f.ruleId, f.fix)));
      const modelChecks = await Promise.all(result.findings.map((f) => check('model', null, f.fix)));
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
        for (let i = 0; i < ruleRows.length; i++) {
          const checked = ruleChecks[i];
          if (checked) await findingDao.setFixCheck(ruleRows[i].id, checked, transaction);
        }
        await findingDao.createModelFindings(reviewId, result.findings, modelChecks, transaction);
        await snippetDao.setReviewStatusIfLatest(snippetId, reviewId, 'reviewed', transaction);
      });
    } catch (err) {
      if (err instanceof SupersededError) {
        console.warn(`[review ${reviewId}] was moved on by something else; leaving it as it is`);
        return;
      }
      console.error(`[review ${reviewId}] failed`, err, err instanceof LlmError ? err.cause : '');
      // Only our own LlmError messages are safe and useful to show the user.
      const message = err instanceof LlmError ? toUserMessage(err.message) : 'The review failed unexpectedly';
      await db
        .transaction(async (transaction) => {
          const failed = await reviewDao.updateIfStatus(
            reviewId,
            ['pending', 'running'],
            { status: 'failed', phase: 'failed', phaseTimings: { ...timings }, error: message, completedAt: new Date() },
            transaction,
          );
          if (failed) await snippetDao.setReviewStatusIfLatest(snippetId, reviewId, 'failed', transaction);
        })
        .catch((saveErr) => console.error(`[review ${reviewId}] could not record failure`, saveErr));
    }
  }

  // A fix checker that throws must not cost the review its findings: that fix is just not checked.
  private async checkOne(
    reviewId: number,
    finding: { source: FindingSource; ruleId: string | null; fix: FixReplacement },
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
          error: 'The server restarted before this review finished. Run it again.',
          completedAt: new Date(),
        },
        transaction,
      );
      await snippetDao.setReviewStatus(active.map((r) => r.snippetId), 'failed', transaction);
    });
    return active.length;
  }
}

export const reviewService = new ReviewService();
