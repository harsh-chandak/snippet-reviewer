'use client';

import { SnippetForm } from '@/components/create';

export default function NewSnippetPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New snippet</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Paste the code you want reviewed, or load an example. The review lists each finding next to the code and highlights the lines it is about.
        </p>
      </div>
      <SnippetForm />
    </div>
  );
}
