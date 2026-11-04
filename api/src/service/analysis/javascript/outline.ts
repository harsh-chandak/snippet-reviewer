import ts from 'typescript';
import { OutlineItem } from '../types';
import { Parsed } from './parse';
import { unwrap } from './syntax';

// Named functions, classes and class methods, in source order. Anonymous callbacks are left out.

function memberName(name: ts.PropertyName | undefined, sf: ts.SourceFile): string {
  if (!name) return 'anonymous';
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sf);
}

function className(node: ts.ClassLikeDeclaration): string {
  if (node.name) return node.name.text;
  const p = node.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return 'default';
}

const isFunctionValue = (e: ts.Expression) => ts.isArrowFunction(e) || ts.isFunctionExpression(e);

export function buildOutline(parsed: Parsed): OutlineItem[] {
  const { sf } = parsed;
  const items: OutlineItem[] = [];
  const push = (kind: OutlineItem['kind'], name: string, node: ts.Node) =>
    items.push({ kind, name, lineStart: parsed.startLine(node), lineEnd: parsed.endLine(node) });

  for (const node of parsed.nodes) {
    if (ts.isFunctionDeclaration(node) && node.body) {
      push('function', node.name?.text ?? 'default', node);
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      push('class', className(node), ts.isClassExpression(node) && ts.isVariableDeclaration(node.parent) ? node.parent : node);
    } else if (
      (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) &&
      ts.isClassLike(node.parent) &&
      node.body
    ) {
      const method = ts.isConstructorDeclaration(node) ? 'constructor' : memberName(node.name, sf);
      push('method', `${className(node.parent)}.${method}`, node);
    } else if (ts.isPropertyDeclaration(node) && node.initializer && isFunctionValue(unwrap(node.initializer)) && ts.isClassLike(node.parent)) {
      push('method', `${className(node.parent)}.${memberName(node.name, sf)}`, node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isFunctionValue(unwrap(node.initializer))) {
      // `export const handler = async () => {}`: the whole statement when it declares just this one.
      const list = node.parent;
      const statement = list && ts.isVariableDeclarationList(list) && list.declarations.length === 1 ? list.parent : node;
      push('function', node.name.text, statement && ts.isVariableStatement(statement) ? statement : node);
    } else if (ts.isExportAssignment(node) && isFunctionValue(unwrap(node.expression))) {
      push('function', 'default', node);
    }
  }
  return items.sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd);
}
