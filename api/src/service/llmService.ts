import { anthropicProvider } from './llm/anthropicProvider';
import { claudeHeadlessProvider } from './llm/claudeHeadlessProvider';
import { fakeProvider } from './llm/fakeProvider';
import { buildReviewPrompt, REVIEW_SYSTEM_PROMPT } from './llm/prompt';
import { findingValidator, fixValidator, LlmFinding, MAX_FINDINGS, reviewJsonSchema } from './llm/reviewSchema';
import { LlmError, LlmProvider, LlmUsage } from './llm/types';
import { CodeContext, Language } from '../model/constants';
import { OutlineItem, RuleFinding } from './analysis/types';
import { codeLines } from '../utils/codeLines';

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

// What the model is given: the code, what kind of code it is and why we think so, its outline,
// and what the static rules already found (so the model doesn't repeat them).
export interface ReviewInput {
  language: Language;
  code: string;
  context: CodeContext;
  signals: string[];
  outline: OutlineItem[];
  ruleFindings: RuleFinding[];
}

// Tokens and cost of one model call; declared next to the providers that fill it in.
export type { LlmUsage };

export interface ReviewResult {
  findings: LlmFinding[];
  // Model findings dropped because a rule already reported the same thing.
  duplicates: number;
  usage: LlmUsage | null;
  // Findings we threw away, and why. Worth logging: a rising count means the prompt or model changed.
  rejected: { finding: unknown; reason: string }[];
}

class LlmService {
  private provider = pickProvider();

  get providerName() {
    return this.provider.name;
  }

  async reviewSnippet(input: ReviewInput): Promise<ReviewResult> {
    const { output, usage } = await this.provider.generateStructured({
      system: REVIEW_SYSTEM_PROMPT,
      prompt: buildReviewPrompt(input),
      jsonSchema: reviewJsonSchema,
    });

    const items = (output as { findings?: unknown })?.findings;
    if (!Array.isArray(items)) {
      throw new LlmError('The model returned an answer without a findings list');
    }

    const lineCount = codeLines(input.code).length;
    // The prompt lists the rule findings as already reported; a model finding on the same first
    // line and category is that same finding again.
    const reported = new Set(input.ruleFindings.map((f) => `${f.lineStart}:${f.category}`));
    const result: ReviewResult = { findings: [], rejected: [], duplicates: 0, usage };

    for (const item of items) {
      const { error, value } = findingValidator.validate(item, { stripUnknown: true });
      if (error) {
        result.rejected.push({ finding: item, reason: error.message });
      } else if (value.lineEnd > lineCount) {
        // The model pointed at a line that doesn't exist.
        result.rejected.push({ finding: item, reason: `line ${value.lineEnd} is past the end (${lineCount} lines)` });
      } else if (reported.has(`${value.lineStart}:${value.category}`)) {
        result.duplicates++;
      } else if (result.findings.length >= MAX_FINDINGS) {
        result.rejected.push({ finding: item, reason: `over the ${MAX_FINDINGS}-finding limit` });
      } else {
        result.findings.push({ ...value, fix: checkedFix(value.fix, lineCount) });
      }
    }

    return result;
  }
}

// The model's fix if it is well formed and inside the snippet, else null.
function checkedFix(fix: unknown, lineCount: number): LlmFinding['fix'] {
  if (fix === undefined || fix === null) return null;
  const { error, value } = fixValidator.validate(fix, { stripUnknown: true });
  if (error || value.lineEnd > lineCount) return null;
  return value;
}

export const llmService = new LlmService();
