import ts from 'typescript';
import { CodeContext } from '../../../model/constants';
import { RuleFinding } from '../types';
import { looksLikeSql } from './context';
import { Parsed } from './parse';
import {
  Declarations,
  ModuleBindings,
  calleeFromModule,
  declarations,
  derivesFrom,
  isStaticString,
  isStringLiteralLike,
  moduleBindings,
  plusOperands,
  unwrap,
} from './syntax';

// The JavaScript/TypeScript rules. Each rule runs for the contexts it lists; 'unknown' runs every
// rule, since nothing says which kind of code it is. Rules with a mechanical fix report one finding
// per line, and the fix rewrites every hit on that line, so applying it clears the rule there.

export const JS_RULE_IDS = [
  'js/syntax-error',
  'js/eval',
  'js/loose-equality',
  'js/empty-catch',
  'js/sql-string-concat',
  'js/child-process-exec',
  'js/fs-path-from-request',
  'js/dangerously-set-inner-html',
  'js/inner-html-assignment',
  'js/target-blank-noopener',
  'js/focused-test',
] as const;
export type JsRuleId = (typeof JS_RULE_IDS)[number];

interface RuleContext {
  parsed: Parsed;
  decls: Declarations;
  childProcess: ModuleBindings;
  fs: ModuleBindings;
}

interface Rule {
  id: JsRuleId;
  contexts: CodeContext[] | 'any';
  run(rc: RuleContext): RuleFinding[];
}

const BACKEND: CodeContext[] = ['backend', 'script', 'unknown'];
const FRONTEND: CodeContext[] = ['frontend', 'unknown'];
const TEST: CodeContext[] = ['test', 'unknown'];

const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const EXEC_FUNCTIONS = new Set(['exec', 'execSync']);
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'fs-extra']);
const FS_FUNCTIONS = new Set([
  'readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'createReadStream', 'createWriteStream', 'open', 'openSync', 'unlink', 'unlinkSync', 'rm', 'rmSync',
  'readdir', 'readdirSync', 'copyFile', 'copyFileSync', 'rename', 'renameSync',
]);
const FS_TWO_PATHS = new Set(['copyFile', 'copyFileSync', 'rename', 'renameSync']);
const REQUEST_ROOTS = new Set(['req', 'request']);
const SQL_METHODS = new Set(['query', 'execute', 'raw', '$queryRawUnsafe', '$executeRawUnsafe']);
const TEST_BLOCKS = new Set(['describe', 'it', 'test', 'suite', 'context']);

function finding(
  parsed: Parsed,
  id: JsRuleId,
  node: ts.Node,
  rest: Pick<RuleFinding, 'severity' | 'category' | 'description' | 'suggestedFix'>,
): RuleFinding {
  return { ruleId: id, lineStart: parsed.startLine(node), lineEnd: parsed.endLine(node), ...rest, fix: null };
}

// --- per-line findings with mechanical fixes ------------------------------------------------------

interface LineEdit {
  col: number;
  remove: number;
  insert: string;
}
interface Hit {
  line: number;
  edit: LineEdit | null; // null: this hit can't be fixed mechanically
  label: string;
}

// An edit at `pos` in the code, or null when it would cross a line break.
function editAt(parsed: Parsed, pos: number, remove: number, insert: string): { line: number; edit: LineEdit } | null {
  if (parsed.code.slice(pos, pos + remove).includes('\n')) return null;
  const line = parsed.lineOf(pos);
  return { line, edit: { col: pos - parsed.lineStartOffset(line), remove, insert } };
}

function perLine(
  parsed: Parsed,
  id: JsRuleId,
  hits: Hit[],
  make: (labels: string[]) => Pick<RuleFinding, 'severity' | 'category' | 'description' | 'suggestedFix'>,
): RuleFinding[] {
  const byLine = new Map<number, Hit[]>();
  for (const hit of hits) byLine.set(hit.line, [...(byLine.get(hit.line) ?? []), hit]);
  const out: RuleFinding[] = [];
  for (const [line, group] of byLine) {
    let fix: RuleFinding['fix'] = null;
    if (group.every((h) => h.edit)) {
      let text = parsed.lines[line - 1] ?? '';
      const edits = group.map((h) => h.edit!).sort((a, b) => b.col - a.col);
      for (const e of edits) text = text.slice(0, e.col) + e.insert + text.slice(e.col + e.remove);
      fix = { lineStart: line, lineEnd: line, replacement: text };
    }
    const labels = [...new Set(group.map((h) => h.label))];
    out.push({ ruleId: id, lineStart: line, lineEnd: line, ...make(labels), fix });
  }
  return out;
}

