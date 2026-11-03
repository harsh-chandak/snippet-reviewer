import { anthropicProvider } from './llm/anthropicProvider';
import { claudeHeadlessProvider } from './llm/claudeHeadlessProvider';
import { fakeProvider } from './llm/fakeProvider';
import { buildReviewPrompt, REVIEW_SYSTEM_PROMPT } from './llm/prompt';
import { findingValidator, LlmFinding, reviewJsonSchema } from './llm/reviewSchema';
import { LlmError, LlmProvider } from './llm/types';

function pickProvider(): LlmProvider {
  const name = process.env.LLM_PROVIDER || 'claude-headless';
  switch (name) {
    case 'claude-headless':
      return claudeHeadlessProvider;
    case 'anthropic':
      return anthropicProvider;
    // Tests only: answers are queued by the test, no model is called.
    case 'fake':
      return fakeProvider;
    default:
      throw new Error(`Unknown LLM_PROVIDER "${name}"`);
  }
}

export interface ReviewResult {
  findings: LlmFinding[];
  // Findings we threw away, and why. Worth logging: a rising count means the prompt or model changed.
  rejected: { finding: unknown; reason: string }[];
}

class LlmService {
  private provider = pickProvider();

  get providerName() {
    return this.provider.name;
  }

  async reviewSnippet(language: string, code: string): Promise<ReviewResult> {
    const raw = await this.provider.generateStructured({
      system: REVIEW_SYSTEM_PROMPT,
      prompt: buildReviewPrompt(language, code),
      jsonSchema: reviewJsonSchema,
    });

    const items = (raw as { findings?: unknown })?.findings;
    if (!Array.isArray(items)) {
      throw new LlmError('The model returned an answer without a findings list');
    }

    const lineCount = code.split('\n').length;
    const result: ReviewResult = { findings: [], rejected: [] };

    for (const item of items) {
      const { error, value } = findingValidator.validate(item, { stripUnknown: true });
      if (error) {
        result.rejected.push({ finding: item, reason: error.message });
      } else if (value.lineEnd > lineCount) {
        // The model pointed at a line that doesn't exist.
        result.rejected.push({ finding: item, reason: `line ${value.lineEnd} is past the end (${lineCount} lines)` });
      } else {
        result.findings.push(value);
      }
    }

    return result;
  }
}

export const llmService = new LlmService();
