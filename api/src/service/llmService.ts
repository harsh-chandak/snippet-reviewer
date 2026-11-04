import { anthropicProvider } from './llm/anthropicProvider';
import { claudeHeadlessProvider } from './llm/claudeHeadlessProvider';
import { fakeProvider } from './llm/fakeProvider';
import { buildReviewPrompt, MAX_OUTLINE_ITEMS, REVIEW_SYSTEM_PROMPT } from './llm/prompt';
import { cleanSummary, findingValidator, fixValidator, LlmFinding, MAX_FINDINGS, reviewJsonSchema } from './llm/reviewSchema';
import { LlmError, LlmProvider, LlmUsage } from './llm/types';
import { CATEGORIES, CodeContext, Language } from '../model/constants';
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

// What the prompt carried besides the code, for the event log.
export interface PromptSent {
  promptChars: number;
  hintsSent: number; // rule findings listed as already reported
  outlineItemsSent: number;
}

// A model finding dropped because a rule had already reported it: where, and which rule.
export interface DuplicateHit {
  lineStart: number;
  category: (typeof CATEGORIES)[number];
  ruleId: string;
}

export interface ReviewResult {
  findings: LlmFinding[];
  // The model's short overview, cleaned (see cleanSummary); null when it wrote none or an invalid one.
  summary: string | null;
  // Model findings dropped because a rule already reported the same thing: how many, and each one.
  duplicates: number;
  duplicateHits: DuplicateHit[];
  usage: LlmUsage | null;
  // Findings we threw away, and why. Worth logging: a rising count means the prompt or model changed.
  // `finding` is the model's suggestion exactly as it came.
  rejected: { finding: unknown; reason: string }[];
  sent: PromptSent;
}

class LlmService {
  private provider = pickProvider();

  get providerName() {
    return this.provider.name;
  }

  async reviewSnippet(input: ReviewInput): Promise<ReviewResult> {
    const prompt = buildReviewPrompt(input);
    const sent: PromptSent = {
      promptChars: prompt.length,
      hintsSent: input.ruleFindings.length,
      outlineItemsSent: Math.min(input.outline.length, MAX_OUTLINE_ITEMS),
    };
    const { output, usage } = await this.provider.generateStructured({
      system: REVIEW_SYSTEM_PROMPT,
      prompt,
      jsonSchema: reviewJsonSchema,
    });

    const items = (output as { findings?: unknown })?.findings;
    if (!Array.isArray(items)) {
      throw new LlmError('The model returned an answer without a findings list');
    }

    const lineCount = codeLines(input.code).length;
    // The prompt lists the rule findings as already reported; a model finding on the same first
    // line and category is that same finding again.
    // line:category -> the first rule that reported it.
    const reported = new Map<string, string>();
    for (const f of input.ruleFindings) {
      const key = `${f.lineStart}:${f.category}`;
      if (!reported.has(key)) reported.set(key, f.ruleId);
    }
    const summary = cleanSummary((output as { summary?: unknown }).summary);
    const result: ReviewResult = { findings: [], summary, rejected: [], duplicates: 0, duplicateHits: [], usage, sent };

    for (const item of items) {
      const { error, value } = findingValidator.validate(withoutNulText(item), { stripUnknown: true });
      if (error) {
        result.rejected.push({ finding: item, reason: error.message });
      } else if (value.lineEnd > lineCount) {
        // The model pointed at a line that doesn't exist.
        result.rejected.push({ finding: item, reason: `line ${value.lineEnd} is past the end (${lineCount} lines)` });
      } else if (reported.has(`${value.lineStart}:${value.category}`)) {
        result.duplicates++;
        result.duplicateHits.push({
          lineStart: value.lineStart,
          category: value.category,
          ruleId: reported.get(`${value.lineStart}:${value.category}`)!,
        });
      } else if (result.findings.length >= MAX_FINDINGS) {
        result.rejected.push({ finding: item, reason: `over the ${MAX_FINDINGS}-finding limit` });
      } else {
        result.findings.push({ ...value, fix: checkedFix(value.fix, lineCount) });
      }
    }

    return result;
  }
}

// Postgres refuses U+0000 in text and jsonb, so one NUL from the model would fail the whole review
// when its findings are saved. It is removed from the description and suggested fix before they are
// validated (so a description that was only NULs is still rejected as empty).
function withoutNulText(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const key of ['description', 'suggestedFix']) {
    if (typeof out[key] === 'string') out[key] = (out[key] as string).replace(/\u0000/g, '');
  }
  return out;
}

// The model's fix if it is well formed and inside the snippet, else null. A replacement holding a
// NUL is dropped rather than edited: removing characters from code changes what the fix does.
function checkedFix(fix: unknown, lineCount: number): LlmFinding['fix'] {
  if (fix === undefined || fix === null) return null;
  const { error, value } = fixValidator.validate(fix, { stripUnknown: true });
  if (error || value.lineEnd > lineCount || value.replacement.includes('\u0000')) return null;
  return value;
}

export const llmService = new LlmService();
