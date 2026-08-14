/** Public projection for the local, database-backed campaign preview run.
 * Provider cursors remain exclusive to CreatorSyncJob and are never exposed. */
export function publicDiscoveryRun(run: {
  state: string; requestedTarget: number; candidateLimit: number; pagesFetched: number; candidatesFetched: number;
  nextAttemptAt: Date | null; consecutiveThrottleCount: number; totalProviderRequests: number; lastProviderCode: string | null;
  failureCategory: string | null; createdAt: Date; updatedAt: Date; completedAt: Date | null;
}) {
  return {
    state: run.state, requestedTarget: run.requestedTarget, candidateLimit: run.candidateLimit,
    pagesFetched: run.pagesFetched, candidatesFetched: run.candidatesFetched,
    nextAttemptAt: run.nextAttemptAt, consecutiveThrottleCount: run.consecutiveThrottleCount,
    totalProviderRequests: run.totalProviderRequests, lastProviderCode: run.lastProviderCode,
    failureCategory: run.failureCategory, createdAt: run.createdAt, updatedAt: run.updatedAt, completedAt: run.completedAt
  };
}
