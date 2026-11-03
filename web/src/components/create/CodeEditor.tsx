'use client';

import { forwardRef, useRef, type KeyboardEvent } from 'react';

const INDENT = '  ';

type Props = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  describedBy?: string;
};

// A plain monospace textarea for code. Tab inserts two spaces instead of moving focus;
// Shift+Tab, or Esc then Tab, still leaves the field so keyboard users are never trapped.
export const CodeEditor = forwardRef<HTMLTextAreaElement, Props>(function CodeEditor(
  { id, value, onChange, invalid, describedBy },
  ref,
) {
  const escaped = useRef(false);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      escaped.current = true;
      return;
    }
    if (e.key !== 'Tab' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || escaped.current) {
      escaped.current = false;
      return;
    }
    e.preventDefault();
    const el = e.currentTarget;
    // insertText keeps the browser's undo history and fires the input event React listens to.
    if (document.execCommand?.('insertText', false, INDENT)) return;
    const { selectionStart: start, selectionEnd: end } = el;
    onChange(value.slice(0, start) + INDENT + value.slice(end));
    requestAnimationFrame(() => el.setSelectionRange(start + INDENT.length, start + INDENT.length));
  }

  return (
    <textarea
      ref={ref}
      id={id}
      name="code"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      required
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      rows={20}
      wrap="off"
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      autoComplete="off"
      data-gramm="false"
      placeholder="Paste or type your code here"
      className={`block min-h-[24rem] w-full resize-y rounded-md border bg-[var(--background)] px-3 py-2 font-mono text-sm leading-6 text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-2 focus:ring-blue-500/60 ${
        invalid ? 'border-red-500 dark:border-red-500' : 'border-[var(--border)]'
      }`}
      style={{ tabSize: 2 }}
    />
  );
});
