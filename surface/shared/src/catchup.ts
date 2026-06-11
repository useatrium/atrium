export const MAX_CATCHUP_PAGES = 5;

export type CatchUpStep = 'done' | 'continue' | 'refetch-latest';

export function nextCatchUpStep({
  hasMore,
  pagesFetched,
  maxPages = MAX_CATCHUP_PAGES,
}: {
  hasMore: boolean;
  pagesFetched: number;
  maxPages?: number;
}): CatchUpStep {
  if (!hasMore) return 'done';
  return pagesFetched >= maxPages ? 'refetch-latest' : 'continue';
}
