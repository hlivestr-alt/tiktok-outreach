import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@affiliate/db";
import type { CreatorCandidate } from "@affiliate/domain";
import { TikTokApiError } from "@affiliate/tiktok-adapter";
import { CreatorIdentityResolver } from "../identity/creator-identity-resolver.service";
import { OutreachService } from "./outreach.service";

const prisma = new PrismaClient();
const shopIds = new Set<string>();
const stamp = () => `discovery_${Date.now()}_${Math.random().toString(16).slice(2)}`;

async function fixture() {
  const shop = await prisma.shop.create({ data: { name: stamp(), connectionMode: "MOCK" } });
  shopIds.add(shop.id);
  const candidate: CreatorCandidate = {
    creatorOpenId: stamp(), creatorUserId: stamp(), username: "retry.creator", nickname: "Retry Creator",
    categoryIds: ["beauty"], followerCount: 10_000, gmv: { amount: "100", currency: "IDR" }, unitsSold: 5,
    avgVideoViews: 1_000, avgLiveViewers: 50, engagementRate: 0.1, selectionRegion: "ID", discoveryOrdinal: 0
  };
  let adapter: any;
  const tiktok = { activeShop: async () => shop, adapter: async () => adapter };
  const service = new OutreachService(prisma as any, {} as any, tiktok as any, new CreatorIdentityResolver(prisma as any));
  const campaign = await service.create({
    name: stamp(), productName: "Product", targetCount: 1, candidateLimit: 1, cooldownDays: 0,
    messageTemplate: "Hi {{creator_display_name}}", filters: {}, rankingMetric: "FOLLOWERS", rankingDirection: "DESC"
  });
  return { service, campaign, candidate, setAdapter: (value: any) => { adapter = value; } };
}

afterAll(async () => {
  for (const id of shopIds) await prisma.shop.delete({ where: { id } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe.sequential("campaign discovery recovery", () => {
  it("restores DRAFT after a first provider failure and allows a successful retry", async () => {
    const seed = await fixture();
    seed.setAdapter({ searchCreators: async () => {
      throw new TikTokApiError("PERMISSION", "SEARCH_CREATORS", 403, 105005, "safe-request-id", "provider detail must not be stored");
    } });
    await expect(seed.service.discover(seed.campaign.id)).rejects.toMatchObject({ kind: "PERMISSION" });
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: seed.campaign.id } })).toMatchObject({ state: "DRAFT" });
    const failure = await prisma.auditEvent.findFirstOrThrow({ where: { campaignId: seed.campaign.id, eventType: "CAMPAIGN_DISCOVERY_FAILED" } });
    expect(failure.payload).toMatchObject({ category: "PERMISSION", retryable: true, restoredState: "DRAFT" });
    expect(JSON.stringify(failure.payload)).not.toContain("provider detail must not be stored");

    seed.setAdapter({ searchCreators: async () => ({ creators: [seed.candidate], searchKey: "retry-key", hasMore: false }) });
    await expect(seed.service.discover(seed.campaign.id)).resolves.toMatchObject({ state: "PREVIEW_READY" });
    expect(await prisma.campaignRecipient.count({ where: { campaignId: seed.campaign.id } })).toBe(1);
  });

  it("preserves an existing valid preview when rediscovery fails", async () => {
    const seed = await fixture();
    seed.setAdapter({ searchCreators: async () => ({ creators: [seed.candidate], searchKey: "initial-key", hasMore: false }) });
    await seed.service.discover(seed.campaign.id);
    const before = await prisma.campaign.findUniqueOrThrow({ where: { id: seed.campaign.id } });
    const recipientsBefore = await prisma.campaignRecipient.findMany({ where: { campaignId: seed.campaign.id }, select: { id: true } });

    seed.setAdapter({ searchCreators: async () => {
      throw new TikTokApiError("MALFORMED_RESPONSE", "SEARCH_CREATORS", 200, 0, "safe-request-id", "raw malformed body");
    } });
    await expect(seed.service.discover(seed.campaign.id)).rejects.toMatchObject({ kind: "MALFORMED_RESPONSE" });
    const after = await prisma.campaign.findUniqueOrThrow({ where: { id: seed.campaign.id } });
    expect(after).toMatchObject({ state: "PREVIEW_READY", summary: before.summary, searchKey: before.searchKey });
    expect(await prisma.campaignRecipient.findMany({ where: { campaignId: seed.campaign.id }, select: { id: true } })).toEqual(recipientsBefore);
    const failure = await prisma.auditEvent.findFirstOrThrow({ where: { campaignId: seed.campaign.id, eventType: "CAMPAIGN_DISCOVERY_FAILED" }, orderBy: { createdAt: "desc" } });
    expect(failure.payload).toMatchObject({ category: "MALFORMED_RESPONSE", retryable: true, restoredState: "PREVIEW_READY" });
    expect(JSON.stringify(failure.payload)).not.toContain("raw malformed body");
  });
});
