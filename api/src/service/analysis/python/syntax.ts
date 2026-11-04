import { Node } from 'web-tree-sitter';
import { codeLines } from '../../../utils/codeLines';

// Line arithmetic over codeLines(), so a finding's line N is the line N the rest of the app shows.
// tree-sitter rows are 0-based and its indices are offsets into the JS string, like ours.
export class SourceLines {
  readonly lines: string[];
  private readonly starts: number[];

  constructor(code: string) {
    this.lines = codeLines(code);
    this.starts = [];
    let offset = 0;
    for (const line of this.lines) {
      this.starts.push(offset);
      offset += line.length + 1;
    }
  }

  get count(): number {
    return this.lines.length;
  }

  clamp(line: number): number {
    return Math.min(Math.max(line, 1), this.count);
  }

  startLine(node: Node): number {
    return this.clamp(node.startPosition.row + 1);
  }

  // A node that ends at column 0 of a later row ends on the row before it.
  endLine(node: Node): number {
    const { row, column } = node.endPosition;
    const end = column === 0 && row > node.startPosition.row ? row : row + 1;
    return Math.max(this.clamp(end), this.startLine(node));
  }

  text(line: number): string {
    return this.lines[line - 1] ?? '';
  }

  // Column of a string offset within its 1-based line.
  column(line: number, index: number): number {
    return index - (this.starts[line - 1] ?? 0);
  }
}

export function descendants(root: Node, types: string | string[]): Node[] {
  return root.descendantsOfType(types).filter((n): n is Node => n !== null);
}

export function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((n): n is Node => n !== null);
}

export function children(node: Node): Node[] {
  return node.children.filter((n): n is Node => n !== null);
}

// Local name -> what it refers to: `import numpy as np` gives np -> numpy,
// `from subprocess import run` gives run -> subprocess.run, `import os.path` gives os -> os.
export type ImportMap = Map<string, string>;

export interface ImportInfo {
  names: ImportMap;
  modules: Set<string>; // top-level packages imported anywhere: 'flask', 'django', 'os'
}

export function collectImports(root: Node): ImportInfo {
  const names: ImportMap = new Map();
  const modules = new Set<string>();
  for (const stmt of descendants(root, ['import_statement', 'import_from_statement'])) {
    if (stmt.type === 'import_statement') {
      for (const item of namedChildren(stmt)) {
        if (item.type === 'dotted_name') {
          const full = item.text;
          const top = full.split('.')[0];
          modules.add(top);
          names.set(top, top);
        } else if (item.type === 'aliased_import') {
          const full = item.childForFieldName('name')?.text;
          const alias = item.childForFieldName('alias')?.text;
          if (full && alias) {
            modules.add(full.split('.')[0]);
            names.set(alias, full);
          }
        }
      }
    } else {
      const moduleNode = stmt.childForFieldName('module_name');
      // Relative imports (`from . import x`) name no package.
      if (!moduleNode || moduleNode.type !== 'dotted_name') continue;
      const mod = moduleNode.text;
      modules.add(mod.split('.')[0]);
      for (const item of namedChildren(stmt)) {
        if (item.id === moduleNode.id) continue;
        if (item.type === 'dotted_name') {
          names.set(item.text, `${mod}.${item.text}`);
        } else if (item.type === 'aliased_import') {
          const name = item.childForFieldName('name')?.text;
          const alias = item.childForFieldName('alias')?.text;
          if (name && alias) names.set(alias, `${mod}.${name}`);
        }
      }
    }
  }
  return { names, modules };
}

// The dotted name an expression refers to, with imports resolved: `np.load` -> 'numpy.load',
// `run` (from subprocess import run) -> 'subprocess.run', `eval` -> 'eval'. Null for anything
// that isn't a plain name or attribute chain (a call result, a subscript, ...).
// Walks the chain in a loop, not by recursion: a valid `a.b.b.b...` thousands of attributes long
// overflowed the stack (STA-10).
export function qualifiedName(node: Node, imports: ImportMap): string | null {
  const attributes: string[] = [];
  let current = node;
  while (current.type === 'attribute') {
    const object = current.childForFieldName('object');
    const attribute = current.childForFieldName('attribute');
    if (!object || !attribute) return null;
    attributes.push(attribute.text);
    current = object;
  }
  if (current.type !== 'identifier') return null;
  return [imports.get(current.text) ?? current.text, ...attributes.reverse()].join('.');
}

// A call's keyword argument by name, e.g. shell in `run(cmd, shell=True)`.
export function keywordArgument(call: Node, name: string): Node | null {
  const args = call.childForFieldName('arguments');
  if (!args || args.type !== 'argument_list') return null;
  for (const arg of namedChildren(args)) {
    if (arg.type === 'keyword_argument' && arg.childForFieldName('name')?.text === name) {
      return arg.childForFieldName('value');
    }
  }
  return null;
}

// A call's first positional argument.
export function firstPositionalArgument(call: Node): Node | null {
  const args = call.childForFieldName('arguments');
  if (!args || args.type !== 'argument_list') return null;
  for (const arg of namedChildren(args)) {
    if (arg.type === 'comment') continue;
    if (arg.type === 'keyword_argument' || arg.type === 'list_splat' || arg.type === 'dictionary_splat') return null;
    return arg;
  }
  return null;
}

// The function or module body that a node sits in.
export function enclosingScope(node: Node): Node {
  let current = node.parent;
  while (current) {
    if (current.type === 'function_definition' || current.type === 'module') return current;
    current = current.parent;
  }
  return node.tree.rootNode;
}