// --- any context ----------------------------------------------------------------------------------

const evalRule: Rule = {
  id: 'js/eval',
  contexts: 'any',
  run({ parsed }) {
    const out: RuleFinding[] = [];
    for (const node of parsed.nodes) {
      if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) continue;
      const callee = unwrap(node.expression);
      let name: string | null = null;
      if (ts.isIdentifier(callee)) name = callee.text;
      else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        ['window', 'globalThis', 'global', 'self'].includes(callee.expression.text)
      ) {
        name = callee.name.text;
      }
      if (name === 'eval' && ts.isCallExpression(node)) {
        out.push(
          finding(parsed, 'js/eval', node, {
            severity: 'critical',
            category: 'security',
            description: 'eval() runs a string as code. If any part of that string comes from input, anyone who controls it can run their own code here.',
            suggestedFix: 'Remove eval(). Parse data with JSON.parse(), look values up in an object, or call the function you meant directly.',
          }),
        );
      } else if (name === 'Function') {
        const how = ts.isNewExpression(node) ? 'new Function()' : 'Function()';
        out.push(
          finding(parsed, 'js/eval', node, {
            severity: 'critical',
            category: 'security',
            description: `${how} compiles a string into code, which is eval() under another name: whoever controls the string controls the code.`,
            suggestedFix: 'Write the function in the source instead of building it from a string.',
          }),
        );
      }
    }
    return out;
  },
};

const isNullish = (e: ts.Expression) => {
  const x = unwrap(e);
  return x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined');
};

const looseEqualityRule: Rule = {
  id: 'js/loose-equality',
  contexts: 'any',
  run({ parsed }) {
    const hits: Hit[] = [];
    for (const node of parsed.nodes) {
      if (!ts.isBinaryExpression(node)) continue;
      const op = node.operatorToken.kind;
      if (op !== ts.SyntaxKind.EqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsToken) continue;
      // `x == null` is the deliberate idiom for "null or undefined"; === null would change what it means.
      if (isNullish(node.left) || isNullish(node.right)) continue;
      const pos = parsed.start(node.operatorToken);
      const at = editAt(parsed, pos + 2, 0, '=');
      const label = op === ts.SyntaxKind.EqualsEqualsToken ? '==' : '!=';
      hits.push({ line: parsed.lineOf(pos), edit: at?.edit ?? null, label });
    }
    return perLine(parsed, 'js/loose-equality', hits, (labels) => {
      const ops = labels.join(' and ');
      const strict = labels.map((l) => (l === '==' ? '===' : '!==')).join(' and ');
      return {
        severity: 'warning',
        category: 'bug',
        description: `${ops} ${labels.length > 1 ? 'convert' : 'converts'} types before comparing, so '1' == 1, '' == 0 and [] == false are all true. That is rarely what the comparison means.`,
        suggestedFix: `Use ${strict}, which ${labels.length > 1 ? 'compare' : 'compares'} without converting.`,
      };
    });
  },
};

const emptyCatchRule: Rule = {
  id: 'js/empty-catch',
  contexts: 'any',
  run({ parsed }) {
    const out: RuleFinding[] = [];
    for (const node of parsed.nodes) {
      if (!ts.isCatchClause(node) || node.block.statements.length > 0) continue;
      // A comment inside the braces says the error is ignored on purpose.
      const inner = parsed.code.slice(parsed.start(node.block) + 1, node.block.getEnd() - 1);
      if (inner.trim() !== '') continue;
      out.push(
        finding(parsed, 'js/empty-catch', node, {
          severity: 'warning',
          category: 'bug',
          description: 'This catch block is empty, so the error is swallowed: the code carries on as if it worked and nothing records why it did not.',
          suggestedFix: 'Handle the error, log it, or rethrow it. If ignoring it is intended, say why in a comment inside the block.',
        }),
      );
    }
    return out;
  },
};

