import { Node } from 'web-tree-sitter';
import { DetectedContext } from '../types';
import { ImportInfo, namedChildren } from './syntax';

// Which top-level imports point at which context. Checked in this order, first match wins:
// a test of a Flask app imports both flask and pytest and is a test; a Flask app with an
// `if __name__ == "__main__": app.run()` block is a backend, not a script.
const TEST_IMPORTS = ['pytest', 'unittest'];
const BACKEND_IMPORTS = ['flask', 'django', 'fastapi', 'sqlalchemy', 'sqlite3', 'psycopg', 'psycopg2'];
const SCRIPT_IMPORTS = ['pandas', 'numpy', 'argparse'];

function importSignals(imports: ImportInfo, modules: string[]): string[] {
  return modules.filter((m) => imports.modules.has(m)).map((m) => `imports ${m}`);
}

// `if __name__ == "__main__":` (either quote style, either operand order) at module level.
function hasMainGuard(root: Node): boolean {
  for (const stmt of namedChildren(root)) {
    if (stmt.type !== 'if_statement') continue;
    const condition = stmt.childForFieldName('condition');
    if (condition?.type !== 'comparison_operator') continue;
    const operands = namedChildren(condition);
    const ops = condition.children.filter((c) => c && !c.isNamed).map((c) => c!.type);
    if (operands.length !== 2 || ops.length !== 1 || ops[0] !== '==') continue;
    const texts = operands.map((o) => o.text.replace(/'/g, '"'));
    if (texts.includes('__name__') && texts.includes('"__main__"')) return true;
  }
  return false;
}

export function detectContext(root: Node, imports: ImportInfo): DetectedContext {
  const test = importSignals(imports, TEST_IMPORTS);
  if (test.length) return { context: 'test', signals: test };

  const backend = importSignals(imports, BACKEND_IMPORTS);
  if (backend.length) return { context: 'backend', signals: backend };

  const script = importSignals(imports, SCRIPT_IMPORTS);
  if (hasMainGuard(root)) script.push('has an if __name__ == "__main__" block');
  if (script.length) return { context: 'script', signals: script };

  return { context: 'unknown', signals: [] };
}

