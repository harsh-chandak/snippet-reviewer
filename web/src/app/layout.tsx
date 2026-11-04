import type { Metadata } from 'next';
import Link from 'next/link';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Snippet Reviewer',
  description: 'AI review for code snippets',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Browser extensions add attributes to <html> before React hydrates; this keeps that from
    // being reported as a mismatch (it applies to this element only, not to its children).
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} min-h-screen antialiased`}>
        <header className="border-b border-[var(--border)] bg-[var(--surface)]">
          <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
            <Link href="/" className="text-base font-semibold tracking-tight hover:opacity-80">
              Snippet Reviewer
            </Link>
            <Link
              href="/snippets/new"
              className="rounded-md border border-green-700 bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 dark:border-green-600 dark:bg-green-700 dark:hover:bg-green-600"
            >
              New snippet
            </Link>
          </div>
        </header>
        {/* Pages render inside this width; they need no container of their own. */}
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</div>
      </body>
    </html>
  );
}