// --- backend --------------------------------------------------------------------------------------

// Is this argument SQL built at run time: 'a' + x, `a ${x}`, or a variable assigned one of those?
function builtSql(arg: ts.Expression, decls: Declarations, needSqlWords: boolean): 'concatenation' | 'template literal' | null {
  const candidates: ts.Expression[] = [unwrap(arg)];
  const x = unwrap(arg);
  if (ts.isIdentifier(x)) candidates.push(...decls.initializersOf(x.text).map(unwrap));
  for (const c of candidates) {
    let kind: 'concatenation' | 'template literal' | null = null;
    if (ts.isTemplateExpression(c)) kind = 'template literal';
    else {
      const parts = plusOperands(c);
      if (parts.length > 1 && !isStaticString(c)) kind = parts.some((p) => ts.isTemplateExpression(p)) ? 'template literal' : 'concatenation';
    }
    if (kind && (!needSqlWords || looksLikeSql(c))) return kind;
  }
  // `sql += x` anywhere also builds the string piece by piece.
  if (ts.isIdentifier(x)) {
    for (const init of decls.initializersOf(x.text)) {
      const p = init.parent;
      const appends = p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken;
      if (appends && !isStaticString(init) && (!needSqlWords || decls.initializersOf(x.text).some(looksLikeSql))) {
        return 'concatenation';
      }
    }
  }
  return null;
}

const sqlStringConcatRule: Rule = {
  id: 'js/sql-string-concat',
  contexts: BACKEND,
  run({ parsed, decls }) {
    const out: RuleFinding[] = [];
    for (const node of parsed.nodes) {
      if (!ts.isCallExpression(node) || node.arguments.length === 0) continue;
      const callee = unwrap(node.expression);
      if (!ts.isPropertyAccessExpression(callee) || !SQL_METHODS.has(callee.name.text)) continue;
      const method = callee.name.text;
      // .execute() is a common name outside databases, so it needs SQL words in the string.
      const how = builtSql(node.arguments[0], decls, method === 'execute');
      if (!how) continue;
      out.push(
        finding(parsed, 'js/sql-string-concat', node, {
          severity: 'critical',
          category: 'security',
          description: `The SQL passed to .${method}() is built by ${how}, so a quote in any of the inserted values changes the query itself (SQL injection).`,
          suggestedFix:
            "Keep the SQL fixed and pass the values separately: db.query('SELECT * FROM users WHERE id = $1', [id]) in pg, ? placeholders in mysql, or a tagged template your library escapes.",
        }),
      );
    }
    return out;
  },
};

const childProcessExecRule: Rule = {
  id: 'js/child-process-exec',
  contexts: BACKEND,
  run({ parsed, childProcess }) {
    const out: RuleFinding[] = [];
    for (const node of parsed.nodes) {
      if (!ts.isCallExpression(node) || node.arguments.length === 0) continue;
      const fn = calleeFromModule(node.expression, childProcess, CHILD_PROCESS_MODULES, EXEC_FUNCTIONS, new Set(['child_process']));
      if (!fn || isStaticString(node.arguments[0])) continue;
      out.push(
        finding(parsed, 'js/child-process-exec', node, {
          severity: 'critical',
          category: 'security',
          description: `${fn}() runs its command through a shell, and this command is built from a variable: a ; or $( ) in that value runs whatever comes after it (command injection).`,
          suggestedFix: "Use execFile() or spawn() with the program and its arguments as an array (no shell), e.g. execFile('convert', [input, output]), and validate the input.",
        }),
      );
    }
    return out;
  },
};

const fsPathFromRequestRule: Rule = {
  id: 'js/fs-path-from-request',
  contexts: BACKEND,
  run({ parsed, fs, decls }) {
    const out: RuleFinding[] = [];
    for (const node of parsed.nodes) {
      if (!ts.isCallExpression(node) || node.arguments.length === 0) continue;
      const fn = calleeFromModule(node.expression, fs, FS_MODULES, FS_FUNCTIONS, new Set(['fs', 'fsp']));
      if (!fn) continue;
      const paths = node.arguments.slice(0, FS_TWO_PATHS.has(fn) ? 2 : 1);
      if (!paths.some((p) => derivesFrom(p, REQUEST_ROOTS, decls))) continue;
      out.push(
        finding(parsed, 'js/fs-path-from-request', node, {
          severity: 'warning',
          category: 'security',
          description: `The path given to ${fn}() comes from the request, so a value like ../../etc/passwd reaches files outside the folder you meant (path traversal).`,
          suggestedFix:
            'Resolve the path against a fixed base folder and refuse it unless it is still inside: const p = path.resolve(base, name); if (!p.startsWith(base + path.sep)) reject. Or map the input to a known list of files.',
        }),
      );
    }
    return out;
  },
};

