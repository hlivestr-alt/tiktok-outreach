# Affiliate Outreach Operations

TikTok Shop affiliate outreach operations with a deterministic Phase 1 mock workflow and a Phase 2A real TikTok read-only workflow. Real mode supports seller authorization, Indonesian shop selection, marketplace discovery/performance, and resumable history backfill while keeping TikTok outbound physically unavailable.

Detailed design notes are in [Architecture and safety](docs/architecture.md) and [Future TikTok integration](docs/tiktok-integration.md).

## Safety boundary

- `APP_MODE` accepts only `mock` or `read_only`.
- The real HTTP client has an explicit read-operation method/path allowlist.
- Real campaigns end at preview and cannot freeze, queue, or dispatch.
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

## Current boundaries

- Authentication and multi-user authorization are intentionally deferred; all services bind to localhost.
- CSV import is supplied as a UTF-8 string through the local API/UI and is intended for mock or controlled historical exports.
- The mock adapter uses deterministic fixtures, not a complete simulation of every TikTok payload or market rule.
- The Docker build requires access to Docker Hub the first time it pulls `node:24-alpine`, PostgreSQL, and Redis images.
