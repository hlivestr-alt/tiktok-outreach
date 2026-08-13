# Affiliate Outreach Operations

TikTok Shop affiliate outreach operations with deterministic mock, real read-only, and explicitly gated live outbound modes. Real discovery/history and outbound mutation capabilities stay isolated in separate workers and adapters.

Detailed design notes are in [Architecture and safety](docs/architecture.md), [Persistent historical synchronization](docs/historical-sync.md), and [Future TikTok integration](docs/tiktok-integration.md).

## Safety boundary

- `APP_MODE` accepts `mock` or `read_only`; `OUTBOUND_MODE` separately accepts `mock`, `read_only`, or `live`.
- The real HTTP client has an explicit read-operation method/path allowlist.
- Read-only outbound mode ends at preview. Live mode additionally requires the exact `ENABLE_LIVE_TIKTOK_OUTBOUND` acknowledgement.
- Only approved TikTok authorization and read operations connect to TikTok; real TikTok mutation and outbound operations are physically blocked.
- The worker and web containers do not receive TikTok credentials, and no code connects to n8n.
- The unauthenticated application binds to localhost only.
- PostgreSQL stores exact frozen outbound messages; runtime logs use IDs and hashes only.

## Local start with Docker

1. Copy `.env.example` to `.env` if `.env` is missing.
2. Run `docker compose up --build`.
3. Open `http://127.0.0.1:3000`.
4. API documentation is at `http://127.0.0.1:4000/api/docs`.

The API container applies the checked-in Prisma migration before it starts.

The `history-worker` is an independent continuously running read-only process. It is not the outbound `worker` and receives only Conversation List and Message History capabilities. Start only history automation with:

```powershell
docker compose up -d postgres redis api web history-worker
```

For local development, build packages first and run `cmd /c pnpm --filter @affiliate/api start:history`. The initial backfill is started from **History readiness**; after it reaches the end, a bounded three-page incremental pass runs every six hours by default. These values are configurable with the `HISTORY_SYNC_*` environment variables.

Outbound workers are excluded from the default Compose profile. Start mock delivery with `docker compose --profile outbound-mock up worker`. After a separate live-validation approval and configuration, start the live worker with `docker compose --profile outbound-live up outbound-live`.

Live activation requires `APP_MODE=read_only`, `OUTBOUND_MODE=live`, `ENABLE_LIVE_TIKTOK_OUTBOUND=I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES`, healthy stored seller authorization, the selected shop cipher, and the existing server-side TikTok app credentials. The worker has only Create Conversation and Send Message methods; it has no discovery, history, or Mark Read method.

## Local development

```powershell
docker compose up -d postgres redis
cmd /c pnpm install
cmd /c pnpm db:migrate
cmd /c pnpm dev
```

Then open `http://127.0.0.1:3000`.

## Tests and builds

```powershell
cmd /c pnpm test
cmd /c pnpm typecheck
cmd /c pnpm build
```

## Mock workflow

1. Open **History readiness** and run the mock TikTok history sync. This imports 230 previous outbound conversations and makes them participate in cooldown checks.
2. Optionally import a CSV with `contacted_at` and either `creator_open_id` or `conversation_id`. Supported optional columns are `source_record_id`, `creator_user_id`, `username`, `external_message_id`, `campaign_name`, `message_body`, and `send_status`.
3. Create a campaign. Discovery produces 1,540 occurrences with 40 deliberate duplicates.
4. Review the exclusion breakdown and shortfall warning, then freeze the eligible selection.
5. Type the exact campaign name and selected count to enqueue mock sends.
6. Pause/resume from the campaign screen. Status refreshes every five seconds.

## Absolute safety ceilings

Defaults are 1,000 recipients per campaign, 4,000 provider dispatch attempts per campaign, 1,000 dispatches per Indonesia shop day, and 10 per rolling minute. PostgreSQL is authoritative for the maximum permitted dispatch rate and enforces these ceilings across worker restarts. The BullMQ/infrastructure limiter may operate more slowly, but it can never override the database ceiling.

## Delivery unknown

Selected fixture IDs occasionally return `DELIVERY_UNKNOWN`. They are never resent. Read-only reconciliation checks run after the configured delays. A single exact outbound content-hash match becomes `SENT`; zero or multiple matches remain blocked for review.

## Phase 2A read-only setup

Set `APP_MODE=read_only` and provide the four server-only `TIKTOK_*` credential variables described in [TikTok integration](docs/tiktok-integration.md). Do not paste credentials into chat or commit them. Without credentials the app starts normally as `READ_ONLY_NOT_CONFIGURED`.

Production should use one dedicated TikTok developer app for Outreach so its App × Shop API quota is isolated from order reporting and other systems. Provider throttles are persisted per shop and read operation; dynamic `429` cooldown uses exponential backoff with jitter rather than a hardcoded TikTok QPS claim.

## Current boundaries

- Authentication and multi-user authorization are intentionally deferred; all services bind to localhost.
- CSV import is supplied as a UTF-8 string through the local API/UI and is intended for mock or controlled historical exports.
- The mock adapter uses deterministic fixtures, not a complete simulation of every TikTok payload or market rule.
- The Docker build requires access to Docker Hub the first time it pulls `node:24-alpine`, PostgreSQL, and Redis images.
