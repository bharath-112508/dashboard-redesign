/**
 * Bounded-concurrency helper (BACKEND_AUDIT.md R11).
 *
 * `Promise.all(items.map(fn))` fans out everything in parallel, which
 * is fine for small N but blasts an unbounded request rate at any
 * downstream service for large N. Most of our fan-out hot paths
 * (notification dispatcher → email + Slack) sit at the boundary
 * between "small project" (10 reviewers) and "100-member workspace",
 * so a small in-process concurrency cap is the cheapest defence.
 *
 * No external dep — `p-limit` is a single-file utility we can
 * inline here. The implementation is a minimal queue: keep at most
 * `limit` promises in flight; each completion pulls the next item.
 *
 * Failure semantics: a single rejection does NOT abort the rest. We
 * continue scheduling and return a Promise that rejects with the
 * FIRST error after every queued item has settled — same external
 * shape as `Promise.all`, just gentler on downstream services.
 */
export const runWithConcurrency = async <T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
    if (limit <= 0) throw new Error('runWithConcurrency: limit must be > 0');
    if (items.length === 0) return [];

    const results: R[] = new Array(items.length) as R[];
    let firstError: unknown = null;
    let cursor = 0;

    const worker = async (): Promise<void> => {
        while (cursor < items.length) {
            const i = cursor++;
            try {
                results[i] = await fn(items[i], i);
            } catch (err) {
                if (firstError === null) firstError = err;
                // Continue scheduling so siblings still complete; matches
                // the dispatcher's "best effort across recipients" contract.
            }
        }
    };

    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (firstError !== null) throw firstError;
    return results;
};
