import type { Language } from '@/lib/types';
import { Badge } from './Badge';

export const LANGUAGE_LABELS: Record<Language, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  java: 'Java',
  go: 'Go',
  rust: 'Rust',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  ruby: 'Ruby',
  php: 'PHP',
  sql: 'SQL',
  other: 'Other',
};

export function LanguageTag({ language }: { language: Language }) {
  return (
    <Badge className="border-gray-200 bg-gray-100 font-mono text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
      {LANGUAGE_LABELS[language]}
    </Badge>
  );
}
