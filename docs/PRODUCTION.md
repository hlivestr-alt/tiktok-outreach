# TikTok Outreach production operations

This guide is for the TikTok Outreach repository only. Production uses Docker Compose exclusively; do not mix host-launched `pnpm` API, web, or worker processes with these services.

## First-time setup

1. Enable **Start Docker Desktop when you sign in** and ensure Docker Desktop starts its engine automatically.
2. Copy `.env.example` to `.env` in the repository root.
3. Set the dedicated TikTok Outreach app values: `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET`, `TIKTOK_SERVICE_ID`, and a strong `TIKTOK_TOKEN_ENCRYPTION_KEY`. Do not reuse TikTok Orders Reporting credentials.
4. Keep `APP_MODE=read_only`. For the safe mode, keep `OUTBOUND_MODE=read_only` and the live acknowledgement unset.
5. Authorize and select the intended Indonesian shop in **Integration & safety** if it is not already selected.

`.env` is ignored by Git. Compose loads it directly into each applicable container; production roles explicitly override runtime mode, database/Redis networking, and activation state. Windows user-level TikTok variables are not inherited into containers unless they are intentionally written into this repository's `.env`.

## Build, migrate, and start

Safe production read-only (recommended daily default):

```powershell
.\scripts\start-production.cmd
```

Production live outbound:

```powershell
.\scripts\start-production.cmd -LiveOutbound
```

The live command explicitly supplies both required gates: `OUTBOUND_MODE=live` and `ENABLE_LIVE_TIKTOK_OUTBOUND=I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES`. The worker still cannot send until a user previews, freezes, types the exact campaign name and selected count, confirms, and queues a campaign.

The start script records the current Git SHA/build time, rebuilds current images, removes the obsolete `tiktokoutreach-validation-api` container if present, runs additive Prisma migrations through API startup, starts the selected profile, and removes obsolete services from this Compose project. It never resets the database.

Manual equivalent for safe mode:

```powershell
$env:APP_VERSION=(git rev-parse HEAD).Trim()
$env:BUILD_TIMESTAMP=[DateTime]::UtcNow.ToString('o')
$env:OUTBOUND_MODE='read_only'
$env:ENABLE_LIVE_TIKTOK_OUTBOUND='NOT_ACKNOWLEDGED'
docker compose --profile production build
docker compose --profile production up -d --remove-orphans
```

Apply migrations without starting the API (safe, additive deploy only):

```powershell
docker compose --profile production run --rm api pnpm db:migrate
```

Never use `prisma migrate reset` in production.

## Stop, status, and logs

```powershell
.\scripts\stop-production.cmd
.\scripts\status-production.cmd
docker compose --profile production --profile outbound-live logs --tail 200 api discovery-worker history-worker outbound-live
```

The status script reports container health, build version, worker heartbeats, outbound mode, authorization state, and sanitized queue counts. The same information appears in **Integration & safety → Production system status**.

## Normal campaign operation

1. Create a campaign. The API persists a `DiscoveryRun`; page navigation never calls TikTok.
2. The always-running discovery worker claims due runs. It persists candidates, cursor, and backoff after every provider page.
3. Review the preview. **Clone campaign** explicitly uses the previous persisted candidate snapshot and makes no Marketplace call; it is not fresh discovery.
4. In live mode, freeze recipients and immutable rendered messages.
5. Type the exact campaign name and selected count, then **Confirm & queue**.
6. Pause to stop starting new recipients. **Cancel unsent** terminates only work that has not begun provider dispatch.

The outbound worker may run continuously but is idle with no confirmed durable outbox jobs. Exact Creator Open ID, per-shop single flight, pacing, per-minute/hour/day application safeguards, deterministic jobs, exact positive send evidence, and restart-safe dedupe remain enforced.

`DELIVERY_UNKNOWN` is never automatically resent. Reconciliation may link exactly one matching provider message; unresolved outcomes stay visibly unresolved and block unsafe follow-up. App-originated exact Open-ID cooldown is safe. Historical pre-app IM-only identity coverage remains `HISTORICAL_COOLDOWN_COVERAGE_INCOMPLETE` and is never heuristically linked.

