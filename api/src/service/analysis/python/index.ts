import { Node } from 'web-tree-sitter';
import { CodeContext } from '../../../model/constants';
import { AnalysisLimitError } from '../limits';
import { AnalysisOutput, LanguageAnalyzer, OutlineItem, RuleFinding } from '../types';
import { detectContext } from './context';
import { findSyntaxError, withTree } from './parser';
import { runRules, SYNTAX_ERROR_RULE_ID } from './rules';
import { collectImports, descendants, SourceLines } from './syntax';

// Python static analysis on tree-sitter-python: parse errors, an outline of functions, classes
// and methods, the detected context with its signals, and the rules in ./rules.ts.

function outline(root: Node, src: SourceLines): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const def of descendants(root, ['function_definition', 'class_definition'])) {
    const name = def.childForFieldName('name')?.text;
    if (!name) continue;
    // A decorated definition's lines include its decorators.
    const span = def.parent?.type === 'decorated_definition' ? def.parent : def;
    let kind: OutlineItem['kind'] = def.type === 'class_definition' ? 'class' : 'function';
    let qualified = name;
    if (kind === 'function') {
      const owner = owningDefinition(span);
      if (owner?.type === 'class_definition') {
        kind = 'method';
        qualified = `${owner.childForFieldName('name')?.text ?? '?'}.${name}`;
      }
    }
    items.push({ kind, name: qualified, lineStart: src.startLine(span), lineEnd: src.endLine(span) });
  }
  return items.sort((a, b) => a.lineStart - b.lineStart);
}

// The nearest class or function a definition sits in.
function owningDefinition(node: Node): Node | null {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'class_definition' || p.type === 'function_definition') return p;
  }
  return null;
}

function syntaxErrorFinding(line: number, message: string): RuleFinding {
  return {
    ruleId: SYNTAX_ERROR_RULE_ID,
    lineStart: line,
    lineEnd: line,
    severity: 'critical',
    category: 'bug',
    description: `${message}. Python will refuse to run this file.`,
    suggestedFix: null,
    fix: null,
  };
}

// The helpers walk long chains in loops, but the rules still recurse over the tree in places; code
// nested deeply enough to overflow the stack is refused in plain words instead of failing the
// review with a RangeError (STA-10). The review then goes on model-only.
async function guardDepth<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof RangeError) throw new AnalysisLimitError('the code is nested too deeply to analyze');
    throw err;
  }
}

export const pythonAnalyzer: LanguageAnalyzer = {
  languages: ['python'],

  async analyze(code: string, _language, context?: CodeContext): Promise<AnalysisOutput> {
    return guardDepth(() => withTree(code, (tree) => {
      const root = tree.rootNode;
      const src = new SourceLines(code);
      const imports = collectImports(root);
      const detected = detectContext(root, imports);
      const items = outline(root, src);
      const error = findSyntaxError(root, (n) => src.startLine(n));
      if (error) {
        // Code that doesn't parse gets exactly one finding: the first syntax error.
        const finding = syntaxErrorFinding(error.line, error.message);
        return { parseOk: false, parseError: error.message, detected, outline: items, findings: [finding] };
      }
      const findings = runRules({ root, src, imports }, context ?? detected.context);
      return { parseOk: true, parseError: null, detected, outline: items, findings };
    }));
  },

  async parses(code: string) {
    return guardDepth(() => withTree(code, (tree) => {
      const src = new SourceLines(code);
      const error = findSyntaxError(tree.rootNode, (n) => src.startLine(n));
      return error ? { ok: false, error: error.message } : { ok: true, error: null };
    }));
  },
};
