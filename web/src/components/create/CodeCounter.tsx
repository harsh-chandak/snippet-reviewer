import { MAX_CODE_CHARS, MAX_CODE_LINES } from '@/lib/types';

// Counts the way the API does: lines are split on \n, characters are the string length.
export function countCode(code: string): { lines: number; chars: number } {
  return { lines: code === '' ? 0 : code.split('\n').length, chars: code.length };
}

function Count({ value, max, unit }: { value: number; max: number; unit: string }) {
  const over = value > max;
  return (
    <span className={over ? 'font-medium text-red-700 dark:text-red-400' : undefined}>
      {value.toLocaleString()} / {max.toLocaleString()} {unit}
      {over && <span className="sr-only"> (over the limit)</span>}
    </span>
  );
}

// The live "lines / characters" line under the code field.
export function CodeCounter({ id, code }: { id: string; code: string }) {
  const { lines, chars } = countCode(code);
  return (
    <p id={id} className="flex gap-4 font-mono text-xs tabular-nums text-[var(--muted)]">
      <Count value={lines} max={MAX_CODE_LINES} unit="lines" />
      <Count value={chars} max={MAX_CODE_CHARS} unit="characters" />
    </p>
  );
}
