import { Node } from 'web-tree-sitter';
import { CodeContext } from '../../../model/constants';
import { RuleFinding } from '../types';
import {
  children,
  descendants,
  enclosingScope,
  firstPositionalArgument,
  ImportInfo,
  keywordArgument,
  namedChildren,
  qualifiedName,
  SourceLines,
} from './syntax';

// The Python rules. Ids follow '<lang>/<kebab-name>' and are recorded as the 'python rule set'
// decision; the fix checker re-runs a finding's rule by its id, so an id never changes meaning.

export interface RuleInput {
  root: Node;
  src: SourceLines;
  imports: ImportInfo;
}

interface PythonRule {
  id: string;
  // The contexts the rule runs in. Every current rule is about the code itself (injection,
  // swallowed errors, shared state), which is as wrong in a script or a test as in a server.
  contexts: readonly CodeContext[] | 'all';
  run(input: RuleInput): RuleFinding[];
}

const STRING_TYPES = new Set(['string', 'concatenated_string']);
const LITERAL_TYPES = new Set(['integer', 'float', 'true', 'false', 'none']);

function finding(
  ruleId: string,
  src: SourceLines,
  node: Node,
  rest: Omit<RuleFinding, 'ruleId' | 'lineStart' | 'lineEnd' | 'fix'> & { fix?: RuleFinding['fix'] },
): RuleFinding {
  return { ruleId, lineStart: src.startLine(node), lineEnd: src.endLine(node), fix: null, ...rest };
}

function calls(root: Node): Node[] {
  return descendants(root, 'call');
}

function callee(call: Node, input: RuleInput): string | null {
  const fn = call.childForFieldName('function');
  return fn ? qualifiedName(fn, input.imports.names) : null;
}

// --- strings and SQL building ---------------------------------------------------------------

function isFString(node: Node): boolean {
  if (node.type === 'string') return children(node).some((c) => c.type === 'interpolation');
  if (node.type === 'concatenated_string') return namedChildren(node).some(isFString);
  return false;
}

// A string literal with nothing interpolated into it.
function isPlainString(node: Node): boolean {
  return STRING_TYPES.has(node.type) && !isFString(node);
}

function isConstant(node: Node): boolean {
  if (node.type === 'parenthesized_expression') return namedChildren(node).every(isConstant);
  if (node.type === 'tuple') return namedChildren(node).every(isConstant);
  return isPlainString(node) || LITERAL_TYPES.has(node.type);
}

function unwrap(node: Node): Node {
  let current = node;
  while (current.type === 'parenthesized_expression' && current.namedChildCount === 1 && current.namedChild(0)) {
    current = current.namedChild(0)!;
  }
  return current;
}

function operatorOf(node: Node): string | null {
  return node.childForFieldName('operator')?.type ?? null;
}

// The operands of a chain of `+`: a + b + c -> [a, b, c].
function plusOperands(node: Node): Node[] {
  const n = unwrap(node);
  if (n.type === 'binary_operator' && operatorOf(n) === '+') {
    const left = n.childForFieldName('left');
    const right = n.childForFieldName('right');
    return [...(left ? plusOperands(left) : []), ...(right ? plusOperands(right) : [])];
  }
  return [n];
}

// How a string was built from values at run time, in plain words, or null if it wasn't.
function stringBuilding(raw: Node): string | null {
  const node = unwrap(raw);
  if (isFString(node)) return 'an f-string';
  if (node.type === 'binary_operator') {
    const op = operatorOf(node);
    if (op === '+') {
      const parts = plusOperands(node);
      const hasString = parts.some((p) => STRING_TYPES.has(p.type));
      const hasValue = parts.some((p) => !isConstant(p));
      if (hasString && hasValue) return 'string concatenation (+)';
    }
    if (op === '%') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      if (left && STRING_TYPES.has(unwrap(left).type) && right && !isConstant(right)) return '% formatting';
    }
  }
  if (node.type === 'call') {
    const fn = node.childForFieldName('function');
    if (fn?.type === 'attribute' && fn.childForFieldName('attribute')?.text === 'format') {
      const object = fn.childForFieldName('object');
      const args = node.childForFieldName('arguments');
      const hasValue = args ? namedChildren(args).some((a) => a.type !== 'comment' && !isConstant(a)) : false;
      if (object && STRING_TYPES.has(unwrap(object).type) && hasValue) return '.format()';
    }
  }
  return null;
}

