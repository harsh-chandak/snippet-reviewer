'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { HighlighterCore } from 'shiki/core';
import type { Language } from '@/lib/types';

// One coloured run of text on a line. `style` carries the light colour as `color` and the
// dark one as `--shiki-dark`; CodeView swaps to the dark one under prefers-color-scheme.
export interface CodeToken {
  content: string;
  style: CSSProperties;
}

type ShikiLang = Exclude<Language, 'other'>;

// Each grammar is its own chunk, fetched only when a snippet in that language is opened.
// Our language ids are the same as shiki's; the map is explicit so the bundler only
// emits these twelve grammars instead of all of shiki's. 'other' is shown as plain text.
const GRAMMARS: Record<ShikiLang, () => Promise<unknown>> = {
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
};

const THEMES = { light: 'github-light', dark: 'github-dark' } as const;

// shiki is loaded on first use, in the browser only, so other pages never download it.
// The JavaScript regex engine avoids shipping the Oniguruma WebAssembly binary.
let highlighter: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    return createHighlighterCore({
      themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  // A failed load (network blip) should not poison every later attempt.
  highlighter.catch(() => {
    highlighter = null;
  });
  return highlighter;
}

// shiki reports CSS in property-name form (`font-style`); React wants `fontStyle`.
function toReactStyle(css: Record<string, string> | undefined): CSSProperties {
  const style: Record<string, string> = {};
  if (!css) return style;
  for (const [key, value] of Object.entries(css)) {
    const name = key.startsWith('--') ? key : key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    style[name] = value;
  }
  return style as CSSProperties;
}

// Tokens per line, one array per line of `code` split on '\n' (the API counts lines the
// same way, so finding line numbers index straight into this). Null for plain text.
export async function tokenizeLines(code: string, language: Language): Promise<CodeToken[][] | null> {
  if (language === 'other') return null;
  const hl = await getHighlighter();
  // loadLanguage accepts the module promise directly; it ignores a grammar already loaded.
  await hl.loadLanguage(GRAMMARS[language]() as Parameters<HighlighterCore['loadLanguage']>[0]);
  const { tokens } = hl.codeToTokens(code.replace(/\r\n?/g, '\n'), { lang: language, themes: THEMES });
  return tokens.map((line) => line.map((t) => ({ content: t.content, style: toReactStyle(t.htmlStyle) })));
}

// Highlighted lines for the code, or null while shiki loads (and for good if it fails,
// in which case the plain lines simply stay).
export function useHighlightedLines(code: string, language: Language): CodeToken[][] | null {
  const [result, setResult] = useState<{ key: string; tokens: CodeToken[][] | null } | null>(null);
  const key = `${language}\u0000${code}`;

  useEffect(() => {
    let cancelled = false;
    tokenizeLines(code, language)
      .then((tokens) => {
        if (!cancelled) setResult({ key, tokens });
      })
      .catch((err) => {
        console.warn('Syntax highlighting unavailable; showing plain text.', err);
      });
    return () => {
      cancelled = true;
    };
  }, [code, language, key]);

  // Never show tokens computed for different code.
  return result && result.key === key ? result.tokens : null;
}
