import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { REVIEW_SYSTEM_PROMPT, CONTEXT_FOCUS } from './llm/prompt';
import { reviewJsonSchema } from './llm/reviewSchema';
import { COMMON_RULE_IDS } from './analysis/common';
import { JS_RULE_IDS } from './analysis/javascript/rules';
import { PYTHON_RULES, SYNTAX_ERROR_RULE_ID as PY_SYNTAX_ERROR } from './analysis/python/rules';
import { SQL_RULE_IDS } from './analysis/sql/rules';

// Version stamps put on every review, so a change in what users dismiss can be tied to the change
// that caused it. Each is the first 12 hex characters of a sha256; both are computed once, when
// this module loads at startup.

const VERSION_CHARS = 12;
const PARSER_PACKAGES = ['typescript', 'web-tree-sitter', 'tree-sitter-python', 'node-sql-parser'] as const;

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, VERSION_CHARS);
}

// The installed version of a package. Some packages (web-tree-sitter) don't export their
// package.json, so this falls back to walking up from the package's entry point.
export function packageVersion(name: string): string {
  try {
    return (require(`${name}/package.json`) as { version: string }).version;
  } catch {
    // not exported; look for it on disk
  }
  try {
    let dir = path.dirname(require.resolve(name));
    for (;;) {
      const file = path.join(dir, 'package.json');
      if (fs.existsSync(file)) {
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === name && pkg.version) return pkg.version;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // not installed
  }
  return 'unknown';
}

// Every rule id any analyzer can report, sorted.
export function allRuleIds(): string[] {
  const ids = new Set<string>([
    ...JS_RULE_IDS,
    ...PYTHON_RULES.map((r) => r.id),
    PY_SYNTAX_ERROR,
    ...SQL_RULE_IDS,
    ...COMMON_RULE_IDS,
  ]);
  return [...ids].sort();
}

// Over what the model is told: the system prompt, the focus line for each context, and the JSON
// schema its answer must follow.
export function computePromptVersion(): string {
  return shortHash(
    JSON.stringify({ system: REVIEW_SYSTEM_PROMPT, contextFocus: CONTEXT_FOCUS, findingsSchema: reviewJsonSchema }),
  );
}

// Over the sorted rule ids of every analyzer and the versions of the parsers they run on.
export function computeRulesetVersion(): string {
  const parsers = Object.fromEntries(PARSER_PACKAGES.map((name) => [name, packageVersion(name)]));
  return shortHash(JSON.stringify({ ruleIds: allRuleIds(), parsers }));
}

export const PROMPT_VERSION = computePromptVersion();
export const RULESET_VERSION = computeRulesetVersion();
