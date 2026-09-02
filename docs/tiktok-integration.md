# TikTok Shop Phase 2A read-only integration

Verified against the official TikTok Shop Partner Center documentation on 2026-08-10. TikTok versions and app grants can change; recheck the linked API reference before changing an operation contract.

## Marketplace adaptive partition crawler V3 (202508)

The official Seller Search Creator on Marketplace 202508 contract was rechecked on 2026-08-18. Creator Database discovery sends exactly one verified immediate child per base request as `category: [{ parent_category_id, child_category_id_list: [child_id] }]`; follower bounds use inclusive `follower_demographics.count_range.count_ge/count_le`. The open-ended 5M+ bucket omits `count_le`. TikTok permits page sizes 12 or 20, and continuation reuses the response `search_key` with the opaque query `page_token`. The only GMV subdivisions are the four documented `gmv_ranges` enums: `GMV_RANGE_0_100`, `GMV_RANGE_100_1000`, `GMV_RANGE_1000_10000`, and `GMV_RANGE_10000_AND_ABOVE`.

Indonesian category metadata is refreshed explicitly from `GET /product/202309/categories` with `locale=id-ID`, `category_version=v2`, and `listing_platform=TIKTOK_SHOP`. The full fetched tree is cached. V2 selects enabled root parents and each available immediate child; grandchildren, stale nodes, and multi-child requests are rejected locally before TikTok. Refreshing is operator-controlled and rejected while crawling. This one operation uses a separate Customer Support app credential set; Marketplace creator search always remains on the Outreach app credential path.

The historical 5,450 generation-2 rows remain immutable records in parent-catalog, immediate-child, then F01–F25 order. They are no longer claimable when they represent the old unscoped GMV-All strategy; queued or unfinished rows are marked `DISABLED_BY_STRATEGY`, while completed history and all cursors remain preserved. The active generation-3 seed set is deterministic: every enabled immediate child × F01–F25 follower range is created once for each of the four documented GMV buckets. Each new request therefore carries exactly one official `gmv_ranges` value from the first page, and exact logical combinations are reused on restart rather than duplicated. Production children use deterministic `v3:<parent-key>:f<min>-<max>` plus the specific-GMV branch identity and explicit partition types; completed `experiment:split:` rows are preserved but never claimable or reused. A completed result of 380–405 rows is stored as `OBSERVED_SATURATED`, an empirical scheduling signal rather than a documented provider limit; a lower count is not described as complete coverage.

Bounded G1/G2 seeds can receive an inclusive midpoint follower split after at least 200 returned rows when the range can preserve both regional minimum widths and the branch is observed-saturated, at least 20% globally new, or produces at least four new creators per successful page. Deeper G1/G2 recursion requires at least 200 rows, at least 10% incremental yield, at least four new creators per successful page, and either observed saturation or at least 20% unique yield. G3 recurses only on the stronger local override of 200 rows, 20% unique yield, and four new creators per successful page. G4 normally never recurses; its exact exceptional gate is 200 rows, 10% unique yield, and four new creators per successful page. Production follower children start with null search and page cursors and inherit the parent’s exact GMV bucket and range. If both completed children individually have at least 200 rows and under 5% incremental yield, that local branch terminates; otherwise children are evaluated independently so a productive child survives a poor sibling. Minimum child widths remain configurable by follower region: 50, 100, 1,000, 10,000, and 100,000. The open-ended 5,000,000+ seed never receives an invented upper bound.

Claiming is PostgreSQL-backed and deterministic. The persisted claim sequence drives a ten-claim normal cycle: six productive-primary slots, three G1/G2 exploration slots, and one G3 exploration slot. Every 100th persisted claim replaces the G3 exploration slot with one G4 rare probe, so G4 is at most 1% of partition claims while experiment-only work exists and downtime cannot cause a catch-up burst. Normal pools never admit G4. Untouched G1/G2 base-sibling families persist a stable MD5-parity designation derived from category and exact follower bounds; the measured production queue designation is 2,717 G1-first and 2,718 G2-first among 5,435 untouched families. Once either sibling runs, local productivity controls subsequent ordering. G3 receives its lower-priority slot, with strong local branch evidence ordered before general G3 exploration. Category and follower evidence remains filtered within the exact GMV branch. The already-active partition and cursor always resume before the selector runs.

