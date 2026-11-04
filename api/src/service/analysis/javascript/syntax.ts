import ts from 'typescript';
import { Parsed } from './parse';

// Small, non-recursive helpers over the TypeScript tree, shared by context detection and the rules.

// Strip parentheses and type-only wrappers: (x), x as T, x!, <T>x, x satisfies T.
export function unwrap(node: ts.Expression): ts.Expression {
  let e = node;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    else if (ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    else return e;
  }
}

// The operands of a chain of `+`, left to right: a + (b + c) + d -> [a, b, c, d].
export function plusOperands(node: ts.Expression): ts.Expression[] {
  const out: ts.Expression[] = [];
  const stack: ts.Expression[] = [node];
  while (stack.length > 0) {
    const e = unwrap(stack.pop()!);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) stack.push(e.right, e.left);
    else out.push(e);
  }
  return out;
}

export function isStringLiteralLike(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

// A string whose value is fixed in the source: 'a', `a`, 'a' + 'b', 'a' + 1.
export function isStaticString(node: ts.Expression): boolean {
  return plusOperands(node).every((e) => isStringLiteralLike(e) || ts.isNumericLiteral(e));
}

// The module a `require('x')` call loads, or null.
export function requiredModule(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'require') return null;
  const arg = node.arguments[0];
  return node.arguments.length === 1 && arg && isStringLiteralLike(arg) ? arg.text : null;
}

// Every module the code imports, requires, dynamically imports or re-exports.
export function importedModules(parsed: Parsed): string[] {
  const out: string[] = [];
  for (const node of parsed.nodes) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      if (ts.isStringLiteral(expr)) out.push(expr.text);
    } else if (ts.isCallExpression(node)) {
      const required = requiredModule(node);
      if (required !== null) out.push(required);
      else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && isStringLiteralLike(arg)) out.push(arg.text);
      }
    }
  }
  return out;
}

// An identifier used as a value, not as a property name (`x` in a.x) or a declared name.
export function isValueReference(node: ts.Identifier): boolean {
  const p = node.parent;
  if (!p) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === node) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === node) return false;
  if ((ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isFunctionExpression(p)) && p.name === node) return false;
  if (ts.isBindingElement(p) && p.propertyName === node) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isJsxAttribute(p) || ts.isLabeledStatement(p) || ts.isPropertySignature(p)) return false;
  if (ts.isQualifiedName(p) || ts.isTypeReferenceNode(p)) return false;
  return true;
}

// The leftmost identifier of a callee: describe.only.each -> describe, expect(x).toBe -> expect.
export function rootIdentifier(node: ts.Expression): ts.Identifier | null {
  let e = unwrap(node);
  for (;;) {
    if (ts.isIdentifier(e)) return e;
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e)) e = unwrap(e.expression);
    else if (ts.isTaggedTemplateExpression(e)) e = unwrap(e.tag);
    else return null;
  }
}

// Local variable declarations by name: `const x = init` and `const { x } = init` (x -> init).
export interface Declarations {
  initializersOf(name: string): ts.Expression[];
}

export function declarations(parsed: Parsed): Declarations {
  const map = new Map<string, ts.Expression[]>();
  const add = (name: string, init: ts.Expression) => {
    const list = map.get(name) ?? [];
    list.push(init);
    map.set(name, list);
  };
  for (const node of parsed.nodes) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      add(node.name.text, node.initializer);
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      let p: ts.Node = node.parent;
      while (p && (ts.isObjectBindingPattern(p) || ts.isArrayBindingPattern(p) || ts.isBindingElement(p))) p = p.parent;
      if (p && ts.isVariableDeclaration(p) && p.initializer) add(node.name.text, p.initializer);
    } else if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
    ) {
      add(node.left.text, node.right);
    }
  }
  return { initializersOf: (name) => map.get(name) ?? [] };
}

// Does `expr` use a value that comes from `roots` (e.g. req, request), directly or through local
// variables assigned from it (a few hops)? Walks with a stack, never recursion.
export function derivesFrom(expr: ts.Node, roots: Set<string>, decls: Declarations, maxHops = 4): boolean {
  const seen = new Set<string>();
  let frontier: ts.Node[] = [expr];
  for (let hop = 0; hop <= maxHops && frontier.length > 0; hop++) {
    const next: ts.Node[] = [];
    for (const start of frontier) {
      const stack: ts.Node[] = [start];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (ts.isIdentifier(node) && isValueReference(node)) {
          if (roots.has(node.text)) return true;
          if (!seen.has(node.text)) {
            seen.add(node.text);
            next.push(...decls.initializersOf(node.text));
          }
        }
        // Function bodies passed as values are not where the value comes from.
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) continue;
        node.forEachChild((child) => {
          stack.push(child);
        });
      }
    }
    frontier = next;
  }
  return false;
}

