'use client';

import { SnippetForm } from '@/components/create';

export default function NewSnippetPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New snippet</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Paste the code you want reviewed. Findings show up inline, under the lines they refer to.
        </p>
      </div>
      <SnippetForm />
    </div>
  );
}