Adaptive score = 1,000 base + soft depth signal (Depth 1 +100, Depth 2 +300, Depth 3 +325, Depth 4+ +100) + branch classification (+500 STRONG, +250 PRODUCTIVE, -100 MARGINAL, -1,200 LOW_VALUE, -1,800 EFFECTIVELY_DEAD) + up to 600 points from incremental/ancestor yield + up to 400 points from new unique creators per successful page + 75 for ancestor/local observed saturation + category weight (-450 to +250) + follower weight (-250 to +200). LOW_VALUE and EFFECTIVELY_DEAD are authoritative LOW overrides. Depth 4+ has no automatic penalty; it becomes HIGH only with productive branch evidence.

Category and follower signals are recomputed from persisted completed production partitions with a 14-day half-life. Neither applies a penalty below 1,000 decayed returned rows. Category evidence is keyed by the verified child category; follower evidence weights historical partitions by overlap with the candidate's actual inclusive bounds. These global signals are soft and cannot resurrect a terminal branch or blacklist a seed. Raw Marketplace/throttle attempts are absent from the scheduler formula; throttles remain reporting metrics only. At claim time the scheduler snapshots class, score, reason, claim sequence, category/follower rows, yields and weights, ancestor yield, and new creators per successful page on the partition.

V1 creators, historical V2 GMV-All seeds, new specific-GMV seeds, experiment rows, partition statuses, receipts, and the legacy `all-creators` row remain historical. Scheduler migrations are additive, never reactivate `EXPERIMENT` rows or unfinished GMV-All work, and preserve the exact active continuation and opaque cursor fields. Queued G4 rows become `EXPERIMENT_ONLY`; no row is deleted or marked error. Per-partition request, throttle, returned-row, new-global-Open-ID, duplicate, yield, saturation, classification, depth, scheduler decision, priority, rare-probe, first-sibling designation, split-parent snapshot, split reason, and recursion-stop reason stay in PostgreSQL and never enter the creator Sheet.

## Safety boundary

`APP_MODE` accepts only `mock` or `read_only`. Production `OUTBOUND_MODE=live` is shared by the API and the always-on `outbound-live` service. The API accepts Send only when the worker heartbeat reports the matching mutation capability; without a healthy worker, the UI shows the exact unavailable reason and no provider mutation is attempted.

The real HTTP client uses this complete allowlist:

| Operation | Method and path | Scope | Pagination / identity |
| --- | --- | --- | --- |
| Get Authorized Shops | `GET /authorization/202309/shops` | Shop Authorized Information grant | Seller token; returns exact shop fields. |
| Get Categories | `GET /product/202309/categories` | `seller.product.basic` | Indonesia/SEA uses the required v2 category tree; refreshed explicitly and cached. |
| Seller Search Creator on Marketplace | `POST /affiliate_seller/202508/marketplace_creators/search` | `seller.creator_marketplace.read` | Page size 12 or 20; opaque `page_token`; reuse response `search_key`. POST is allowlisted only for this read/search operation. |
| Get Marketplace Creator Performance | `GET /affiliate_seller/202508/marketplace_creators/{creator_user_id}` | `seller.creator_marketplace.read` | Prior 30 days. The documentation names the parameter `creator_user_id` while describing the supplied value as Creator Open ID. |
| Get Conversation List | `GET /affiliate_seller/202412/conversations` | `seller.affiliate_messages.write` | Page size up to 50; opaque pagination; returns `creator_im_id`. |
| Get Message in the Conversation | `GET /affiliate_seller/202412/conversation/{conversation_id}/messages` | `seller.affiliate_messages.write` | Page size up to 20; opaque pagination; messages contain `sender_id` and epoch-second `create_time`. |
| Create Conversation (outbound-live only) | `POST /affiliate_seller/202508/conversations` | `seller.affiliate_messages.write` | Exact frozen Creator Open ID; mutation-only adapter. |
| Send IM Message (outbound-live only) | `POST /affiliate_seller/202412/conversations/{conversation_id}/messages` | `seller.affiliate_messages.write` | Exact frozen text; positive message ID required for SENT. |

