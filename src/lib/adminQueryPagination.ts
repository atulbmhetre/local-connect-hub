/** Shared pagination caps for admin panel Supabase list queries (default PostgREST cap is 1000). */
export const ADMIN_QUERY_PAGE_SIZE = 1000;
export const ADMIN_QUERY_MAX_ROWS = 5000;
export const ADMIN_VENDOR_LIST_PAGE_SIZE = 200;

export function warnIfQueryTruncated(label: string, fetched: number, max: number): void {
  if (fetched >= max) {
    console.warn(
      `[admin-query] ${label}: fetched ${fetched} rows (at cap ${max}); results may be truncated`,
    );
  }
}

type ListResult<T> = { data: T[] | null; error: { message: string } | null };

/** Fetch all rows up to ADMIN_QUERY_MAX_ROWS using .range() pagination. */
export async function fetchAllPages<T>(
  label: string,
  fetchPage: (from: number, to: number) => Promise<ListResult<T>>,
  options?: { pageSize?: number; maxRows?: number },
): Promise<T[]> {
  const pageSize = options?.pageSize ?? ADMIN_QUERY_PAGE_SIZE;
  const maxRows = options?.maxRows ?? ADMIN_QUERY_MAX_ROWS;
  const all: T[] = [];
  let offset = 0;

  while (offset < maxRows) {
    const to = Math.min(offset + pageSize - 1, maxRows - 1);
    const { data, error } = await fetchPage(offset, to);
    if (error) throw error;
    const batch = data ?? [];
    all.push(...batch);
    if (batch.length < pageSize || offset + pageSize >= maxRows) break;
    offset += pageSize;
  }

  warnIfQueryTruncated(label, all.length, maxRows);
  return all;
}

/** Run .in(id, …) queries in chunks to avoid URL limits and silent row caps. */
export async function fetchByIdChunks<T>(
  label: string,
  ids: string[],
  fetchChunk: (chunkIds: string[]) => Promise<ListResult<T>>,
  chunkSize = 100,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const all: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await fetchChunk(chunk);
    if (error) {
      console.error(`[admin-query] ${label}`, error.message);
      continue;
    }
    all.push(...(data ?? []));
  }
  return all;
}
