'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export default function Home() {
  const [status, setStatus] = useState<'checking' | 'up' | 'down'>('checking');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ db: string }>('/health')
      .then(() => setStatus('up'))
      .catch((err: Error) => {
        setStatus('down');
        setError(err.message);
      });
  }, []);

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">Snippet Reviewer</h1>
      <p className="mt-4 text-sm">
        API: <span className="font-mono">{status}</span>
        {error && <span className="ml-2 text-red-600">{error}</span>}
      </p>
    </main>
  );
}
