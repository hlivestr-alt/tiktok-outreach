# TikTok Shop Phase 2A read-only integration

Verified against the official TikTok Shop Partner Center documentation on 2026-08-10. TikTok versions and app grants can change; recheck the linked API reference before changing an operation contract.

## Safety boundary

`APP_MODE` accepts only `mock` or `read_only`. There is no production/live-send mode. In `read_only`, real campaign processing ends at `PREVIEW_READY` (`READ_ONLY_PREVIEW` in the UI); freeze, queue creation, worker dispatch, and provider mutations are rejected.

The real HTTP client uses this complete allowlist:

| Operation | Method and path | Scope | Pagination / identity |
| --- | --- | --- | --- |
| Get Authorized Shops | `GET /authorization/202309/shops` | Shop Authorized Information grant | Seller token; returns exact shop fields. |
| Seller Search Creator on Marketplace | `POST /affiliate_seller/202508/marketplace_creators/search` | `seller.creator_marketplace.read` | Page size 12 or 20; opaque `page_token`; reuse response `search_key`. POST is allowlisted only for this read/search operation. |
| Get Marketplace Creator Performance | `GET /affiliate_seller/202508/marketplace_creators/{creator_user_id}` | `seller.creator_marketplace.read` | Prior 30 days. The documentation names the parameter `creator_user_id` while describing the supplied value as Creator Open ID. |
| Get Conversation List | `GET /affiliate_seller/202412/conversations` | `seller.affiliate_messages.write` | Page size up to 50; opaque pagination; returns `creator_im_id`. |
| Get Message in the Conversation | `GET /affiliate_seller/202412/conversation/{conversation_id}/messages` | `seller.affiliate_messages.write` | Page size up to 20; opaque pagination; messages contain `sender_id` and epoch-second `create_time`. |