Official references: [authorization overview](https://partner.tiktokshop.com/docv2/page/authorization-overview-202407), [authorized shops](https://partner.tiktokshop.com/docv2/page/call-get-authorized-shops), [creator search](https://partner.tiktokshop.com/docv2/page/seller-search-creator-on-marketplace-202508), [creator performance](https://partner.tiktokshop.com/docv2/page/get-marketplace-creator-performance), [conversation list](https://partner.tiktokshop.com/docv2/page/get-conversation-list-202412), [conversation messages](https://partner.tiktokshop.com/docv2/page/get-message-in-the-conversation-202412), and [request signing](https://partner.tiktokshop.com/docv2/page/sign-your-api-request).

TikTok currently requires the write-named `seller.affiliate_messages.write` scope for both history GETs and IM mutations. Capability separation is enforced locally: history receives only the GET operations, while only the separately gated outbound worker receives Create Conversation and Send IM Message. Mark Conversation Read, targeted/open collaborations, invitations, and sample actions remain absent from every allowlist; deny tests prove they fail before `fetch`. Get Latest Unread Messages is not called because its exact active version/path could not be verified.

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

Follower bounds, arbitrary GMV bounds, average video views, average live viewers, engagement, category, and keyword campaign filters are applied to shop-scoped Creator Database snapshots in PostgreSQL. Changing Outreach filters performs zero Marketplace API calls. Unknown metrics remain `null`; they are never fabricated as zero. GMV is stored with the currency returned for that value. Filtering or ranking requires an explicit matching currency, cross-currency values are not compared, and no FX conversion or shop-region currency inference is performed. The separate continuation sync has no total creator cap.

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
TIKTOK_CATEGORY_APP_KEY=<Customer Support app key>
TIKTOK_CATEGORY_APP_SECRET=<Customer Support app secret>
TIKTOK_CATEGORY_ACCESS_TOKEN=<seller access token issued to that app>
TIKTOK_CATEGORY_SHOP_CIPHER=<same Indonesian seller's shop cipher issued to that app>
TIKTOK_REDIRECT_URI=http://127.0.0.1:4000/api/v1/integrations/tiktok/callback
```

Configure the exact redirect URI and scopes in Partner Center, authorize the seller, inspect authorized shops, and explicitly select the Indonesian shop. Without credentials, read-only mode starts as `READ_ONLY_NOT_CONFIGURED`.

The original four values must belong to the dedicated Outreach app: `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET`, `TIKTOK_SERVICE_ID`, and `TIKTOK_TOKEN_ENCRYPTION_KEY`. The four `TIKTOK_CATEGORY_*` values are backend-only and belong to the separately authorized Customer Support app; they can invoke only the category refresh adapter. There is deliberately no fallback to Outreach credentials. The category access token is not stored in PostgreSQL and must be rotated in the environment when TikTok expires it. The encryption key protects Outreach token storage and should be newly generated and retained securely; it is not a TikTok-issued credential.

Controlled real validation may progress only through separately requested read actions with these ceilings:

| Controlled action | API entry point | Physical TikTok request ceiling |
| --- | --- | --- |
| Marketplace continuation | Diagnostic probe only | One explicitly requested continuation page using a supplied persisted cursor; Outreach campaign endpoints make zero Marketplace requests. |
| Creator performance | `GET /api/v1/integrations/tiktok/creators/:creatorOpenId/performance?validationMode=true` | One Creator Performance read. |
| Conversation list | `POST /api/v1/contact-history/sync-runs?validationMode=true` or `POST /api/v1/contact-history/validation/conversations` | One Conversation List page; no conversations or messages are iterated. |
| Selected conversation messages | `POST /api/v1/contact-history/validation/conversations/:conversationId/messages` | One Message List page for the explicitly selected conversation. |

The conversation and message steps are intentionally separate. Validation history is not a resumable backfill, does not call the unread-message workflow, and reports whether the provider has more pages. Normal non-validation history sync retains its resumable multi-page behavior.

Before any validation read, the service checks the selected connection and access-token expiry only from local storage. The connection must be healthy and idle, and its decryptable access token must remain valid beyond the configured automatic refresh margin. Missing, expired, unhealthy, unreadable, or near-expiry tokens fail locally with a controlled-validation preparation error. That failure performs no token refresh, Authorized Shops validation, or requested provider read; the operator must reauthorize or explicitly prepare the connection outside the validation action.

Real TikTok outbound is physically isolated in the always-on `outbound-live` worker. Its mutation-only adapter can call only Create Conversation and Send IM Message. Production Compose sets API and worker `OUTBOUND_MODE=live` from the same authoritative profile; no recurring acknowledgement is required. PostgreSQL grants at most one Send Message permit per App × Shop every 1,000ms, surviving concurrent jobs and worker restarts. Create Conversation retains adaptive provider permits, and TikTok Retry-After/quota feedback can extend delays without catch-up bursts. See TikTok's current [rate-limit guidance](https://partner.tiktokshop.com/docv2/page/rate-limits), [Create Conversation](https://partner.tiktokshop.com/docv2/page/create-conversation-with-creator-202508), and [Send IM Message](https://partner.tiktokshop.com/docv2/page/send-im-message-202412) references.
