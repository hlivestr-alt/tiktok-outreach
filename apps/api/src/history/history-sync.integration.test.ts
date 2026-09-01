import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@affiliate/db";
import type { ProviderConversation, ProviderMessage } from "@affiliate/contracts";
import { TikTokApiError } from "@affiliate/tiktok-adapter";
import { CreatorIdentityResolver } from "../identity/creator-identity-resolver.service";
import { HistoryService } from "./history.service";
import { HistoryProcessor, publicHistoryJob } from "./history-processor";

const prisma = new PrismaClient();
const shopIds = new Set<string>();
let now = new Date("2026-08-13T00:00:00.000Z");
const stamp = () => `history_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const conversation = (id: string): ProviderConversation => ({ id, creatorImId: `im-${id}`, username: `user-${id}` });
const message = (id: string, conversationId: string, direction: "OUTBOUND" | "INBOUND", createdAt: string): ProviderMessage => ({
  id, conversationId, creatorImId: `im-${conversationId}`, direction, content: id, createdAt: new Date(createdAt)
});

async function fixture() {
  const shop = await prisma.shop.create({ data: { name: stamp(), connectionMode: "MOCK" } }); shopIds.add(shop.id);
  const tiktok = {
    activeShop: async () => shop,
    historyAdapter: vi.fn(),
    outboundCapability: async () => ({ mode: "MOCK", mutationCapability: true, available: true, workerState: "NOT_REQUIRED", reason: null })
  };
  const identities = new CreatorIdentityResolver(prisma as any);
  const service = new HistoryService(prisma as any, tiktok as any, identities);
  const processor = new HistoryProcessor(prisma as any, tiktok as any, identities, { now: () => now, random: () => 0, leaseMs: 1000 });
  return { shop, tiktok, identities, service, processor };
}

async function due() { now = new Date(now.getTime() + 2000); }
async function drain(processor: HistoryProcessor, adapter: any, limit = 50) {
  for (let i = 0; i < limit; i++) {
    const worked = await processor.processNext(adapter);
    if (!worked) return;
    await due();
    const job = await prisma.historySyncJob.findFirst({ orderBy: { updatedAt: "desc" } });
    if (job?.state === "COMPLETE" && job.initialCompletedAt) return;
  }
  throw new Error("drain limit reached");
}

beforeEach(async () => {
  for (const id of shopIds) await prisma.shop.delete({ where: { id } }).catch(() => undefined);
  shopIds.clear();
  now = new Date("2026-08-13T00:00:00.000Z");
});
afterAll(async () => { for (const id of shopIds) await prisma.shop.delete({ where: { id } }).catch(() => undefined); await prisma.$disconnect(); });

describe.sequential("persistent historical synchronization", () => {
  it("enqueues exactly one local job and polling/control makes zero provider calls", async () => {
    const seed = await fixture();
    const first = await seed.service.startHistorySync(); const second = await seed.service.startHistorySync();
    await seed.service.historyStatus(); await seed.service.readiness();
    expect(first.state).toBe("QUEUED"); expect(second).toEqual(first);
    expect(await prisma.historySyncJob.count({ where: { shopId: seed.shop.id } })).toBe(1);
    expect(seed.tiktok.historyAdapter).not.toHaveBeenCalled();
  });

  it("resumes an expired lease with the exact private cursor and redacts it publicly", async () => {
    const seed = await fixture(); await seed.service.startHistorySync();
    await prisma.historySyncJob.update({ where: { shopId: seed.shop.id }, data: {
      state: "RUNNING", privateBackfillPageToken: "opaque-secret-cursor", leaseOwner: "dead", leaseExpiresAt: new Date(now.getTime() - 1)
    } });
    const adapter = { listConversations: vi.fn(async (cursor) => {
      expect(cursor.pageToken).toBe("opaque-secret-cursor"); return { items: [], hasMore: false };
    }), listMessages: vi.fn() };
    await seed.processor.processNext(adapter);
    const raw = await prisma.historySyncJob.findUniqueOrThrow({ where: { shopId: seed.shop.id } });
    expect(raw.privateBackfillPageToken).toBe("opaque-secret-cursor");
    expect(JSON.stringify(publicHistoryJob(raw))).not.toContain("opaque-secret-cursor");
    expect(JSON.stringify(await seed.service.readiness())).not.toContain("opaque-secret-cursor");
  });

  it("fully paginates, replays exact IDs idempotently, reconstructs outbound and reply state, then starts incremental mode", async () => {
    const seed = await fixture(); await seed.service.startHistorySync();
    let listCalls = 0; let messageCalls = 0;
    const adapter = {
      listConversations: vi.fn(async ({ pageToken }: any) => {
        listCalls++;
        if (!pageToken) return { items: [conversation("c1")], nextPageToken: "page-2", hasMore: true };
        expect(pageToken).toBe("page-2"); return { items: [conversation("c1"), conversation("c2")], hasMore: false };
      }),
      listMessages: vi.fn(async (conversationId: string, cursor: any) => {
        messageCalls++;
        if (conversationId === "c1" && !cursor.pageToken) return { items: [message("m1", "c1", "OUTBOUND", "2026-01-02T00:00:00Z")], nextPageToken: "m-next", hasMore: true };
        if (conversationId === "c1") return { items: [message("m1", "c1", "OUTBOUND", "2026-01-02T00:00:00Z"), message("m2", "c1", "INBOUND", "2026-01-03T00:00:00Z")], hasMore: false };
        return { items: [message("m3", "c2", "OUTBOUND", "2025-12-01T00:00:00Z")], hasMore: false };
      })
    };
    await drain(seed.processor, adapter);
    const job = await prisma.historySyncJob.findUniqueOrThrow({ where: { shopId: seed.shop.id } });
    expect(job).toMatchObject({ state: "COMPLETE", mode: "INCREMENTAL", pagesProcessed: 2, conversationsImported: 2, messagesImported: 3 });
    expect(listCalls).toBe(2); expect(messageCalls).toBe(5);
    expect(await prisma.conversation.count({ where: { shopId: seed.shop.id } })).toBe(2);
    expect(await prisma.conversationMessage.count({ where: { conversation: { shopId: seed.shop.id } } })).toBe(3);
    const c1 = await prisma.creator.findUniqueOrThrow({ where: { creatorImId: "im-c1" }, include: { contacts: { where: { shopId: seed.shop.id } } } });
    expect(c1.contacts[0]).toMatchObject({ contactCount: 1, latestReplyStatus: "REPLIED", firstContactedAt: new Date("2026-01-02T00:00:00Z"), lastContactedAt: new Date("2026-01-02T00:00:00Z") });
    expect(c1.creatorOpenId).toBeNull();
    const readiness = await seed.service.readiness();
    expect(readiness).toMatchObject({ historyPaginationComplete: true, identityReconciliationComplete: false, futureOutboundSafe: false });
  });

  it("adopts existing history without duplicate rows or contact-count inflation", async () => {
    const seed = await fixture();
    const creator = await seed.identities.ensureConversationCreator(conversation("existing"));
    const dbConversation = await prisma.conversation.create({ data: { shopId: seed.shop.id, creatorId: creator.id, externalConversationId: "existing" } });
    await prisma.conversationMessage.create({ data: { conversationId: dbConversation.id, externalMessageId: "existing-message", direction: "OUTBOUND", content: "x", contentHash: "x", providerCreatedAt: new Date("2026-01-01T00:00:00Z"), importSource: "OLD" } });
    await seed.service.startHistorySync();
    const adapter = { listConversations: async () => ({ items: [conversation("existing")], hasMore: false }), listMessages: async () => ({ items: [message("existing-message", "existing", "OUTBOUND", "2026-01-01T00:00:00Z")], hasMore: false }) };
    await drain(seed.processor, adapter);
    const contact = await prisma.creatorShopContactState.findUniqueOrThrow({ where: { shopId_creatorId: { shopId: seed.shop.id, creatorId: creator.id } } });
    expect(await prisma.conversation.count({ where: { shopId: seed.shop.id } })).toBe(1);
    expect(await prisma.conversationMessage.count({ where: { conversationId: dbConversation.id } })).toBe(1);
    expect(contact.contactCount).toBe(1);
    expect((await prisma.historySyncJob.findUniqueOrThrow({ where: { shopId: seed.shop.id } })).conversationsImported).toBe(0);
  });

  it("keeps the backfill cursor while reconciling a drifting head page", async () => {
    const seed = await fixture(); await seed.service.startHistorySync();
    await prisma.historySyncJob.update({ where: { shopId: seed.shop.id }, data: {
      state: "QUEUED", passKind: "HEAD", phase: "LIST", privateBackfillPageToken: "deep-frontier", backfillPagesSinceHead: 5
    } });
    const adapter = { listConversations: vi.fn(async (cursor) => { expect(cursor.pageToken).toBeUndefined(); return { items: [conversation("new-head")], hasMore: true, nextPageToken: "ignored-head-next" }; }), listMessages: async () => ({ items: [], hasMore: false }) };
    await seed.processor.processNext(adapter); await due(); await seed.processor.processNext(adapter); await due(); await seed.processor.processNext(adapter);
    const job = await prisma.historySyncJob.findUniqueOrThrow({ where: { shopId: seed.shop.id } });
    expect(job.privateBackfillPageToken).toBe("deep-frontier"); expect(job.passKind).toBe("BACKFILL");
    expect(await prisma.conversation.count({ where: { externalConversationId: "new-head" } })).toBe(1);
  });

  it("recovers an invalid opaque list cursor from page one without marking completion", async () => {
    const seed = await fixture(); await seed.service.startHistorySync();
    await prisma.historySyncJob.update({ where: { shopId: seed.shop.id }, data: { state: "QUEUED", privateBackfillPageToken: "stale" } });
    await seed.processor.processNext({ listConversations: async () => { throw new TikTokApiError("PROVIDER", "LIST_CONVERSATIONS", 400, 100004, "r", "invalid cursor"); }, listMessages: vi.fn() });
    const job = await prisma.historySyncJob.findUniqueOrThrow({ where: { shopId: seed.shop.id } });
    expect(job).toMatchObject({ state: "QUEUED", privateBackfillPageToken: null, cursorRecoveryCount: 1, initialCompletedAt: null });
  });

  it("persists Retry-After/backoff across restart and terminal auth does not hot-loop", async () => {
    const seed = await fixture(); await seed.service.startHistorySync(); const dueAt = new Date(now.getTime() + 90_000);
    const rateAdapter = { listConversations: vi.fn(async () => { throw new TikTokApiError("RATE_LIMIT", "LIST_CONVERSATIONS", 429, 36009002, "r", "rate", 90_000, dueAt); }), listMessages: vi.fn() };
    await seed.processor.processNext(rateAdapter);
    expect(await seed.processor.processNext(rateAdapter)).toBe(false); expect(rateAdapter.listConversations).toHaveBeenCalledTimes(1);
    expect(await prisma.historySyncJob.findUniqueOrThrow({ where: { shopId: seed.shop.id } })).toMatchObject({ state: "BACKING_OFF", nextAttemptAt: dueAt });
    now = dueAt; const restarted = new HistoryProcessor(prisma as any, seed.tiktok as any, seed.identities, { now: () => now, random: () => 0 });
    await restarted.processNext({ listConversations: async () => { throw new TikTokApiError("AUTH_EXPIRED", "LIST_CONVERSATIONS", 401, 105002, "r", "secret token text"); }, listMessages: vi.fn() });
    const failed = await prisma.historySyncJob.findUniqueOrThrow({ where: { shopId: seed.shop.id } });
    expect(failed).toMatchObject({ state: "FAILED", lastErrorCategory: "AUTH_EXPIRED" });
    expect(JSON.stringify(publicHistoryJob(failed))).not.toContain("secret token text");
    expect(await restarted.processNext(rateAdapter)).toBe(false);
  });

  it("pause prevents calls and resume continues durable work", async () => {
    const seed = await fixture(); await seed.service.startHistorySync(); await seed.service.pauseHistorySync();
    const adapter = { listConversations: vi.fn(), listMessages: vi.fn() };
    expect(await seed.processor.processNext(adapter)).toBe(false); expect(adapter.listConversations).not.toHaveBeenCalled();
    await seed.service.resumeHistorySync();
    adapter.listConversations.mockResolvedValue({ items: [], hasMore: false });
    expect(await seed.processor.processNext(adapter)).toBe(true); expect(adapter.listConversations).toHaveBeenCalledOnce();
  });

  it("replays a staged page safely after persistence but before cursor advancement", async () => {
    const seed = await fixture(); await seed.service.startHistorySync();
    const adapter = { listConversations: vi.fn(async () => ({ items: [conversation("crash-page")], nextPageToken: "next", hasMore: true })), listMessages: vi.fn(async () => ({ items: [message("crash-message", "crash-page", "OUTBOUND", "2026-02-01T00:00:00Z")], hasMore: false })) };
    await seed.processor.processNext(adapter); await due(); await seed.processor.processNext(adapter);
    const staged = await prisma.historySyncJob.findUniqueOrThrow({ where: { shopId: seed.shop.id } });
    expect(staged.phase).toBe("MESSAGES"); expect(staged.privateBackfillPageToken).toBeNull();
    await prisma.historySyncJob.update({ where: { id: staged.id }, data: { state: "RUNNING", leaseOwner: "dead", leaseExpiresAt: new Date(now.getTime() - 1) } });
    const restarted = new HistoryProcessor(prisma as any, seed.tiktok as any, seed.identities, { now: () => now });
    await restarted.processNext(adapter);
    expect(await prisma.conversationMessage.count({ where: { externalMessageId: "crash-message" } })).toBe(1);
    expect((await prisma.creatorShopContactState.findFirstOrThrow({ where: { shopId: seed.shop.id } })).contactCount).toBe(1);
  });

  it("incremental reread imports a new message and dedupes the old one", async () => {
    const seed = await fixture(); await seed.service.startHistorySync();
    const initial = { listConversations: async () => ({ items: [conversation("recent")], hasMore: false }), listMessages: async () => ({ items: [message("old", "recent", "OUTBOUND", "2026-02-01T00:00:00Z")], hasMore: false }) };
    await drain(seed.processor, initial);
    await seed.service.runIncrementalNow();
    const incremental = { listConversations: async () => ({ items: [conversation("recent")], hasMore: false }), listMessages: async () => ({ items: [message("old", "recent", "OUTBOUND", "2026-02-01T00:00:00Z"), message("new", "recent", "INBOUND", "2026-08-13T00:00:00Z")], hasMore: false }) };
    await drain(seed.processor, incremental);
    expect(await prisma.conversationMessage.count({ where: { conversation: { shopId: seed.shop.id } } })).toBe(2);
    expect(await prisma.creatorShopContactState.findFirstOrThrow({ where: { shopId: seed.shop.id } })).toMatchObject({ contactCount: 1, latestReplyStatus: "REPLIED" });
  });

  it("narrows the history adapter to reads and keeps provider/governor lanes isolated", async () => {
    const seed = await fixture();
    const full = { listConversations: vi.fn(), listMessages: vi.fn(), searchCreators: vi.fn(), sendMessage: vi.fn(), createOrGetConversation: vi.fn() };
    const integration = Object.create((seed.tiktok as any).constructor.prototype);
    integration.adapter = async () => full;
    const narrowed = await (await import("../integrations/tiktok.service")).TikTokIntegrationService.prototype.historyAdapter.call(integration);
    expect(Object.keys(narrowed).sort()).toEqual(["listConversations", "listMessages"]);
    expect((narrowed as any).sendMessage).toBeUndefined(); expect((narrowed as any).searchCreators).toBeUndefined();
    const operations = await prisma.providerReadThrottle.createMany({ data: [
      { provider: "TIKTOK_SHOP", shopScope: seed.shop.id, operation: "SEARCH_CREATORS", nextPermittedAt: new Date(now.getTime() + 999_999) },
      { provider: "TIKTOK_SHOP", shopScope: seed.shop.id, operation: "LIST_CONVERSATIONS" },
      { provider: "TIKTOK_SHOP", shopScope: seed.shop.id, operation: "LIST_MESSAGES" }
    ] });
    expect(operations.count).toBe(3);
    const rows = await prisma.providerReadThrottle.findMany({ where: { shopScope: seed.shop.id } });
    expect(rows.find((row) => row.operation === "LIST_CONVERSATIONS")?.nextPermittedAt).toBeNull();
    expect(rows.find((row) => row.operation === "LIST_MESSAGES")?.nextPermittedAt).toBeNull();
  });
});