Official references: [authorization overview](https://partner.tiktokshop.com/docv2/page/authorization-overview-202407), [authorized shops](https://partner.tiktokshop.com/docv2/page/call-get-authorized-shops), [creator search](https://partner.tiktokshop.com/docv2/page/seller-search-creator-on-marketplace-202508), [creator performance](https://partner.tiktokshop.com/docv2/page/get-marketplace-creator-performance), [conversation list](https://partner.tiktokshop.com/docv2/page/get-conversation-list-202412), [conversation messages](https://partner.tiktokshop.com/docv2/page/get-message-in-the-conversation-202412), and [request signing](https://partner.tiktokshop.com/docv2/page/sign-your-api-request).

TikTok currently requires the write-named `seller.affiliate_messages.write` scope for the two history GET operations. The scope does not authorize this application to send. Create Conversation, Send IM Message, Mark Conversation Read, targeted/open collaborations, invitations, and sample actions are absent from the allowlist; deny tests prove they fail before `fetch`. Get Latest Unread Messages is not called because its exact active version/path could not be verified.

## Real validation findings and dedicated application

Controlled production validation confirmed that seller authorization and Get Authorized Shops succeeded and returned the intended Indonesian shop. The `seller.creator_marketplace.read` scope was present, and Marketplace request construction and signing passed validation. Marketplace Search then returned repeated `429 / 36009002` responses. Investigation found that TikTok Outreach and the separately operated TikTok Orders/n8n stack were using the same TikTok App Key, while the Orders stack was actively issuing API requests. The observed rate-limit isolation was App × Authorized Shop.

The production recommendation is therefore **one dedicated TikTok developer app for TikTok Outreach**, separate from TikTok Orders. A human operator must create and approve it in Partner Center, then authorize the same Indonesian shop to that dedicated app. Do not copy credentials from Orders, and do not create or invent credentials in application code.

The `429` is not treated as evidence that endpoint, signing, or authorization semantics should change. TikTok quotas are dynamic; this application does not claim or hardcode a TikTok QPS limit.

## Durable read governor

Every real TikTok read passes through a PostgreSQL-backed governor keyed by provider, a safe local shop scope, and operation. Marketplace Search, Creator Performance, Conversation List, and Conversation Messages have distinct per-shop buckets; Authorized Shops uses a separate non-secret authorization bucket. Unrelated shops and operations do not block each other.

Each row stores only request/success/throttle times, consecutive throttle count, next permitted time, optional sanitized Retry-After milliseconds, most recent provider request ID, pacing time, and a short-lived single-flight lease. It never stores tokens, App Secret, App Key, shop cipher, headers, or raw responses.

Reads are smoothly spaced and a database compare-and-set lease prevents simultaneous approved reads for the same shop across processes, while cooldown history remains separate by operation. An HTTP `429` or provider code `36009002` immediately stops the request and pagination path, persists exponential backoff with jitter and a cap, and performs no immediate retry. HTTP status `429` is sufficient to activate throttling even when TikTok or an intermediary returns empty, truncated, malformed, or non-JSON content. A safe request ID and valid `Retry-After` header are retained when present; unreadable response bodies are never persisted or returned. A valid `Retry-After` can lengthen the cooldown. Successful calls clear the consecutive throttle count and provider cooldown. The API returns a redacted `TIKTOK_READ_THROTTLED` result with the next safe attempt time; locally blocked attempts perform zero provider HTTP calls.

Normal reads retain bounded retries for temporary/network failures only. Controlled validation mode applies the stronger invariant **one requested provider read = at most one physical TikTok API request**. It disables HTTP retries, pagination beyond the validation page, automatic token refresh, refresh-time Authorized Shops revalidation, and hidden secondary provider calls. The validation HTTP client also enforces a one-request action budget as a final backstop. Provider throttles are never retried immediately in either mode.

## Search filters and GMV

The provider documents fields including `keyword`, `category`, `gmv_ranges`, `units_sold_ranges`, `follower_demographics`, `content_performance`, `affiliate_data`, and country-dependent `advanced_filters`. This implementation sends only shapes it can map without guessing: keyword, category IDs, and exact documented discrete units-sold ranges.

Follower bounds, arbitrary GMV bounds, average video views, average live viewers, engagement, and other numeric campaign filters are applied locally. The capabilities response labels server and local filters. Unknown metrics remain `null`; they are never fabricated as zero. GMV is stored with the currency returned for that value. Filtering or ranking requires an explicit matching currency, cross-currency values are not compared, and no FX conversion or shop-region currency inference is performed. Search is capped by the campaign candidate-pool limit and reports truncation when provider pages remain.

## Provider identity namespaces

- `creatorOpenId`, `creatorUserId`, and `creatorImId` are separate namespaces and are never silently substituted.
- `creatorImId` identifies the messaging participant and is rejected by creator-performance reads.
- `conversationId` identifies only an affiliate conversation.
- IM-only history has a nullable Open ID and an unresolved provider identity. No synthetic `im:<creator_im_id>` Open ID is created.
- Username, nickname, or other fuzzy similarity never merges identities.
- Legacy or CSV-provided Open IDs do not count as verified Marketplace evidence.
- Exact Marketplace observation, a conversation response containing both exact identifiers, or a documented provider-exact mapping is required to verify or merge identities.

When Marketplace later returns the exact legacy Open ID, `ensureMarketplaceCreator()` upgrades the identity to `VERIFIED` with `MARKETPLACE_EXACT_FIELD` evidence. Exact identity merging takes the shared creator-eligibility locks in deterministic shop/creator order before contact-state rebuilding and reservation/campaign reassignment.

## Signing, authorization, and token lifecycle

TikTok Shop requests use HMAC-SHA256 over the documented canonical path, sorted query, and exact JSON body. Seller authorization uses a 32-random-byte state stored only as SHA-256, expiring after ten minutes and consumed atomically once. The callback rejects missing, mismatched, expired, reused, denied, or malformed callbacks. Authorization-code exchange and refresh occur server-side.

Access and refresh tokens are encrypted independently with AES-256-GCM. The 32-byte master key comes only from `TIKTOK_TOKEN_ENCRYPTION_KEY`; PostgreSQL stores versioned IV/tag/ciphertext envelopes. Refresh uses a persisted lease plus token-generation compare-and-set, so concurrent or stale processes cannot overwrite newer authorization data.

A valid provider response that explicitly rejects refresh transitions to `FAILED`, preserves the previous token pair, records a redacted error, and blocks automatic retry. A network loss, timeout, unreadable or malformed response, expired lease, or successful rotation that cannot be persisted transitions to `OUTCOME_UNCERTAIN`; local access and refresh tokens and expiries are cleared, retry with the old refresh token is blocked, and seller reauthorization is required.

Normal API responses expose health metadata but never access tokens, refresh tokens, app secrets, authorization codes, encryption keys, ciphertext, or shop cipher. TikTok credentials are supplied only to the API container; worker and web containers do not receive them.

## History synchronization and readiness

Conversation and message pages are processed idempotently. The sync persists the conversation page token, conversation index, and message page token after each unit of work, so a crash resumes the same run. Provider message IDs deduplicate imports. Both inbound and outbound messages are stored; only confirmed outbound history increments contact/cooldown state.

Pagination completeness and identity completeness are separate. Discovery analysis requires a complete, recent pagination run. Future outbound readiness additionally requires trusted exact Marketplace identity coverage, with no unresolved historical contacts or current import conflicts. Partial and failed pagination stays blocked. The provider does not document a safe time-range or ordering contract, so later syncs may revisit pages rather than assume an unsafe newest-first cutoff.

## Local configuration and controlled validation

Set secrets only in the API/server environment, never in Git, browser configuration, worker, or web:

```text
APP_MODE=read_only
TIKTOK_APP_KEY=...
TIKTOK_APP_SECRET=...
TIKTOK_SERVICE_ID=...
TIKTOK_TOKEN_ENCRYPTION_KEY=<base64 or 64-hex characters encoding 32 random bytes>
TIKTOK_REDIRECT_URI=http://127.0.0.1:4000/api/v1/integrations/tiktok/callback
```

Configure the exact redirect URI and scopes in Partner Center, authorize the seller, inspect authorized shops, and explicitly select the Indonesian shop. Without credentials, read-only mode starts as `READ_ONLY_NOT_CONFIGURED`.

These four values must belong to the dedicated Outreach app: `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET`, `TIKTOK_SERVICE_ID`, and `TIKTOK_TOKEN_ENCRYPTION_KEY`. The encryption key protects Outreach token storage and should be newly generated and retained securely; it is not a TikTok-issued credential. The existing TikTok Orders application, its credentials, schedules, n8n workflows, and rate-limit behavior are out of scope and must remain unchanged.

Controlled real validation may progress only through separately requested read actions with these ceilings:

| Controlled action | API entry point | Physical TikTok request ceiling |
| --- | --- | --- |
| Marketplace discovery | `POST /api/v1/outreach/campaigns/:id/discovery-runs?validationMode=true` | One Marketplace Search page; page 2 is never fetched and the preview is always marked validation-truncated/incomplete. |
| Creator performance | `GET /api/v1/integrations/tiktok/creators/:creatorOpenId/performance?validationMode=true` | One Creator Performance read. |
| Conversation list | `POST /api/v1/contact-history/sync-runs?validationMode=true` or `POST /api/v1/contact-history/validation/conversations` | One Conversation List page; no conversations or messages are iterated. |
| Selected conversation messages | `POST /api/v1/contact-history/validation/conversations/:conversationId/messages` | One Message List page for the explicitly selected conversation. |

The conversation and message steps are intentionally separate. Validation history is not a resumable backfill, does not call the unread-message workflow, and reports whether the provider has more pages. Normal non-validation history sync retains its resumable multi-page behavior.

Before any validation read, the service checks the selected connection and access-token expiry only from local storage. The connection must be healthy and idle, and its decryptable access token must remain valid beyond the configured automatic refresh margin. Missing, expired, unhealthy, unreadable, or near-expiry tokens fail locally with a controlled-validation preparation error. That failure performs no token refresh, Authorized Shops validation, or requested provider read; the operator must reauthorize or explicitly prepare the connection outside the validation action.

Real TikTok outbound remains physically unavailable: campaigns cannot freeze or queue, the worker cannot dispatch them, and no mutation endpoint may be called.
