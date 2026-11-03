// The messages under one form field. Renders nothing when there are none.
export function FieldError({ id, messages }: { id: string; messages?: string[] }) {
  if (!messages || messages.length === 0) return null;
  return (
    <div id={id} className="mt-1.5 space-y-0.5 text-sm text-red-700 dark:text-red-400">
      {messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  );
}
