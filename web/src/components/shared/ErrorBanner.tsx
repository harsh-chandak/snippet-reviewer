// A red box for an error message. Pass onRetry to show a "Try again" button.
export function ErrorBanner({
  message,
  title,
  onRetry,
}: {
  message: string;
  title?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
    >
      <div>
        {title && <p className="font-semibold">{title}</p>}
        <p className="whitespace-pre-wrap break-words">{message}</p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-800 hover:bg-red-100 dark:border-red-700 dark:bg-red-900 dark:text-red-100 dark:hover:bg-red-800"
        >
          Try again
        </button>
      )}
    </div>
  );
}
