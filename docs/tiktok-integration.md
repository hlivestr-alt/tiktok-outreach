# TikTok Shop Phase 2A read-only integration

Verified against the official TikTok Shop Partner Center documentation on 2026-08-10. TikTok versions and app grants can change; recheck the linked API reference before changing an operation contract.

## Safety boundary

`APP_MODE` accepts only `mock` or `read_only`. There is no production/live-send mode. In `read_only`, real campaign processing ends at `PREVIEW_READY` (`READ_ONLY_PREVIEW` in the UI); freeze, queue creation, worker dispatch, and provider mutations are rejected.

The real HTTP client uses this complete allowlist:

| Operation | Method and path | Version | Scope | Pagination / identity |
| --- | --- | --- | --- | --- |
| Get Authorized Shops | `GET /authorization/202309/shops` | `202309` | Shop Authorized Information (Partner Center grant; exact token scope is returned in `granted_scopes`) | Seller access token; returns `shops[].id`, `cipher`, `code`, `name`, `region`, `seller_type`. |
| Seller Search Creator on Marketplace | `POST /affiliate_seller/202508/marketplace_creators/search` | `202508` | `seller.creator_marketplace.read` | `page_size` is 12 or 20; opaque `page_token`; response `search_key` must be reused on later pages. POST is allowlisted only for this read/search operation. |
| Get Marketplace Creator Performance | `GET /affiliate_seller/202508/marketplace_creators/{creator_user_id}` | `202508` | `seller.creator_marketplace.read` | Last 30 days. The current page names the path parameter `creator_user_id` but describes its value as Creator Open ID. |
| Get Conversation List | `GET /affiliate_seller/202412/conversations` | `202412` | `seller.affiliate_messages.write` | `page_size` max 50, opaque `page_token`, `has_more`, `next_page_token`; returns `creator_im_id`. |
| Get Message in the Conversation | `GET /affiliate_seller/202412/conversation/{conversation_id}/messages` | `202412` | `seller.affiliate_messages.write` | `page_size` max 20, opaque `page_token`, `has_more`, `next_page_token`; messages contain `sender_id` and epoch-second `create_time`. |