// The last assignment to `name` in the same function (or module) before `before`, when it built
// a string from values; `q += f"... {x}"` counts too.
function builtVariable(name: string, before: Node): { how: string; node: Node } | null {
  const scope = enclosingScope(before);
  let found: { how: string; node: Node } | null = null;
  for (const assign of descendants(scope, ['assignment', 'augmented_assignment'])) {
    if (assign.startIndex >= before.startIndex) continue;
    if (enclosingScope(assign).id !== scope.id) continue;
    const left = assign.childForFieldName('left');
    const right = assign.childForFieldName('right');
    if (left?.type !== 'identifier' || left.text !== name || !right) continue;
    const how = stringBuilding(right);
    if (assign.type === 'assignment') {
      found = how ? { how, node: assign } : null;
    } else if (operatorOf(assign) === '+=' && (how || !isConstant(right))) {
      found = { how: how ?? 'string concatenation (+=)', node: assign };
    }
  }
  return found;
}

const EXECUTE_METHODS = new Set(['execute', 'executemany', 'executescript']);

const sqlStringConcat: PythonRule = {
  id: 'py/sql-string-concat',
  contexts: 'all',
  run({ root, src }) {
    const out: RuleFinding[] = [];
    for (const call of calls(root)) {
      const fn = call.childForFieldName('function');
      const method = fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : null;
      if (!method || !EXECUTE_METHODS.has(method)) continue;
      const query = firstPositionalArgument(call);
      if (!query) continue;
      let how = stringBuilding(query);
      let where = '';
      if (!how && unwrap(query).type === 'identifier') {
        const built = builtVariable(unwrap(query).text, call);
        if (built) {
          how = built.how;
          where = ` (\`${unwrap(query).text}\` is built on line ${src.startLine(built.node)})`;
        }
      }
      if (!how) continue;
      out.push(
        finding(this.id, src, call, {
          severity: 'critical',
          category: 'security',
          description: `SQL passed to .${method}() is built with ${how}${where}, so a value containing a quote can change the query (SQL injection).`,
          suggestedFix:
            'Keep the SQL a constant string with placeholders and pass the values separately, e.g. cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,)) (the placeholder is ? for sqlite3).',
        }),
      );
    }
    return out;
  },
};

// --- calls to dangerous functions -----------------------------------------------------------

const evalExec: PythonRule = {
  id: 'py/eval-exec',
  contexts: 'all',
  run(input) {
    const out: RuleFinding[] = [];
    for (const call of calls(input.root)) {
      const name = callee(call, input);
      const fn = name === 'eval' || name === 'builtins.eval' ? 'eval' : name === 'exec' || name === 'builtins.exec' ? 'exec' : null;
      if (!fn) continue;
      out.push(
        finding(this.id, input.src, call, {
          severity: 'critical',
          category: 'security',
          description: `${fn}() runs its argument as Python code; if any part of it comes from input, that input can run anything this process can.`,
          suggestedFix:
            fn === 'eval'
              ? 'Parse the value instead: ast.literal_eval() for Python literals, json.loads() for JSON, int()/float() for numbers.'
              : 'Replace exec() with ordinary code, e.g. a dict that maps names to functions.',
        }),
      );
    }
    return out;
  },
};

const SUBPROCESS_FUNCTIONS = new Set(['run', 'call', 'check_call', 'check_output', 'Popen']);

const subprocessShellTrue: PythonRule = {
  id: 'py/subprocess-shell-true',
  contexts: 'all',
  run(input) {
    const out: RuleFinding[] = [];
    for (const call of calls(input.root)) {
      const name = callee(call, input);
      if (!name?.startsWith('subprocess.') || !SUBPROCESS_FUNCTIONS.has(name.slice('subprocess.'.length))) continue;
      if (keywordArgument(call, 'shell')?.type !== 'true') continue;
      out.push(
        finding(this.id, input.src, call, {
          severity: 'critical',
          category: 'security',
          description: `${name}() with shell=True runs the command through the shell, so a value in it containing ; | $() or backticks runs extra commands.`,
          suggestedFix:
            'Pass the command as a list without shell=True, e.g. subprocess.run(["ls", "-l", path]); use shlex.quote() only if a shell is truly needed.',
        }),
      );
    }
    return out;
  },
};

