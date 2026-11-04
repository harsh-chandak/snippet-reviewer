import ts from 'typescript';
import { CodeContext } from '../../../model/constants';
import { DetectedContext } from '../types';
import { Parsed } from './parse';
import { importedModules, isStringLiteralLike, isValueReference, plusOperands, rootIdentifier, unwrap } from './syntax';

// Which kind of code this is, from imports, calls and syntax only. Each signal is a plain-word
// reason the user sees. Any test signal makes it 'test'; otherwise frontend, backend and script
// signals are weighted and the highest total wins (ties: frontend, then backend, then script).
// No signal at all: 'unknown'.

const FRONTEND_MODULE = /^(react|react-dom|next|vue|svelte|preact|solid-js|@angular\/core)(\/|$)/;
const BACKEND_SERVER_MODULE = /^(express|fastify|koa|@koa\/router|koa-router|@hapi\/hapi|hapi|http|https|http2|@nestjs\/[a-z-]+)$/;
const BACKEND_DATA_MODULE =
  /^(pg|pg-promise|postgres|mysql|mysql2|mysql2\/promise|sequelize|@prisma\/client|prisma|mongoose|mongodb|knex|typeorm|better-sqlite3|sqlite3|sqlite|redis|ioredis|drizzle-orm)(\/|$)/;
const BACKEND_NODE_MODULE = /^(fs|fs\/promises|fs-extra|child_process|path|os|net|cluster|worker_threads|crypto|stream|zlib)$/;
const TEST_MODULE = /^(vitest|jest|@jest\/globals|mocha|chai|node:test|supertest|@testing-library\/[a-z-]+|@playwright\/test|cypress)$/;
const TEST_FUNCTIONS = new Set(['describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
const REQUEST_NAMES = new Set(['req', 'request']);
const RESPONSE_NAMES = new Set(['res', 'response', 'reply']);
const SQL_CALLS = new Set(['query', 'execute']);
export const SQL_KEYWORDS =
  /\b(select|insert\s+into|update|delete\s+from|create\s+table|drop\s+table|alter\s+table|where|values|order\s+by|group\s+by|join)\b/i;
const CONSOLE_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'table']);
const MAX_SIGNALS = 8;

type Scored = 'frontend' | 'backend' | 'script';

// Literal text in a .query()/.execute() argument, to tell SQL from other uses of those names.
function literalText(arg: ts.Expression): string {
  return plusOperands(arg)
    .map((e) => {
      if (isStringLiteralLike(e)) return e.text;
      if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => s.literal.text).join(' ');
      return ' ';
    })
    .join('');
}

export function looksLikeSql(arg: ts.Expression): boolean {
  return SQL_KEYWORDS.test(literalText(unwrap(arg)));
}

export function detectContext(parsed: Parsed): DetectedContext {
  return detectContexts(parsed).detected;
}

// The winning context (the label and the model's focus) and every context with at least one
// signal. The rules run for all of those (the decision 'rules for detected contexts'): a Next.js
// route that imports next/server and runs SQL, or an Express file that calls it.next(), keeps its
// backend rules although another context won (STA-4, STA-5).
export function detectContexts(parsed: Parsed): { detected: DetectedContext; signaled: CodeContext[] } {
  const test: string[] = [];
  const signals: Record<Scored, string[]> = { frontend: [], backend: [], script: [] };
  const score: Record<Scored, number> = { frontend: 0, backend: 0, script: 0 };
  const seen = new Set<string>();
  const add = (ctx: Scored | 'test', signal: string, weight: number) => {
    if (seen.has(signal)) return;
    seen.add(signal);
    if (ctx === 'test') test.push(signal);
    else {
      signals[ctx].push(signal);
      score[ctx] += weight;
    }
  };

  for (const spec of importedModules(parsed)) {
    const m = spec.replace(/^node:(?!test$)/, '');
    if (TEST_MODULE.test(spec) || TEST_MODULE.test(m)) add('test', `imports ${spec}`, 0);
    else if (FRONTEND_MODULE.test(m)) add('frontend', `imports ${spec}`, 2);
    else if (BACKEND_SERVER_MODULE.test(m) || BACKEND_DATA_MODULE.test(m)) add('backend', `imports ${spec}`, 2);
    else if (BACKEND_NODE_MODULE.test(m)) add('backend', `imports ${spec}`, 1);
  }

  let hooks = 0;
  for (const node of parsed.nodes) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      add('frontend', 'uses JSX', 2);
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const root = rootIdentifier(callee);
      if (root && TEST_FUNCTIONS.has(root.text) && (ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee))) {
        add('test', `calls ${root.text}()`, 0);
      }
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name && /^use[A-Z]\w*$/.test(name) && hooks < 3) {
        if (!seen.has(`calls ${name}`)) hooks++;
        add('frontend', `calls ${name}`, 1);
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const obj = unwrap(callee.expression);
        if (ts.isIdentifier(obj) && obj.text === 'console' && CONSOLE_METHODS.has(callee.name.text)) {
          add('script', 'logs to the console', 1);
        }
        if (SQL_CALLS.has(callee.name.text) && node.arguments[0] && looksLikeSql(node.arguments[0])) {
          add('backend', `runs SQL through .${callee.name.text}()`, 2);
        }
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      const obj = unwrap(node.expression);
      if (ts.isIdentifier(obj) && obj.text === 'process') {
        if (node.name.text === 'env') add('backend', 'reads process.env', 1);
        if (node.name.text === 'argv') add('script', 'reads process.argv', 2);
      }
    } else if (ts.isIdentifier(node) && (node.text === 'document' || node.text === 'window') && isValueReference(node)) {
      add('frontend', `uses ${node.text}`, 1);
    } else if (ts.isFunctionLike(node) && 'parameters' in node && node.parameters.length >= 2) {
      const [a, b] = node.parameters;
      if (ts.isIdentifier(a.name) && ts.isIdentifier(b.name) && REQUEST_NAMES.has(a.name.text) && RESPONSE_NAMES.has(b.name.text)) {
        add('backend', `has a (${a.name.text}, ${b.name.text}) handler`, 2);
      }
    }
  }

  const order: Scored[] = ['frontend', 'backend', 'script'];
  const signaled: CodeContext[] = [...(test.length > 0 ? (['test'] as const) : []), ...order.filter((c) => signals[c].length > 0)];
  if (test.length > 0) return { detected: { context: 'test', signals: test.slice(0, MAX_SIGNALS) }, signaled };
  let best: Scored | null = null;
  for (const ctx of order) if (score[ctx] > 0 && (best === null || score[ctx] > score[best])) best = ctx;
  if (best === null) return { detected: { context: 'unknown', signals: [] }, signaled };
  return { detected: { context: best as CodeContext, signals: signals[best].slice(0, MAX_SIGNALS) }, signaled };
}
