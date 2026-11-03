'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage, getReview, getSnippet, setFindingStatus, startReview } from '@/lib/api';
import { ACTIVE_REVIEW_STATUSES } from '@/lib/types';
import type { FindingStatus, Review, ReviewStatus, SnippetDetail, SnippetReviewStatus } from '@/lib/types';

// How often to ask GET /reviews/:id about a pending or running review.
export const POLL_INTERVAL_MS = 2000;

export function isActive(status: ReviewStatus): boolean {
  return ACTIVE_REVIEW_STATUSES.includes(status);
}

// The snippet's status as the header shows it, following the review we hold locally
// (the snippet row we loaded goes stale as soon as a review starts or finishes).
function snippetStatus(snippet: SnippetDetail, review: Review | null): SnippetReviewStatus {
  if (!review) return snippet.reviewStatus;
  if (isActive(review.status)) return 'in_progress';
  return review.status === 'done' ? 'reviewed' : 'failed';
}

export interface SnippetReviewState {
  snippet: SnippetDetail | null;
  loading: boolean;
  loadError: unknown;
  notFound: boolean;
  reload: () => void;
  review: Review | null;
  status: SnippetReviewStatus | null;
  active: boolean;
  starting: boolean;
  startError: string | null;
  pollError: string | null;
  start: () => void;
  pendingFindings: ReadonlySet<number>;
  findingErrors: Readonly<Record<number, string>>;
  updateFinding: (findingId: number, status: FindingStatus) => void;
}

export function useSnippetReview(snippetId: number): SnippetReviewState {
  const validId = Number.isInteger(snippetId) && snippetId > 0;
  const [snippet, setSnippet] = useState<SnippetDetail | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(validId);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pendingFindings, setPendingFindings] = useState<ReadonlySet<number>>(new Set());
  const [findingErrors, setFindingErrors] = useState<Record<number, string>>({});
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Load the snippet and its latest review. If that review is still pending or running,
  // the polling effect below picks it up, so a reload mid-review resumes where it was.
  useEffect(() => {
    if (!validId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    getSnippet(snippetId)
      .then((s) => {
        if (cancelled) return;
        setSnippet(s);
        setReview(s.latestReview);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [snippetId, validId, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // Poll GET /reviews/:id every 2 s while the review is pending or running. The effect is
  // keyed on the active review's id, so it stops (and clears its interval) as soon as the
  // review is done or failed, when another review replaces it, and on unmount.
  const activeReviewId = review && isActive(review.status) ? review.id : null;
  useEffect(() => {
    if (activeReviewId === null) return;
    let cancelled = false;
    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) return; // a slow response must not stack requests
      inFlight = true;
      try {
        const next = await getReview(activeReviewId);
        if (cancelled) return;
        setPollError(null);
        setReview(next);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.isNotFound) {
          // The review is gone; the snippet's own latest review is the truth now.
          reload();
          return;
        }
        // Keep polling: a blip in the API should not abandon a review that is still running.
        setPollError(`${errorMessage(err)} Still trying…`);
      } finally {
        inFlight = false;
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeReviewId, reload]);

  const start = useCallback(async () => {
    if (!validId) return;
    setStarting(true);
    setStartError(null);
    setPollError(null);
    try {
      const created = await startReview(snippetId);
      if (!mounted.current) return;
      // POST returns the review without findings; polling fills them in when it is done.
      setReview({ ...created, findings: [] });
      setFindingErrors({});
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.isConflict) {
        // A review is already running (another tab, a double click). Follow that one.
        try {
          const fresh = await getSnippet(snippetId);
          if (!mounted.current) return;
          setSnippet(fresh);
          setReview(fresh.latestReview);
        } catch (refetchErr) {
          if (mounted.current) setStartError(errorMessage(refetchErr));
        }
      } else {
        setStartError(errorMessage(err));
      }
    } finally {
      if (mounted.current) setStarting(false);
    }
  }, [snippetId, validId]);

  // Accept, dismiss or reopen. The card changes at once; if the PATCH fails, that one
  // finding goes back to the status it had and the card shows why.
  const updateFinding = useCallback(
    async (findingId: number, status: FindingStatus) => {
      const previous = review?.findings?.find((f) => f.id === findingId)?.status;
      if (!previous || previous === status) return;

      const setStatusLocally = (next: FindingStatus) =>
        setReview((r) =>
          r?.findings ? { ...r, findings: r.findings.map((f) => (f.id === findingId ? { ...f, status: next } : f)) } : r,
        );
      const setPending = (on: boolean) =>
        setPendingFindings((s) => {
          const next = new Set(s);
          if (on) next.add(findingId);
          else next.delete(findingId);
          return next;
        });

      setStatusLocally(status);
      setPending(true);
      setFindingErrors((e) => {
        const next = { ...e };
        delete next[findingId];
        return next;
      });
      try {
        const saved = await setFindingStatus(findingId, status);
        if (!mounted.current) return;
        setReview((r) =>
          r?.findings ? { ...r, findings: r.findings.map((f) => (f.id === findingId ? saved : f)) } : r,
        );
      } catch (err) {
        if (!mounted.current) return;
        setStatusLocally(previous);
        setFindingErrors((e) => ({ ...e, [findingId]: `Could not save: ${errorMessage(err)}` }));
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [review],
  );

  return {
    snippet,
    loading,
    loadError,
    notFound: !validId || (loadError instanceof ApiError && loadError.isNotFound),
    reload,
    review,
    status: snippet ? snippetStatus(snippet, review) : null,
    active: !!review && isActive(review.status),
    starting,
    startError,
    pollError,
    start,
    pendingFindings,
    findingErrors,
    updateFinding,
  };
}
