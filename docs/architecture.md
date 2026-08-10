# Architecture and safety

## Component boundaries

```mermaid
flowchart LR
  UI[Next.js operator UI] --> API[NestJS application API]
  API --> Domain[Pure outreach domain]
  API --> DB[(PostgreSQL)]
  API --> Queue[(Redis / BullMQ)]
  Worker[BullMQ worker] --> Queue
  Worker --> DB
  API --> Adapter[TikTok adapter contract]
  Worker --> Adapter
  Adapter --> Mock[Deterministic mock provider]
```

The domain package owns filtering, ranking, cooldown decisions, deduplication, template rendering, safety assertions, and reconciliation matching. The API owns operator workflows and persistence. The worker owns dispatch state transitions. Provider details are behind `TikTokAffiliateAdapter`; phase one registers only `MockTikTokAffiliateAdapter`. This keeps future modules from accumulating in either the UI or a single service class.

## Campaign lifecycle

1. Create a draft with target, filters, cooldown, ranking, product, and message template.
2. Page through creator discovery using a stable search key and page token.
3. Apply local filters and canonicalize by `creator_open_id`.
4. Exclude do-not-contact, unresolved delivery, active reservation, and cooldown contacts, including historical imports.
5. Rank eligible creators and select `min(requested, eligible)` without changing filters.
6. Persist the preview and exclusion counts.
7. Freeze the selection, render and store the exact message per recipient, hash it, and reserve each creator.
8. Require the current campaign version, exact campaign name, and exact selected count before enqueueing.
9. Dispatch through BullMQ. PostgreSQL records a dispatch slot before every provider attempt.

Frozen previews expire after 30 minutes. A unique `(campaign_id, creator_id)` recipient and unique `(shop_id, creator_id)` active reservation prevent duplicate selection. A deterministic delivery key and BullMQ job ID make restarts idempotent.

## Persistent data

The Prisma schema separates shops and integration modes, creator identity, metric snapshots, shop-specific contact state, conversations and messages, history sync/import runs, campaigns and frozen recipients, reservations, deliveries and attempts, reconciliation evidence, dispatch events, daily usage, and audit events.

PostgreSQL stores the exact frozen outbound message and content hash. Runtime logs include only operational IDs, provider-safe error codes, and error summaries; they do not log message bodies, access tokens, app secrets, or request signatures.

## Safety invariants

- `APP_MODE` validates to `mock` only. A production adapter and production credential fields do not exist.
- A dispatch is counted before the mock provider is called.
- Campaign, Indonesia shop-day, and rolling-minute ceilings are enforced under a PostgreSQL advisory lock and serializable transaction.
- BullMQ also has a global worker limiter and may operate more slowly than the hard ceiling.
- Explicit non-acceptance outcomes may retry with exponential backoff. Each retry consumes a new dispatch event and safety budget.
- A timeout or crash after dispatch becomes `DELIVERY_UNKNOWN` and is never sent again.
- Reconciliation is read-only. One unique outbound message with the same conversation, content hash, and timing window marks the delivery sent. No match or multiple matches remain blocked after the final check.
- Contact cooldown is updated only after a confirmed send or positively reconciled send.
- Pause is cooperative: active database transitions finish, queued jobs delay, and resume re-enqueues only safe states.

## Historical-contact gate

The readiness endpoint reports whether a complete, recent conversation sync exists and records imported CSV sources. Mock sending is available for phase-one testing, but the future live-mode gate must require successful historical coverage before its adapter can be enabled. The import upserts contact state so outreach predating this application participates in cooldown and duplicate prevention.

## Extension points

Add future modules as new API modules, UI route groups, domain services, and queue names. Creator identity, shop contact state, conversations, and audit events are shared foundations; leads, clip delivery, attribution, and workflow monitoring should not be added to the outreach worker.
