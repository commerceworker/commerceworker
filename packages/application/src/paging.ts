/**
 * Reads `page` until a short page says there is no more. For store listings that must be
 * complete (an export, an environment comparison): a store's list without a limit answers only
 * its first page (100 rows on D1), and code that treated that as "everything" silently dropped
 * the rest.
 */
export async function allPages<T>(
  page: (skip: number, limit: number) => Promise<readonly T[]>,
  size = 200,
): Promise<T[]> {
  const out: T[] = [];
  for (let skip = 0; ; skip += size) {
    const rows = await page(skip, size);
    out.push(...rows);
    if (rows.length < size) return out;
  }
}
