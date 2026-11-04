// Dashboard-only shapes. web/src/lib/types.ts mirrors the API's core types; these extend them
// without touching that file.
import type { Snippet, SnippetPage } from './types';

// Open findings on a snippet's latest review, by severity (all zero when never reviewed).
export interface FindingCounts {
  open: number;
  critical: number;
  warning: number;
  info: number;
}

// One item in GET /snippets, with its finding counts.
export interface SnippetListItem extends Snippet {
  findingCounts: FindingCounts;
}

export interface SnippetListPage extends Omit<SnippetPage, 'items'> {
  items: SnippetListItem[];
}
