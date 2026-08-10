# Future TikTok integration boundary

This file is implementation guidance only. Phase one contains no TikTok credentials, HTTP client, production endpoint calls, or production send switch.

## Current official requirements

Before integration, create and obtain approval for a TikTok Shop Partner Center Affiliate app and use a Development Shop. TikTok states that Affiliate API access is inactive by default and requires approval. The required authentication material is:

- Partner Center `app_key` and `app_secret`.
- A configured seller authorization redirect URL and validated OAuth-style `state`.
- Seller authorization code, seller access token, refresh token, token expiry, and granted scopes.
- The authorized Indonesia `shop_cipher` returned by Get Authorized Shops.
- UTC timestamp and HMAC-SHA256 request signature for each API request.

Tokens and secrets must be encrypted at rest in a secret manager, never placed in this repository, and never emitted to logs. See TikTok's [affiliate integration guide](https://partner.tiktokshop.com/docv2/page/affiliate-integration), [authorization overview](https://partner.tiktokshop.com/docv2/page/authorization-overview-202407), and [request signing guide](https://partner.tiktokshop.com/docv2/page/sign-your-api-request).

Minimum currently documented scopes:

- `seller.creator_marketplace.read` for creator marketplace search and performance.
- `seller.affiliate_messages.write` for affiliate conversation listing/history, conversation creation, and sending.

Access must be approved in Partner Center and present in the seller token's granted scopes. Reconfirm names in **App & Service → Manage API** before implementation because TikTok versions and grants can change.

## Endpoints to implement in a future adapter

Base URL: `https://open-api.tiktokglobalshop.com`.

| Adapter operation | Current documented endpoint | Purpose |
| --- | --- | --- |
| `searchCreators` | `POST /affiliate_seller/202508/marketplace_creators/search` | Creator discovery; page size 12 or 20, stable `search_key`, filters for GMV, units sold, categories, content performance, demographics, and country-specific advanced filters. |
| `getCreatorPerformance` | `GET /affiliate_seller/202508/marketplace_creators/{creator_user_id}` | Last-30-day creator profile and performance details. The literal 202508 path parameter name is `creator_user_id`. |
| `listConversations` | `GET /affiliate_seller/202412/conversations` | Historical sync and conversation discovery, paged up to 50. |
| `listMessages` | `GET /affiliate_seller/202412/conversation/{conversation_id}/messages` | Historical outbound/inbound message import and delivery reconciliation, paged up to 20. |
| `createOrGetConversation` | `POST /affiliate_seller/202508/conversations` | Resolve or create a conversation from `creator_open_id`. |
| `sendMessage` | `POST /affiliate_seller/202412/conversations/{conversation_id}/messages` | Send a `TEXT` message whose content is JSON serialized. |

Official references: [creator search](https://partner.tiktokshop.com/docv2/page/seller-search-creator-on-marketplace-202508), [creator performance](https://partner.tiktokshop.com/docv2/page/get-marketplace-creator-performance), [conversation list](https://partner.tiktokshop.com/docv2/page/get-conversation-list-202412), [conversation messages](https://partner.tiktokshop.com/docv2/page/get-message-in-the-conversation-202412), [create conversation](https://partner.tiktokshop.com/docv2/page/create-conversation-with-creator-202508), and [send message](https://partner.tiktokshop.com/docv2/page/send-im-message-202412).

The adapter should also implement the officially listed Get Latest Unread Messages operation for reply status once its active Partner Center API version and path are confirmed for the approved app.

### Creator identifier boundary

Preserve TikTok's field and parameter names exactly; do not normalize these two names into one adapter value:

- `creator_user_id` is the literal path-parameter name documented by the 202508 **Get Marketplace Creator Performance** endpoint: `/affiliate_seller/202508/marketplace_creators/{creator_user_id}`. Pass the value supplied for that field by the matching marketplace API version. Do not substitute a property named `creator_open_id` in the path.
- `creator_open_id` is the literal request-body field documented by the 202508 **Create Conversation with creator** endpoint. It is the privacy-preserving Creator Open ID used by the messaging operation.

TikTok's performance page currently describes its `creator_user_id` value as “Creator Open ID,” while still naming the path parameter `creator_user_id`. The future adapter must mirror the endpoint contract as documented and retain both fields returned by discovery. It must not assume they are interchangeable, derive one from the other, or guess a mapping. Revalidate the active API version and identifier migration guidance immediately before Phase 2 implementation.

## Safe activation sequence

1. Implement a new adapter package with read methods only; keep the mock adapter as the default.
2. Add a separate, server-only secret configuration with explicit development-shop and production-shop identities.
3. Validate signing, token refresh, pagination, error mapping, and quotas against a TikTok Development Shop.
4. Run a complete conversation and outbound-message backfill. Resolve unmatched records and require an operator-approved coverage checkpoint.
5. Add an immutable live-readiness record containing shop, history coverage range, last successful incremental sync, granted scopes, and adapter version.
6. Add a production adapter mode behind two independent server-side gates: deployment authorization and shop-specific outbound enablement. Neither gate may be controllable only from the browser.
7. Start with an allowlisted creator, campaign ceiling of one, and manual review. Increase ceilings only after reconciled audit results.
8. Keep application ceilings lower than TikTok quotas. Treat documented quota and restriction codes as terminal or delayed outcomes according to whether TikTok positively confirms non-acceptance.

Do not automatically retry timeouts, connection resets, or malformed success responses after the request may have reached TikTok. Store the request ID when available, block the creator, and reconcile conversation history after a delay. Reconciliation must never call the send endpoint.
