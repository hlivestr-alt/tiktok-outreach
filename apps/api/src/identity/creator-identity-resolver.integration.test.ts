import { afterAll, describe, expect, it } from "vitest";
import { lockCreatorEligibility, PrismaClient } from "@affiliate/db";
import { CreatorIdentityResolver } from "./creator-identity-resolver.service";
import { HistoryService } from "../history/history.service";

const prisma = new PrismaClient();
const shopIds = new Set<string>();
const stamp = () => `identity_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const mockOutboundCapability = { outboundCapability: async () => ({ mode: "MOCK", mutationCapability: true, available: true, workerState: "NOT_REQUIRED", reason: null }) };

async function shop() {
  const value = await prisma.shop.create({ data: { name: stamp(), connectionMode: "MOCK" } });
  shopIds.add(value.id);
  return value;
}

afterAll(async () => {
  for (const id of shopIds) await prisma.shop.delete({ where: { id } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe.sequential("creator provider identity reconciliation", () => {
  it("keeps conversation IM identity separate from Marketplace Open ID without fabricating im:*", async () => {
    const resolver = new CreatorIdentityResolver(prisma as any);
    const imId = stamp();
    const openId = stamp();
    const historical = await resolver.ensureConversationCreator({ id: stamp(), creatorImId: imId, username: "same-looking-name" });
    const marketplace = await resolver.ensureMarketplaceCreator({
      creatorOpenId: openId, username: "same-looking-name", nickname: "Same Looking Name", categoryIds: [], followerCount: null,
      gmv: null, unitsSold: null, avgVideoViews: null, avgLiveViewers: null, selectionRegion: "ID", discoveryOrdinal: 0
    });
    expect(historical.id).not.toBe(marketplace.id);
    expect(historical.creatorOpenId).toBeNull();
    expect(await prisma.creator.count({ where: { creatorOpenId: { startsWith: "im:" } } })).toBe(0);
    expect(await prisma.creatorProviderIdentity.findUniqueOrThrow({ where: {
      provider_identityType_identifier: { provider: "TIKTOK_SHOP", identityType: "TIKTOK_CREATOR_IM_ID", identifier: imId }
    } })).toMatchObject({ creatorId: historical.id, linkState: "UNRESOLVED" });
  });

  it("links exact provider evidence idempotently and rebuilds contact state without losing DNC or unresolved delivery", async () => {
    const resolver = new CreatorIdentityResolver(prisma as any);
    const selectedShop = await shop();
    const imId = stamp(); const openId = stamp();
    const source = await resolver.ensureConversationCreator({ id: stamp(), creatorImId: imId });
    const target = await resolver.ensureMarketplaceCreator({ creatorOpenId: openId, categoryIds: [], followerCount: null, gmv: null, unitsSold: null, avgVideoViews: null, avgLiveViewers: null, selectionRegion: "ID", discoveryOrdinal: 0 });
    const sourceConversation = await prisma.conversation.create({ data: { shopId: selectedShop.id, creatorId: source.id, externalConversationId: stamp() } });
    const targetConversation = await prisma.conversation.create({ data: { shopId: selectedShop.id, creatorId: target.id, externalConversationId: stamp() } });
    await prisma.conversationMessage.createMany({ data: [
      { conversationId: sourceConversation.id, externalMessageId: stamp(), direction: "OUTBOUND", content: "one", contentHash: "one", providerCreatedAt: new Date("2026-08-01T00:00:00Z"), importSource: "TEST" },
      { conversationId: targetConversation.id, externalMessageId: stamp(), direction: "OUTBOUND", content: "two", contentHash: "two", providerCreatedAt: new Date("2026-08-03T00:00:00Z"), importSource: "TEST" }
    ] });
    await prisma.creatorShopContactState.createMany({ data: [
      { shopId: selectedShop.id, creatorId: source.id, contactCount: 1, firstContactedAt: new Date("2026-08-01T00:00:00Z"), lastContactedAt: new Date("2026-08-01T00:00:00Z"), doNotContact: true, unresolvedDelivery: true },
      { shopId: selectedShop.id, creatorId: target.id, contactCount: 1, firstContactedAt: new Date("2026-08-03T00:00:00Z"), lastContactedAt: new Date("2026-08-03T00:00:00Z"), latestReplyStatus: "REPLIED" }
    ] });
    const evidence = { evidenceType: "DOCUMENTED_PROVIDER_MAPPING" as const, creatorImId: imId, creatorOpenId: openId, mappingReference: "test-provider-exact-map" };
    const linked = await resolver.linkExactProviderIdentities(source.id, target.id, evidence);
    expect(linked).toMatchObject({ id: target.id, creatorOpenId: openId, creatorImId: imId });
    const state = await prisma.creatorShopContactState.findUniqueOrThrow({ where: { shopId_creatorId: { shopId: selectedShop.id, creatorId: target.id } } });
    expect(state).toMatchObject({ contactCount: 2, doNotContact: true, unresolvedDelivery: true, latestReplyStatus: "REPLIED" });
    expect(state.firstContactedAt?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(state.lastContactedAt?.toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect(await prisma.conversation.count({ where: { creatorId: target.id } })).toBe(2);
    expect(await prisma.conversationMessage.count({ where: { conversation: { creatorId: target.id } } })).toBe(2);
    expect(await resolver.linkExactProviderIdentities(source.id, target.id, evidence)).toMatchObject({ id: target.id });
    expect(await prisma.creatorIdentityAudit.count({ where: { action: "EXACT_PROVIDER_IDENTITIES_LINKED", targetCreatorId: target.id } })).toBe(1);
  });

  it("rejects conflicting exact evidence", async () => {
    const resolver = new CreatorIdentityResolver(prisma as any);
    const source = await resolver.ensureConversationCreator({ id: stamp(), creatorImId: stamp() });
    const target = await resolver.ensureMarketplaceCreator({ creatorOpenId: stamp(), categoryIds: [], followerCount: null, gmv: null, unitsSold: null, avgVideoViews: null, avgLiveViewers: null, selectionRegion: "ID", discoveryOrdinal: 0 });
    await expect(resolver.linkExactProviderIdentities(source.id, target.id, {
      evidenceType: "DOCUMENTED_PROVIDER_MAPPING", creatorImId: "wrong", creatorOpenId: target.creatorOpenId!, mappingReference: "test"
    })).rejects.toThrow(/does not match/i);
  });

  it("takes the shared eligibility lock before exact-identity reassignment", async () => {
    const resolver = new CreatorIdentityResolver(prisma as any);
    const selectedShop = await shop();
    const imId = stamp(); const openId = stamp();
    const source = await resolver.ensureConversationCreator({ id: stamp(), creatorImId: imId });
    const target = await resolver.ensureMarketplaceCreator({
      creatorOpenId: openId, categoryIds: [], followerCount: null, gmv: null, unitsSold: null,
      avgVideoViews: null, avgLiveViewers: null, selectionRegion: "ID", discoveryOrdinal: 0
    });
    await prisma.creatorShopContactState.create({ data: { shopId: selectedShop.id, creatorId: source.id } });
    let release!: () => void;
    let locked!: () => void;
    const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
    const lockedSignal = new Promise<void>((resolve) => { locked = resolve; });
    const blocker = prisma.$transaction(async (tx) => {
      await lockCreatorEligibility(tx, selectedShop.id, [source.id]);
      locked();
      await releaseSignal;
    });
    await lockedSignal;
    let settled = false;
    const linking = resolver.linkExactProviderIdentities(source.id, target.id, {
      evidenceType: "DOCUMENTED_PROVIDER_MAPPING", creatorImId: imId, creatorOpenId: openId, mappingReference: "lock-test"
    }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const settledBeforeRelease = settled;
    release();
    await blocker;
    expect(settledBeforeRelease).toBe(false);
    await expect(linking).resolves.toMatchObject({ id: target.id, creatorImId: imId });
  });

  it("rejects attempts to overwrite an existing exact identifier link", async () => {
    const resolver = new CreatorIdentityResolver(prisma as any);
    const openId = stamp(); const userId = stamp(); const imId = stamp();
    await resolver.ensureMarketplaceCreator({ creatorOpenId: openId, creatorUserId: userId, categoryIds: [], followerCount: null, gmv: null, unitsSold: null, avgVideoViews: null, avgLiveViewers: null, selectionRegion: "ID", discoveryOrdinal: 0 });
    await resolver.ensureConversationCreator({ id: stamp(), creatorOpenId: openId, creatorImId: imId });
    await expect(resolver.ensureMarketplaceCreator({ creatorOpenId: stamp(), creatorUserId: userId, categoryIds: [], followerCount: null, gmv: null, unitsSold: null, avgVideoViews: null, avgLiveViewers: null, selectionRegion: "ID", discoveryOrdinal: 0 }))
      .rejects.toThrow(/different Creator Open ID/i);
    await expect(resolver.ensureConversationCreator({ id: stamp(), creatorOpenId: stamp(), creatorImId: imId }))
      .rejects.toThrow(/different Creator Open ID/i);
    expect(await prisma.creator.findUniqueOrThrow({ where: { creatorImId: imId } })).toMatchObject({ creatorOpenId: openId, creatorUserId: userId });
  });
});

describe.sequential("identity-aware history readiness", () => {
  it("does not trust a migrated Open ID until Marketplace observes the same exact identity", async () => {
    const selectedShop = await shop();
    const openId = stamp();
    const creator = await prisma.creator.create({ data: { creatorOpenId: openId, selectionRegion: "ID" } });
    await prisma.creatorProviderIdentity.create({ data: {
      creatorId: creator.id, identityType: "TIKTOK_CREATOR_OPEN_ID", identifier: openId,
      linkState: "VERIFIED", evidenceType: "MIGRATED_EXACT_FIELD"
    } });
    await prisma.creatorShopContactState.create({ data: {
      shopId: selectedShop.id, creatorId: creator.id, contactCount: 1,
      firstContactedAt: new Date(), lastContactedAt: new Date()
    } });
    await prisma.contactHistorySyncRun.create({ data: {
      shopId: selectedShop.id, source: "TEST_MIGRATED", state: "COMPLETE", completedAt: new Date(), conversationsScanned: 1, messagesImported: 1
    } });
    const service = new HistoryService(prisma as any, { activeShop: async () => selectedShop, ...mockOutboundCapability } as any);
    expect(await service.readiness()).toMatchObject({ identityReconciliationComplete: false, futureOutboundSafe: false });

    const resolver = new CreatorIdentityResolver(prisma as any);
    await resolver.ensureMarketplaceCreator({
      creatorOpenId: openId, categoryIds: [], followerCount: null, gmv: null, unitsSold: null,
      avgVideoViews: null, avgLiveViewers: null, selectionRegion: "ID", discoveryOrdinal: 0
    });
    expect(await prisma.creatorProviderIdentity.findUniqueOrThrow({ where: {
      provider_identityType_identifier: { provider: "TIKTOK_SHOP", identityType: "TIKTOK_CREATOR_OPEN_ID", identifier: openId }
    } })).toMatchObject({ linkState: "VERIFIED", evidenceType: "MARKETPLACE_EXACT_FIELD" });
    expect(await service.readiness()).toMatchObject({ identityReconciliationComplete: true, futureOutboundSafe: true });
  });

  it("does not claim provider verification for a CSV-only Creator Open ID", async () => {
    const selectedShop = await shop();
    const openId = stamp();
    const service = new HistoryService(prisma as any, { activeShop: async () => selectedShop, ...mockOutboundCapability } as any);
    await service.importCsv({
      sourceName: `${stamp()}.csv`,
      csv: `source_system,source_record_id,creator_open_id,contacted_at,send_status\nlegacy,${stamp()},${openId},2026-08-01T00:00:00Z,SENT\n`
    });
    const creator = await prisma.creator.findUniqueOrThrow({ where: { creatorOpenId: openId } });
    expect(await prisma.creatorProviderIdentity.count({ where: { creatorId: creator.id } })).toBe(0);
    await prisma.contactHistorySyncRun.create({ data: {
      shopId: selectedShop.id, source: "TEST_CSV_ONLY", state: "COMPLETE", completedAt: new Date(), conversationsScanned: 1, messagesImported: 1
    } });
    expect(await service.readiness()).toMatchObject({ identityReconciliationComplete: false, futureOutboundSafe: false });
  });

  it("does not report complete pagination with unresolved outbound history as future outbound-safe", async () => {
    const selectedShop = await shop();
    const resolver = new CreatorIdentityResolver(prisma as any);
    const creator = await resolver.ensureConversationCreator({ id: stamp(), creatorImId: stamp() });
    await prisma.creatorShopContactState.create({ data: { shopId: selectedShop.id, creatorId: creator.id, contactCount: 2, firstContactedAt: new Date(), lastContactedAt: new Date() } });
    await prisma.contactHistorySyncRun.create({ data: { shopId: selectedShop.id, source: "TEST", state: "COMPLETE", completedAt: new Date(), conversationsScanned: 1, messagesImported: 2 } });
    const service = new HistoryService(prisma as any, { activeShop: async () => selectedShop, ...mockOutboundCapability } as any, resolver);
    const result = await service.readiness();
    expect(result).toMatchObject({ historyPaginationComplete: true, identityReconciliationComplete: false, discoveryUsableForAnalysis: true, futureOutboundSafe: false });
    expect(result.identityCoverage).toMatchObject({ totalHistoricalCreators: 1, imOnlyHistoricalCreators: 1, outboundContactsOnUnresolvedIdentities: 2 });
  });

  it("reports identity-safe only when pagination is complete, fresh, and historical creators have Marketplace identities", async () => {
    const selectedShop = await shop();
    const resolver = new CreatorIdentityResolver(prisma as any);
    const creator = await resolver.ensureMarketplaceCreator({ creatorOpenId: stamp(), categoryIds: [], followerCount: null, gmv: null, unitsSold: null, avgVideoViews: null, avgLiveViewers: null, selectionRegion: "ID", discoveryOrdinal: 0 });
    await prisma.creatorShopContactState.create({ data: { shopId: selectedShop.id, creatorId: creator.id, contactCount: 1, firstContactedAt: new Date(), lastContactedAt: new Date() } });
    await prisma.contactHistorySyncRun.create({ data: { shopId: selectedShop.id, source: "TEST", state: "COMPLETE", completedAt: new Date(), conversationsScanned: 1, messagesImported: 1 } });
    const service = new HistoryService(prisma as any, { activeShop: async () => selectedShop, ...mockOutboundCapability } as any);
    expect(await service.readiness()).toMatchObject({ historyPaginationComplete: true, identityReconciliationComplete: true, futureOutboundSafe: true });
    await prisma.contactHistorySyncRun.create({ data: { shopId: selectedShop.id, source: "TEST_STALE", state: "COMPLETE", completedAt: new Date(Date.now() - 2 * 86_400_000) } });
    expect(await service.readiness()).toMatchObject({ historyPaginationComplete: true, discoveryUsableForAnalysis: false, futureOutboundSafe: false });
    await prisma.contactHistorySyncRun.create({ data: { shopId: selectedShop.id, source: "TEST_PARTIAL", state: "PARTIAL" } });
    expect(await service.readiness()).toMatchObject({ historyPaginationComplete: false, futureOutboundSafe: false });
  });
});
