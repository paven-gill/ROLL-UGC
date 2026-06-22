// Supabase caps any single read at 1000 rows. For tables that grow without
// bound — view_snapshots gains roughly one row per creator/platform per day —
// a plain `.select()` silently returns only the first 1000 rows. Because our
// snapshot queries sort ascending (oldest first), the rows that get dropped are
// the NEWEST ones, so "today" disappears and recent days read as zero.
//
// fetchAllRows pages through with .range() until every row is returned. Pair it
// with a `.gte(snapshot_date, ...)` lower bound so each request stays small and
// the page count stays low even as the table grows for years.
export async function fetchAllRows<T>(
  makeQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}