const PICKLE_FUNCTIONS = new Set(['pickle.load', 'pickle.loads', 'cPickle.load', 'cPickle.loads', '_pickle.load', '_pickle.loads']);

const pickleLoad: PythonRule = {
  id: 'py/pickle-load',
  contexts: 'all',
  run(input) {
    const out: RuleFinding[] = [];
    for (const call of calls(input.root)) {
      const name = callee(call, input);
      if (!name || !PICKLE_FUNCTIONS.has(name)) continue;
      out.push(
        finding(this.id, input.src, call, {
          severity: 'warning',
          category: 'security',
          description: `${name}() can run arbitrary code while unpickling; it is only safe on data this program wrote itself and nobody else could change.`,
          suggestedFix: 'Use json (or another data-only format) for anything that crosses a trust boundary, or sign the pickle and check the signature first.',
        }),
      );
    }
    return out;
  },
};

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request']);

const requestsVerifyFalse: PythonRule = {
  id: 'py/requests-verify-false',
  contexts: 'all',
  run(input) {
    const out: RuleFinding[] = [];
    const usesRequests = input.imports.modules.has('requests');
    for (const call of calls(input.root)) {
      if (keywordArgument(call, 'verify')?.type !== 'false') continue;
      const name = callee(call, input);
      const fn = call.childForFieldName('function');
      const method = fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : null;
      // requests.get(...), or session.get(...) in a file that imports requests.
      const isRequests = name?.startsWith('requests.') || (usesRequests && method && HTTP_METHODS.has(method));
      if (!isRequests) continue;
      out.push(
        finding(this.id, input.src, call, {
          severity: 'warning',
          category: 'security',
          description: 'verify=False turns off TLS certificate checking, so anyone on the network path can read or change this request and its response.',
          suggestedFix: 'Remove verify=False; for a private CA, pass its bundle instead: verify="/path/to/ca.pem".',
        }),
      );
    }
    return out;
  },
};

// --- error handling and defaults ------------------------------------------------------------

const bareExcept: PythonRule = {
  id: 'py/bare-except',
  contexts: 'all',
  run({ root, src }) {
    const out: RuleFinding[] = [];
    for (const clause of descendants(root, 'except_clause')) {
      const parts = children(clause);
      const keyword = parts[0];
      if (!keyword || keyword.type !== 'except') continue;
      // Bare: nothing between `except` and `:` (comments aside).
      const colonAt = parts.findIndex((p) => p.type === ':');
      if (colonAt < 0) continue;
      if (parts.slice(1, colonAt).some((p) => p.type !== 'comment')) continue;
      const colon = parts[colonAt];
      const line = src.startLine(keyword);
      let fix: RuleFinding['fix'] = null;
      if (src.startLine(colon) === line) {
        const text = src.text(line);
        const from = src.column(line, keyword.startIndex);
        const to = src.column(line, colon.startIndex);
        fix = { lineStart: line, lineEnd: line, replacement: `${text.slice(0, from)}except Exception${text.slice(to)}` };
      }
      out.push({
        ruleId: this.id,
        lineStart: line,
        lineEnd: line,
        severity: 'warning',
        category: 'bug',
        description: 'A bare except: catches everything, including KeyboardInterrupt and SystemExit, and hides the real error.',
        suggestedFix: 'Catch Exception, or better the specific exceptions this code expects (ValueError, KeyError, ...).',
        fix,
      });
    }
    return out;
  },
};

const MUTABLE_LITERALS = new Set(['list', 'dictionary', 'set', 'list_comprehension', 'dictionary_comprehension', 'set_comprehension']);
const MUTABLE_CONSTRUCTORS = new Set([
  'list',
  'dict',
  'set',
  'bytearray',
  'collections.defaultdict',
  'collections.OrderedDict',
  'collections.deque',
  'collections.Counter',
]);