Official references: [authorization overview](https://partner.tiktokshop.com/docv2/page/authorization-overview-202407), [authorized shops](https://partner.tiktokshop.com/docv2/page/call-get-authorized-shops), [creator search](https://partner.tiktokshop.com/docv2/page/seller-search-creator-on-marketplace-202508), [creator performance](https://partner.tiktokshop.com/docv2/page/get-marketplace-creator-performance), [conversation list](https://partner.tiktokshop.com/docv2/page/get-conversation-list-202412), [conversation messages](https://partner.tiktokshop.com/docv2/page/get-message-in-the-conversation-202412), and [request signing](https://partner.tiktokshop.com/docv2/page/sign-your-api-request).

### Scope with write semantics

TikTok currently requires `seller.affiliate_messages.write` even for the two history GET operations. At the TikTok account level this scope can also make Create Conversation, Send IM Message, Mark Conversation Read, and related message mutations permission-capable. The application does not treat the scope name as authorization to send: the method/path allowlist above is checked before `fetch`. Tests invoke the documented mutation paths and assert zero HTTP calls.

Known mutation references retained only for deny tests and documentation:

- `POST /affiliate_seller/202508/conversations` — Create Conversation with creator.
- `POST /affiliate_seller/202412/conversations/{conversation_id}/messages` — Send IM Message.
- Mark-read, targeted collaboration, open collaboration, invitation, and sample actions are not allowlisted.

Get Latest Unread Messages is listed in the Affiliate Seller API index, but its exact active version/path could not be verified in the current public reference. Phase 2A therefore does not call it. Conversation list plus message history provide reply/unread synchronization without guessing an endpoint.

## Search filters and returned metrics

Confirmed server-side request fields are `keyword`, `category`, `gmv_ranges`, `units_sold_ranges`, `follower_demographics`, `content_performance`, `affiliate_data`, and country-dependent `advanced_filters`. This implementation sends only the documented shapes it can map without guessing: keyword, category IDs, and TikTok's discrete GMV/units-sold range enumerations.

Follower minimum/maximum, arbitrary GMV boundaries, average video views, average live viewers, engagement, and other numeric campaign filters are applied locally to returned data. The UI/capabilities distinguish `:server` and `:local`. Unknown or missing metrics remain `null`; they are not fabricated as zero. TikTok marketplace metrics cover the prior 30 days. Search pages are capped by the campaign candidate-pool limit and expose a truncated warning when more provider pages remain.

## Identifier mapping

- `creator_open_id`: stable privacy-preserving Creator Open ID used by the current marketplace performance endpoint value and by Create Conversation (the latter is forbidden here).
- `creator_user_id`: persisted separately when marketplace data returns it. It is never silently substituted for another identity.
- `creator_im_id`: messaging identity returned by Conversation List and used to classify message direction by `sender_id`. It is stored separately and is rejected by the performance adapter.
- `conversation_id`: only identifies an affiliate conversation.

History may contain a creator known only by `creator_im_id`. Such a record gets a local `creatorOpenId` namespace of `im:<creator_im_id>` until a documented mapping is available. Runtime guards prevent that local/messaging identity from entering creator-performance calls.

## Signing, authorization, and token lifecycle

TikTok Shop requests use HMAC-SHA256. Query keys excluding `sign` and `access_token` are sorted, concatenated as `{key}{value}`, prefixed by the exact request path, followed by the exact JSON body for non-multipart requests, wrapped with the app secret, and HMAC-signed with that secret. UTC epoch seconds are generated for each attempt. Signing is centralized and covered by TikTok's published fixed fixture.

Seller authorization uses the ROW link `https://services.tiktokshop.com/open/authorize?service_id=...&state=...`. State is 32 random bytes, stored only as SHA-256, expires after ten minutes, and is consumed atomically once. The callback rejects missing, mismatched, expired, reused, denied, or malformed callbacks. The authorization code is exchanged server-side at `GET https://auth.tiktok-shops.com/api/v2/token/get`; refresh uses `/api/v2/token/refresh`. The official authorization code expires after 30 minutes and is single-use.

Access and refresh tokens are encrypted independently with AES-256-GCM. The 32-byte master key comes only from `TIKTOK_TOKEN_ENCRYPTION_KEY`; PostgreSQL stores versioned IV/tag/ciphertext envelopes. Refresh occurs before access-token expiry using a configurable margin and a PostgreSQL advisory lock. A failed refresh rolls back token rotation, records a redacted failure, marks reauthorization required, and never falls back indefinitely to stale tokens.

Normal API responses expose token expiry, granted scopes, health, shop identity, refresh counts, request IDs, and errors—but never access token, refresh token, app secret, authorization code, encryption key, ciphertext, or shop cipher.

## History synchronization

Conversation pages and every message page are processed idempotently. The sync persists the conversation page token, conversation index, and message page token after each unit of work. A crash resumes the same run. Provider message IDs deduplicate imports; creator eligibility locks protect contact-state rebuilds. Both inbound and outbound messages are stored, while only confirmed outbound history increments contact/cooldown state. Readiness becomes complete only after all advertised conversation and message pagination is exhausted successfully; partial and failed runs remain blocked.

The current conversation/message references do not document a time-range filter or message ordering guarantee. The implementation therefore does not invent a newest-first early-stop rule. Later syncs are idempotent but may revisit provider pages. A truly bounded incremental optimization remains dependent on TikTok documenting an ordering/cursor contract; completeness is favored over an unsafe assumption.

## Local configuration and validation

Set secrets only in the server environment, never in Git or browser configuration:

```text
APP_MODE=read_only
TIKTOK_APP_KEY=...
TIKTOK_APP_SECRET=...
TIKTOK_SERVICE_ID=...
TIKTOK_TOKEN_ENCRYPTION_KEY=<base64 or 64-hex characters encoding 32 random bytes>
TIKTOK_REDIRECT_URI=http://127.0.0.1:4000/api/v1/integrations/tiktok/callback
```

Configure the exact redirect URI and required scopes in Partner Center. Start the application, open Integration & safety, authorize the seller, inspect the authorized shops, and explicitly select the Indonesian shop. If configuration is absent, read-only mode starts as `READ_ONLY_NOT_CONFIGURED`.

Real-world validation, when credentials are locally available, must progress through authorized-shop GET, a tiny creator search, one performance GET, one conversation page, one message page, resumable backfill, sample comparison, and campaign preview. Do not call a mutation endpoint.