// --- frontend -------------------------------------------------------------------------------------

const attrName = (attr: ts.JsxAttribute, sf: ts.SourceFile) => attr.name.getText(sf);

const dangerouslySetInnerHtmlRule: Rule = {
  id: 'js/dangerously-set-inner-html',
  contexts: FRONTEND,
  run({ parsed }) {
    const out: RuleFinding[] = [];
    for (const node of parsed.nodes) {
      const isProp =
        (ts.isJsxAttribute(node) && attrName(node, parsed.sf) === 'dangerouslySetInnerHTML') ||
        ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'dangerouslySetInnerHTML');
      if (!isProp) continue;
      out.push(
        finding(parsed, 'js/dangerously-set-inner-html', node, {
          severity: 'warning',
          category: 'security',
          description: 'dangerouslySetInnerHTML puts this HTML on the page without escaping it. If any of it comes from a user or an API, it can carry a script (XSS).',
          suggestedFix: 'Render the content as text or JSX. If it really must be HTML, sanitize it first, for example with DOMPurify.sanitize().',
        }),
      );
    }
    return out;
  },
};

const innerHtmlAssignmentRule: Rule = {
  id: 'js/inner-html-assignment',
  contexts: FRONTEND,
  run({ parsed }) {
    const out: RuleFinding[] = [];
    for (const node of parsed.nodes) {
      if (!ts.isBinaryExpression(node)) continue;
      const op = node.operatorToken.kind;
      if (op !== ts.SyntaxKind.EqualsToken && op !== ts.SyntaxKind.PlusEqualsToken) continue;
      const left = unwrap(node.left);
      let prop: string | null = null;
      if (ts.isPropertyAccessExpression(left)) prop = left.name.text;
      else if (ts.isElementAccessExpression(left) && isStringLiteralLike(left.argumentExpression)) prop = left.argumentExpression.text;
      if (prop !== 'innerHTML' && prop !== 'outerHTML') continue;
      // A fixed string (el.innerHTML = '') can't carry anyone else's markup.
      if (isStaticString(node.right)) continue;
      out.push(
        finding(parsed, 'js/inner-html-assignment', node, {
          severity: 'warning',
          category: 'security',
          description: `Setting ${prop} parses the string as HTML, so any user-controlled part of it can inject markup and script (XSS).`,
          suggestedFix: 'Use textContent for text, or build the elements with document.createElement(). If HTML is really needed, sanitize it first (DOMPurify).',
        }),
      );
    }
    return out;
  },
};

// The string value of a JSX attribute: target="_blank" or target={'_blank'}; null if not a literal.
function jsxStringValue(attr: ts.JsxAttribute): ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | null {
  const init = attr.initializer;
  if (!init) return null;
  if (ts.isStringLiteral(init)) return init;
  if (ts.isJsxExpression(init) && init.expression) {
    const e = unwrap(init.expression);
    if (isStringLiteralLike(e)) return e;
  }
  return null;
}

