# Persistent historical synchronization

`HistorySyncJob` is the single private job per shop. Its opaque Conversation List cursors and each staged conversation's opaque Message History cursor are never projected by API code. The public projection contains only state, durable counts, sanitized provider codes/categories, and timestamps. The legacy `ContactHistorySyncRun.cursor` remains unused by the production worker.

The dedicated `history-worker` application context contains no outreach service, queue, campaign dispatch code, or outbound provider. `TikTokIntegrationService.historyAdapter()` returns an object with exactly `listConversations` and `listMessages`. The underlying real client additionally enforces exact GET-only path allowlists.

Each claim performs one list page or one message page. A Conversation List response is staged under a page sequence with its pending next cursor. Every conversation is then fully message-paginated and persisted by exact conversation/message IDs. Only after all staged work is complete is the pending cursor promoted to the durable backfill cursor. A crash before or after persistence therefore replays safe idempotent work and cannot advance past missing data.

During initial backfill the durable deep cursor is preserved. After every five completed backfill pages, a one-page fresh head pass reconciles new page-one conversations, then returns to the saved frontier. This prevents live head drift from forcing a restart. If the opaque deep cursor is rejected as invalid, the worker clears only cursor/work state, starts again at fresh page one, and uses exact persisted IDs to dedupe while rediscovering the historical frontier; completion is never inferred from that error.

The provider response has exact conversation IDs, IM IDs, unread count, and cursor state but no reliable per-conversation last-message version. Consequently, after the proven end of history the worker conservatively rereads the first three recent pages every six hours. Exact external message IDs make this safe and import new messages. This assumption covers new activity so long as conversations with activity remain within the configured recent-page window between passes; operators can increase `HISTORY_SYNC_INCREMENTAL_PAGES` or shorten the cadence if observed volume demands it.

The provider governor keeps `LIST_CONVERSATIONS` and `LIST_MESSAGES` as separate operation state rows, while one shared history single-flight lease permits at most one in-flight history request per shop. Marketplace uses its separate `SEARCH_CREATORS` lease and cooldown, so the two systems do not inherit one another's throttles. History honors `Retry-After`, uses durable exponential temporary/rate-limit backoff, and makes terminal authentication/permission failures operator-resumable without hot loops.

## Start commands

Docker: `docker compose up -d postgres redis api web history-worker`

Local compiled worker: `cmd /c pnpm --filter @affiliate/api start:history`

Do not start the outbound `worker` for read-only history operation.

The Compose `worker` service is behind the `outbound-mock` profile and is therefore not enabled by a default `docker compose up`.
