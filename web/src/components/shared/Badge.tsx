// The pill every badge and tag is drawn with. Colour classes come from the caller.
export function Badge({ className, children, title }: { className: string; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium leading-4 ${className}`}
    >
      {children}
    </span>
  );
}