const targetBlankRule: Rule = {
  id: 'js/target-blank-noopener',
  contexts: FRONTEND,
  run({ parsed }) {
    const hits: Hit[] = [];
    for (const node of parsed.nodes) {
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) continue;
      const props = node.attributes.properties;
      const attrs = props.filter(ts.isJsxAttribute);
      const target = attrs.find((a) => attrName(a, parsed.sf) === 'target');
      const targetValue = target && jsxStringValue(target);
      if (!target || !targetValue || targetValue.text.toLowerCase() !== '_blank') continue;
      const rel = attrs.find((a) => attrName(a, parsed.sf) === 'rel');
      if (!rel) {
        // {...props} may carry a rel we can't see.
        if (props.some(ts.isJsxSpreadAttribute)) continue;
        const at = editAt(parsed, target.getEnd(), 0, ' rel="noopener"');
        hits.push({ line: parsed.lineOf(target.getEnd()), edit: at?.edit ?? null, label: 'target' });
        continue;
      }
      const relValue = jsxStringValue(rel);
      if (!relValue) continue; // rel={something}: can't tell
      const words = relValue.text.toLowerCase().split(/\s+/);
      if (words.includes('noopener') || words.includes('noreferrer')) continue;
      // Keep what rel already says and add noopener to it.
      const start = parsed.start(relValue);
      const quote = parsed.code[start];
      const value = relValue.text.trim() === '' ? 'noopener' : `${relValue.text.trim()} noopener`;
      const at = editAt(parsed, start, relValue.getEnd() - start, `${quote}${value}${quote}`);
      hits.push({ line: parsed.lineOf(start), edit: at?.edit ?? null, label: 'rel' });
    }
    return perLine(parsed, 'js/target-blank-noopener', hits, () => ({
      severity: 'info',
      category: 'security',
      description:
        'target="_blank" without rel="noopener" gives the opened page a handle on this one (window.opener), which it can use to send this tab somewhere else. Current browsers imply noopener; older ones do not.',
      suggestedFix: 'Add rel="noopener" (or rel="noopener noreferrer" to also hide the referrer).',
    }));
  },
};

// --- test -----------------------------------------------------------------------------------------

const focusedTestRule: Rule = {
  id: 'js/focused-test',
  contexts: TEST,
  run({ parsed }) {
    const hits: Hit[] = [];
    for (const node of parsed.nodes) {
      if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'only') continue;
      const obj = unwrap(node.expression);
      if (!ts.isIdentifier(obj) || !TEST_BLOCKS.has(obj.text)) continue;
      // Remove from the end of `describe` to the end of `only`: the dot and the word.
      const from = node.expression.getEnd();
      const at = editAt(parsed, from, node.name.getEnd() - from, '');
      hits.push({ line: parsed.lineOf(parsed.start(node.name)), edit: at?.edit ?? null, label: `${obj.text}.only` });
    }
    return perLine(parsed, 'js/focused-test', hits, (labels) => ({
      severity: 'warning',
      category: 'bug',
      description: `${labels.join(' and ')} ${labels.length > 1 ? 'run only these blocks' : 'runs only this block'}, so every other test in the file is skipped without failing, in CI as well.`,
      suggestedFix: 'Remove .only before committing.',
    }));
  },
};

const RULES: Rule[] = [
  evalRule,
  looseEqualityRule,
  emptyCatchRule,
  sqlStringConcatRule,
  childProcessExecRule,
  fsPathFromRequestRule,
  dangerouslySetInnerHtmlRule,
  innerHtmlAssignmentRule,
  targetBlankRule,
  focusedTestRule,
];

export function rulesFor(context: CodeContext): JsRuleId[] {
  return RULES.filter((r) => context === 'unknown' || r.contexts === 'any' || r.contexts.includes(context)).map((r) => r.id);
}

// The rules of every context given (a rule runs if any of them lists it).
export function runRules(parsed: Parsed, contexts: CodeContext | CodeContext[]): RuleFinding[] {
  const rc: RuleContext = {
    parsed,
    decls: declarations(parsed),
    childProcess: moduleBindings(parsed, CHILD_PROCESS_MODULES),
    fs: moduleBindings(parsed, FS_MODULES),
  };
  const ids = new Set((Array.isArray(contexts) ? contexts : [contexts]).flatMap(rulesFor));
  const findings = RULES.filter((r) => ids.has(r.id)).flatMap((r) => r.run(rc));
  return findings.sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd || a.ruleId.localeCompare(b.ruleId));
}

export function syntaxErrorFinding(parsed: Parsed): RuleFinding {
  const error = parsed.error!;
  return {
    ruleId: 'js/syntax-error',
    lineStart: error.line,
    lineEnd: error.line,
    severity: 'critical',
    category: 'bug',
    description: `This code does not parse: ${/[.!?]$/.test(error.message) ? error.message : `${error.message}.`} The other rules did not run.`,
    suggestedFix: 'Fix the syntax error on this line; the error can also come from an unclosed bracket or string above it.',
    fix: null,
  };
}