// What a module's bindings are called locally.
export interface ModuleBindings {
  namespaces: Set<string>; // import * as fs / import fs / const fs = require('fs') / const fsp = fs.promises
  named: Map<string, string>; // local name -> exported name: import { exec as run } -> run -> exec
}

export function moduleBindings(parsed: Parsed, modules: Set<string>): ModuleBindings {
  const namespaces = new Set<string>();
  const named = new Map<string, string>();
  const isModuleObject = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    if (ts.isAwaitExpression(x)) return isModuleObject(x.expression);
    const required = requiredModule(x);
    if (required !== null) return modules.has(required);
    if (ts.isCallExpression(x) && x.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = x.arguments[0];
      return !!arg && isStringLiteralLike(arg) && modules.has(arg.text);
    }
    if (ts.isIdentifier(x)) return namespaces.has(x.text);
    // fs.promises / require('fs').promises is the same module, promise flavoured.
    if (ts.isPropertyAccessExpression(x) && x.name.text === 'promises') return isModuleObject(x.expression);
    return false;
  };
  // The exported name a value refers to: exec, cp.exec, require('child_process').exec, promisify(exec).
  const exportedName = (e: ts.Expression): string | null => {
    const x = unwrap(e);
    if (ts.isIdentifier(x)) return named.get(x.text) ?? null;
    if (ts.isPropertyAccessExpression(x) && isModuleObject(x.expression)) return x.name.text;
    if (ts.isCallExpression(x) && x.arguments.length === 1) {
      const callee = unwrap(x.expression);
      const isPromisify =
        (ts.isIdentifier(callee) && callee.text === 'promisify') ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'promisify');
      if (isPromisify) return exportedName(x.arguments[0]);
    }
    return null;
  };

  // Two passes, so `const fsp = fs.promises` after `import fs` is found whatever the order.
  for (let pass = 0; pass < 2; pass++) {
    for (const node of parsed.nodes) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && modules.has(node.moduleSpecifier.text)) {
        const clause = node.importClause;
        if (!clause) continue;
        if (clause.name) namespaces.add(clause.name.text);
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
        else if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) named.set(el.name.text, (el.propertyName ?? el.name).text);
        }
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const expr = node.moduleReference.expression;
        if (ts.isStringLiteral(expr) && modules.has(expr.text)) namespaces.add(node.name.text);
      } else if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = node.initializer;
        if (ts.isIdentifier(node.name)) {
          if (isModuleObject(init)) namespaces.add(node.name.text);
          else {
            const exported = exportedName(init);
            if (exported) named.set(node.name.text, exported);
          }
        } else if (ts.isObjectBindingPattern(node.name) && isModuleObject(init)) {
          for (const el of node.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            named.set(el.name.text, prop);
          }
        }
      }
    }
  }
  return { namespaces, named };
}

// Is `callee` one of `functions` from the module these bindings describe? `fallbackNames` are
// identifiers taken to be the module even without an import (snippets often leave imports out).
export function calleeFromModule(
  callee: ts.Expression,
  bindings: ModuleBindings,
  modules: Set<string>,
  functions: Set<string>,
  fallbackNames: Set<string>,
): string | null {
  const c = unwrap(callee);
  if (ts.isIdentifier(c)) {
    const exported = bindings.named.get(c.text);
    return exported && functions.has(exported) ? exported : null;
  }
  if (!ts.isPropertyAccessExpression(c) || !functions.has(c.name.text)) return null;
  const isModule = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    if (ts.isIdentifier(x)) return bindings.namespaces.has(x.text) || fallbackNames.has(x.text);
    const required = requiredModule(x);
    if (required !== null) return modules.has(required);
    if (ts.isPropertyAccessExpression(x) && x.name.text === 'promises') return isModule(x.expression);
    return false;
  };
  return isModule(c.expression) ? c.name.text : null;
}
