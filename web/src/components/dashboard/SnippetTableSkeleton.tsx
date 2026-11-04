import { SnippetTableHead, TABLE_FRAME_CLASS } from './SnippetTable';

const BAR = 'block h-3 animate-pulse rounded bg-gray-200 dark:bg-gray-700';
const TITLE_WIDTHS = ['w-48', 'w-64', 'w-40', 'w-56', 'w-44'];

// The table's shape with grey bars, shown while the first page loads.
export function SnippetTableSkeleton() {
  return (
    <div className={TABLE_FRAME_CLASS} aria-busy="true">
      <span className="sr-only" role="status">
        Loading snippets
      </span>
      <table aria-hidden className="w-full min-w-[44rem] text-left text-sm">
        <SnippetTableHead />
        <tbody className="divide-y divide-[var(--border)]">
          {TITLE_WIDTHS.map((width, i) => (
            <tr key={i}>
              <td className="px-4 py-4">
                <span className={`${BAR} ${width}`} />
              </td>
              <td className="px-4 py-4">
                <span className={`${BAR} w-16`} />
              </td>
              <td className="px-4 py-4">
                <span className={`${BAR} w-20`} />
              </td>
              <td className="px-4 py-4">
                <span className={`${BAR} w-24`} />
              </td>
              <td className="px-4 py-4">
                <span className={`${BAR} ml-auto w-28`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
