'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, createSnippet, errorMessage, startReview } from '@/lib/api';
import { LANGUAGES, MAX_CODE_CHARS, MAX_CODE_LINES, type FieldErrors, type Language } from '@/lib/types';
import { ErrorBanner, LANGUAGE_LABELS } from '@/components/shared';
import { CodeCounter, countCode } from './CodeCounter';
import { CodeEditor } from './CodeEditor';
import { FieldError } from './FieldError';

const MAX_TITLE_CHARS = 200;
const FIELDS = ['title', 'language', 'code'] as const;
type Field = (typeof FIELDS)[number];

// Quick checks for instant feedback. The API runs the same rules and has the last word.
function checkLocally(title: string, language: Language | '', code: string): FieldErrors {
  const errors: FieldErrors = {};
  const trimmed = title.trim();
  if (!trimmed) errors.title = ['Give the snippet a title.'];
  else if (trimmed.length > MAX_TITLE_CHARS) errors.title = [`Title must be at most ${MAX_TITLE_CHARS} characters.`];

  if (!language) errors.language = ['Choose a language.'];

  const { lines, chars } = countCode(code);
  const codeErrors: string[] = [];
  if (!code.trim()) codeErrors.push('Paste some code to review.');
  if (lines > MAX_CODE_LINES) codeErrors.push(`Code must be at most ${MAX_CODE_LINES.toLocaleString()} lines.`);
  if (chars > MAX_CODE_CHARS) codeErrors.push(`Code must be at most ${MAX_CODE_CHARS.toLocaleString()} characters.`);
  if (codeErrors.length) errors.code = codeErrors;

  return errors;
}

// The API can name a field this form does not show; those messages go in the banner.
function otherFieldMessages(errors: FieldErrors): string | null {
  const lines = Object.entries(errors)
    .filter(([field]) => !(FIELDS as readonly string[]).includes(field))
    .flatMap(([field, messages]) => messages.map((m) => (m.startsWith(field) ? m : `${field}: ${m}`)));
  return lines.length ? lines.join('\n') : null;
}

const inputClass =
  'block w-full rounded-md border bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-2 focus:ring-blue-500/60';

export function SnippetForm() {
  const router = useRouter();
  const id = useId();
  const ids = {
    title: `${id}-title`,
    language: `${id}-language`,
    code: `${id}-code`,
    codeHelp: `${id}-code-help`,
    codeCount: `${id}-code-count`,
    review: `${id}-review`,
  };
  const errorId = (field: Field) => `${id}-${field}-error`;

  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<Language | ''>('');
  const [code, setCode] = useState('');
  const [reviewNow, setReviewNow] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const languageRef = useRef<HTMLSelectElement>(null);
  const codeRef = useRef<HTMLTextAreaElement>(null);
  const refs = { title: titleRef, language: languageRef, code: codeRef };

  function clearError(field: Field) {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function showFieldErrors(errors: FieldErrors) {
    setFieldErrors(errors);
    const first = FIELDS.find((field) => errors[field]?.length);
    if (first) refs[first].current?.focus();
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current) return;
    setFormError(null);

    const local = checkLocally(title, language, code);
    if (Object.keys(local).length) {
      showFieldErrors(local);
      return;
    }
    setFieldErrors({});

    inFlight.current = true;
    setSubmitting(true);
    try {
      const snippet = await createSnippet({ title, language: language as Language, code });
      if (reviewNow) {
        // If this fails the snippet still exists; its page shows the review state and a retry.
        await startReview(snippet.id).catch(() => undefined);
      }
      router.push(`/snippets/${snippet.id}`);
      // Stay disabled until the navigation replaces this page.
    } catch (err) {
      inFlight.current = false;
      setSubmitting(false);
      const errors = err instanceof ApiError ? err.fieldErrors : null;
      if (errors) {
        showFieldErrors(errors);
        const other = otherFieldMessages(errors);
        if (other) setFormError(other);
      } else {
        setFormError(errorMessage(err));
      }
    }
  }

  const describe = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ') || undefined;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {formError && <ErrorBanner title="Could not create the snippet" message={formError} />}

      <div>
        <label htmlFor={ids.title} className="mb-1.5 block text-sm font-medium">
          Title
        </label>
        <input
          ref={titleRef}
          id={ids.title}
          name="title"
          type="text"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            clearError('title');
          }}
          required
          maxLength={MAX_TITLE_CHARS}
          autoComplete="off"
          placeholder="e.g. Debounce helper for the search box"
          aria-invalid={fieldErrors.title ? true : undefined}
          aria-describedby={describe(fieldErrors.title && errorId('title'))}
          className={`${inputClass} ${fieldErrors.title ? 'border-red-500' : 'border-[var(--border)]'}`}
        />
        <FieldError id={errorId('title')} messages={fieldErrors.title} />
      </div>

      <div>
        <label htmlFor={ids.language} className="mb-1.5 block text-sm font-medium">
          Language
        </label>
        <select
          ref={languageRef}
          id={ids.language}
          name="language"
          value={language}
          onChange={(e) => {
            setLanguage(e.target.value as Language | '');
            clearError('language');
          }}
          required
          aria-invalid={fieldErrors.language ? true : undefined}
          aria-describedby={describe(fieldErrors.language && errorId('language'))}
          className={`${inputClass} sm:w-64 ${fieldErrors.language ? 'border-red-500' : 'border-[var(--border)]'}`}
        >
          <option value="" disabled>
            Choose a language
          </option>
          {LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>
              {LANGUAGE_LABELS[lang]}
            </option>
          ))}
        </select>
        <FieldError id={errorId('language')} messages={fieldErrors.language} />
      </div>

      <div>
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <label htmlFor={ids.code} className="block text-sm font-medium">
            Code
          </label>
          <p id={ids.codeHelp} className="text-xs text-[var(--muted)]">
            Tab inserts two spaces. Press Esc then Tab to move on.
          </p>
        </div>
        <CodeEditor
          ref={codeRef}
          id={ids.code}
          value={code}
          onChange={(value) => {
            setCode(value);
            clearError('code');
          }}
          invalid={!!fieldErrors.code}
          describedBy={describe(ids.codeHelp, ids.codeCount, fieldErrors.code && errorId('code'))}
        />
        <div className="mt-1.5">
          <CodeCounter id={ids.codeCount} code={code} />
        </div>
        <FieldError id={errorId('code')} messages={fieldErrors.code} />
      </div>

      <div className="flex items-center gap-2">
        <input
          id={ids.review}
          type="checkbox"
          checked={reviewNow}
          onChange={(e) => setReviewNow(e.target.checked)}
          className="h-4 w-4 rounded border-[var(--border)] accent-green-600"
        />
        <label htmlFor={ids.review} className="text-sm">
          Start a review right away
        </label>
      </div>

      <div className="flex items-center gap-3 border-t border-[var(--border)] pt-6">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md border border-green-700 bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] disabled:cursor-not-allowed disabled:opacity-60 dark:border-green-600 dark:bg-green-700 dark:hover:bg-green-600"
        >
          {submitting ? 'Creating…' : 'Create snippet'}
        </button>
        <Link
          href="/"
          className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium hover:bg-[var(--background)] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