// What to create inside the function instead: [] for a list default, {} for a dict, ...
function emptyOf(value: Node): string {
  if (value.type === 'call') return value.text;
  if (value.type === 'dictionary' || value.type === 'dictionary_comprehension') return '{}';
  if (value.type === 'list' || value.type === 'list_comprehension') return '[]';
  return 'set()';
}

const mutableDefaultArg: PythonRule = {
  id: 'py/mutable-default-arg',
  contexts: 'all',
  run(input) {
    const out: RuleFinding[] = [];
    for (const param of descendants(input.root, ['default_parameter', 'typed_default_parameter'])) {
      const value = param.childForFieldName('value');
      const name = param.childForFieldName('name')?.text ?? 'argument';
      if (!value) continue;
      const v = unwrap(value);
      const isMutable =
        MUTABLE_LITERALS.has(v.type) ||
        (v.type === 'call' && MUTABLE_CONSTRUCTORS.has(callee(v, input) ?? ''));
      if (!isMutable) continue;
      out.push(
        finding(this.id, input.src, param, {
          severity: 'warning',
          category: 'bug',
          description: `The default for '${name}' is created once, when the function is defined, so every call that uses the default shares (and keeps) the same object.`,
          suggestedFix: `Default to None and create it inside the function: '${name}=None', then 'if ${name} is None: ${name} = ${emptyOf(v)}'.`,
        }),
      );
    }
    return out;
  },
};

// --- style ----------------------------------------------------------------------------------

const noneComparison: PythonRule = {
  id: 'py/none-comparison',
  contexts: 'all',
  run({ root, src, imports }) {
    const out: RuleFinding[] = [];
    // With numpy/pandas, `col == None` inside df[...] is elementwise; `is` would change its meaning.
    const arrayLibrary = imports.modules.has('numpy') || imports.modules.has('pandas');
    for (const cmp of descendants(root, 'comparison_operator')) {
      const parts = children(cmp);
      for (let i = 0; i < parts.length; i++) {
        const op = parts[i];
        if (op.type !== '==' && op.type !== '!=') continue;
        const prev = parts[i - 1];
        const next = parts[i + 1];
        if (prev?.type !== 'none' && next?.type !== 'none') continue;
        const replacement = op.type === '==' ? 'is' : 'is not';
        let fix: RuleFinding['fix'] = null;
        const inSubscript = hasAncestor(cmp, 'subscript');
        const simple = parts.length === 3;
        if (simple && !(arrayLibrary && inSubscript)) {
          const line = src.startLine(op);
          const text = src.text(line);
          const from = src.column(line, op.startIndex);
          const to = src.column(line, op.endIndex);
          fix = { lineStart: line, lineEnd: line, replacement: `${text.slice(0, from)}${replacement}${text.slice(to)}` };
        }
        out.push(
          finding(this.id, src, cmp, {
            severity: 'info',
            category: 'style',
            description: `Comparing to None with ${op.type} calls __eq__, which a class can override; '${replacement} None' checks identity, which is what is meant.`,
            suggestedFix:
              arrayLibrary && inSubscript
                ? 'For a pandas or numpy column, use .isna() / .notna() instead.'
                : `Use '${replacement} None'.`,
            fix,
          }),
        );
      }
    }
    return out;
  },
};

function hasAncestor(node: Node, type: string): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.type === type) return true;
  return false;
}

export const PYTHON_RULES: readonly PythonRule[] = [
  evalExec,
  subprocessShellTrue,
  sqlStringConcat,
  pickleLoad,
  requestsVerifyFalse,
  bareExcept,
  mutableDefaultArg,
  noneComparison,
];

export const SYNTAX_ERROR_RULE_ID = 'py/syntax-error';

export function runRules(input: RuleInput, context: CodeContext): RuleFinding[] {
  const findings = PYTHON_RULES.filter((r) => r.contexts === 'all' || r.contexts.includes(context)).flatMap((r) =>
    r.run(input),
  );
  return findings.sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd || a.ruleId.localeCompare(b.ruleId));
}
