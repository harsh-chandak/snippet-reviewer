import { Language as GrammarLanguage, Node, Parser, Tree } from 'web-tree-sitter';

// One parser for the whole process, built on first use. Parser.init() loads the tree-sitter
// runtime wasm and Language.load() the Python grammar; both are slow, so they run once.
let ready: Promise<Parser> | null = null;

function getParser(): Promise<Parser> {
  if (!ready) {
    ready = (async () => {
      await Parser.init();
      const grammar = await GrammarLanguage.load(require.resolve('tree-sitter-python/tree-sitter-python.wasm'));
      const parser = new Parser();
      parser.setLanguage(grammar);
      return parser;
    })();
    // A failed load is not cached, so the next call tries again.
    ready.catch(() => {
      ready = null;
    });
  }
  return ready;
}

// Parses `code` and hands the tree to `fn`. The tree lives in wasm memory, so it is freed here
// once `fn` returns; nothing from the tree may be kept past `fn`.
export async function withTree<T>(code: string, fn: (tree: Tree) => T): Promise<T> {
  const parser = await getParser();
  const tree = parser.parse(code);
  if (!tree) throw new Error('tree-sitter returned no tree for the Python snippet');
  try {
    return fn(tree);
  } finally {
    tree.delete();
  }
}

// tree-sitter-python also accepts Python 2 statements, which Python 3 refuses to run.
const PYTHON2_STATEMENTS: Record<string, string> = {
  print_statement: 'Python 2 print statement; Python 3 needs print(...)',
  exec_statement: 'Python 2 exec statement; Python 3 needs exec(...)',
};

// The first ERROR or MISSING node in document order, or null when the tree has none.
function firstErrorNode(root: Node): Node | null {
  if (!root.hasError) return null;
  const visit = (node: Node): Node | null => {
    if (node.isError || node.isMissing) return node;
    for (const child of node.children) {
      if (child && (child.hasError || child.isMissing)) {
        const found = visit(child);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(root) ?? root;
}

// The first reason the code won't run as Python 3, in plain words with its 1-based line,
// or null when it parses. `lineOf` maps a node to its line (see SourceLines).
export function findSyntaxError(root: Node, lineOf: (node: Node) => number): { line: number; message: string } | null {
  const candidates: Node[] = [];
  const error = firstErrorNode(root);
  if (error) candidates.push(error);
  const py2 = root.descendantsOfType(Object.keys(PYTHON2_STATEMENTS))[0];
  if (py2) candidates.push(py2);
  if (!candidates.length) return null;
  const node = candidates.reduce((a, b) => (b.startIndex < a.startIndex ? b : a));
  const line = lineOf(node);
  if (PYTHON2_STATEMENTS[node.type]) return { line, message: `Syntax error on line ${line}: ${PYTHON2_STATEMENTS[node.type]}` };
  if (node.isMissing) return { line, message: `Syntax error on line ${line}: missing '${node.type}'` };
  const text = node.text.split('\n')[0].trim();
  if (!text) return { line, message: `Syntax error on line ${line}` };
  const shown = text.length > 40 ? `${text.slice(0, 40)}...` : text;
  return { line, message: `Syntax error on line ${line}: unexpected '${shown}'` };
}
