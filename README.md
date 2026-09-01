# Affiliate Outreach Operations

For daily production operation, use the Docker-only workflow in [docs/PRODUCTION.md](docs/PRODUCTION.md). Start production with `.\scripts\start-production.cmd`; it always starts the API, web app, and dedicated live outbound worker.

TikTok Shop affiliate outreach operations with deterministic mock, real read-only, and production live outbound modes. Real discovery/history and outbound mutation capabilities stay isolated in separate workers and adapters.

Detailed design notes are in [Architecture and safety](docs/architecture.md), [Persistent historical synchronization](docs/historical-sync.md), and [Future TikTok integration](docs/tiktok-integration.md).

## Safety boundary

- `APP_MODE` accepts `mock` or `read_only`; `OUTBOUND_MODE` separately accepts `mock`, `read_only`, or `live`.
- The real HTTP client has an explicit read-operation method/path allowlist.
- Read-only outbound mode ends at preview. Production uses `APP_MODE=read_only` with `OUTBOUND_MODE=live` and exposes one idempotent Send action after the normal freeze safeguards pass.
- Only approved TikTok authorization and read operations connect to TikTok outside the dedicated mutation worker; the worker owns real outbound mutation and never performs discovery, history, or Mark Read operations.
- The worker and web containers do not receive TikTok credentials, and no code connects to n8n.
- The unauthenticated application binds to localhost only.
- PostgreSQL stores exact frozen outbound messages; runtime logs use IDs and hashes only.

## Production start with Docker

1. Copy `.env.example` to `.env` if `.env` is missing.
2. Configure the production TikTok credentials in `.env` and run `.\scripts\start-production.cmd`.
3. Open `http://127.0.0.1:3000`.
4. API documentation is at `http://127.0.0.1:4000/api/docs`.

The API container applies the checked-in Prisma migration before it starts.

The `history-worker` is an independent continuously running read-only process. It is not the outbound `worker` and receives only Conversation List and Message History capabilities. For a history-only development run (not a production deployment), use:

```powershell
docker compose --profile production up -d postgres redis api web history-worker
```

Production operations must use `scripts/start-production.cmd`, which includes `outbound-live`.

For local development, build packages first and run `cmd /c pnpm --filter @affiliate/api start:history`. The initial backfill is started from **History readiness**; after it reaches the end, a bounded three-page incremental pass runs every six hours by default. These values are configurable with the `HISTORY_SYNC_*` environment variables.

Local outbound workers are excluded from the default Compose profile. Start mock delivery with `docker compose --profile outbound-mock up worker`. The production profile always includes the live worker and is started by `scripts/start-production.cmd`.

Production availability requires `APP_MODE=read_only`, `OUTBOUND_MODE=live`, a healthy stored seller authorization, the selected shop cipher, a valid token, a fresh live-worker heartbeat, and the existing server-side TikTok app credentials. The UI reports the exact unavailable reason when any prerequisite is missing.

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
4. Review the exclusion breakdown and shortfall warning.
5. Press **Send to X affiliates** once. The action freezes the exact selection, materializes deterministic mock deliveries, and queues the campaign without typed confirmation.
6. Pause/resume from the campaign screen. Status refreshes every five seconds.

## Recipient capacity and provider throttling

`maxRecipientsPerCampaign` is the campaign capacity control. Send Message admission is durably coordinated per App × Shop and limited to one recipient per 1,000ms; Create Conversation retains adaptive concurrency. Dispatch, daily, hourly, and rolling-minute counters remain observability data. Provider 429/quota feedback, Retry-After/backoff, and DELIVERY_UNKNOWN handling can only make sending slower.

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