## Discovery and Marketplace throttling

`36009002` and HTTP 429 enter durable `BACKING_OFF`. The campaign shows **TikTok Marketplace temporarily throttled** and the next automatic attempt. The worker waits until `nextAttemptAt`; it does not hot-loop and no manual retry is required. A stopped or stale discovery heartbeat is shown separately.

If discovery appears stuck:

```powershell
.\scripts\status-production.cmd
docker compose --profile production logs --tail 200 discovery-worker
docker compose --profile production up -d discovery-worker
```

Do not manually repeat Marketplace Search to bypass cooldown. Fix the worker/runtime issue and allow the persisted run to resume.

TikTok code `106001` commonly indicates an app credential/signature mismatch. Confirm the dedicated Outreach values inside the repository `.env`, rebuild with `start-production.ps1`, and reauthorize if credentials were rotated. Do not inspect resolved Compose output because it may render secrets; use the sanitized health/status endpoints instead.

## Token lifecycle and authorization

Tokens are encrypted at rest. The API is the only refresh coordinator. It checks periodically and refreshes within the configured safety margin using a durable database lease and compare-and-set token generation; all workers then read the current durable access token. Rotated access and refresh tokens are persisted together.

Ambiguous rotation or a revoked/expired refresh token fails closed, clears unsafe token material where required, and changes status to require reauthorization. No worker independently refreshes and tokens are never returned to the browser or logs. Use **Authorize seller** when status says reauthorization is required. Manual refresh is available only as an intentional recovery action.

When rotating app credentials or the encryption key, stop production first. App key/secret rotation normally requires reauthorization. Do not replace `TIKTOK_TOKEN_ENCRYPTION_KEY` while encrypted tokens exist; reauthorize through a controlled migration/rotation procedure instead.

## Backup and restore

Create a timestamped custom-format backup:

```powershell
.\scripts\backup-database.cmd
```

Backups default to the ignored `backups` directory. Store copies in protected backup storage. To restore, stop application services, keep PostgreSQL running, and restore intentionally into the target database:

```powershell
.\scripts\stop-production.cmd
docker compose --profile production up -d postgres
docker cp .\backups\tiktok-outreach-YYYYMMDD-HHMMSS.dump tiktokoutreach-postgres-1:/tmp/restore.dump
docker compose --profile production exec -T postgres pg_restore -U affiliate -d affiliate_outreach --clean --if-exists --no-owner /tmp/restore.dump
docker exec tiktokoutreach-postgres-1 rm -f /tmp/restore.dump
.\scripts\start-production.cmd
```

Restore is destructive to the target database: verify the exact backup and container before running it. Do not restore automatically.

## Reboot and recovery

All long-running services use `restart: unless-stopped`. After Windows sign-in, Docker Desktop must start; Docker then restarts the previous production containers. Run `status-production.ps1` to confirm. If images or Git changed, run the relevant start command to rebuild and activate the current SHA.

If authorization needs attention after reboot, outbound fails closed. If Redis was unavailable, its append-only volume and the PostgreSQL `QueueOutbox` allow reconciliation without duplicate sends. A delivery found in ambiguous `DISPATCHING` state recovers as UNKNOWN rather than being blindly replayed.

## Service topology

Always-on safe profile: PostgreSQL, Redis, API, web, discovery worker, and read-only history worker. Live profile adds the mutation-only outbound worker. Discovery receives only `SEARCH_CREATORS`; history receives only `LIST_CONVERSATIONS` and `LIST_MESSAGES`; outbound receives only Create/Get Conversation and Send Message capabilities.

PostgreSQL and Redis use persistent named volumes. API and web expose loopback-only ports. Health checks cover PostgreSQL, Redis, API readiness, and web readiness. Worker heartbeats update every 15 seconds, are stale after 45 seconds, and write only one small row per role.
