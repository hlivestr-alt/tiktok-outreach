import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@affiliate/db";
import type { CreatorCandidate } from "@affiliate/domain";
import { TikTokApiError } from "@affiliate/tiktok-adapter";
import { CreatorIdentityResolver } from "../identity/creator-identity-resolver.service";
import { DiscoveryProcessor, publicDiscoveryRun } from "./discovery-processor";
import { OutreachService } from "./outreach.service";

const prisma = new PrismaClient();
const shopIds = new Set<string>();
const stamp = () => `discovery_${Date.now()}_${Math.random().toString(16).slice(2)}`;
let now = new Date("2026-08-12T00:00:00.000Z");

function creators(count: number, start = 0): CreatorCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    creatorOpenId: `open_${start + index}`, creatorUserId: `user_${start + index}`, username: `creator.${start + index}`,
    nickname: `Creator ${start + index}`, categoryIds: ["beauty"], followerCount: 10_000 + index,
    gmv: { amount: "100", currency: "IDR" }, unitsSold: 5, avgVideoViews: 1_000, avgLiveViewers: 50,
    engagementRate: 0.1, selectionRegion: "ID", discoveryOrdinal: index
  }));
}

async function fixture(candidateLimit = 20, targetCount = 1) {
  const shop = await prisma.shop.create({ data: { name: stamp(), connectionMode: "MOCK" } }); shopIds.add(shop.id);
  const tiktok = { activeShop: async () => shop };
  const service = new OutreachService(prisma as any, {} as any, tiktok as any);
  const campaign = await service.create({ name: stamp(), productName: "Product", targetCount, candidateLimit, cooldownDays: 0, messageTemplate: "Hi {{creator_display_name}}", filters: {}, rankingMetric: "FOLLOWERS", rankingDirection: "DESC" });
  const processor = new DiscoveryProcessor(prisma as any, {} as any, new CreatorIdentityResolver(prisma as any), { now: () => now, random: () => 0 });
  return { shop, service, campaign, processor };
}

beforeEach(() => { now = new Date("2026-08-12T00:00:00.000Z"); });
afterAll(async () => { for (const id of shopIds) await prisma.shop.delete({ where: { id } }).catch(() => undefined); await prisma.$disconnect(); });

describe.sequential("resumable Marketplace discovery", () => {
  it("enqueues asynchronously and duplicate enqueue returns the same run", async () => {
    const seed = await fixture(); const adapter = { searchCreators: vi.fn() };
    const first = await seed.service.discover(seed.campaign.id); const second = await seed.service.discover(seed.campaign.id);
    expect(first).toMatchObject({ state: "QUEUED", candidatesFetched: 0 }); expect(second).toEqual(first); expect(adapter.searchCreators).not.toHaveBeenCalled();
    expect(await prisma.discoveryRun.count({ where: { campaignId: seed.campaign.id } })).toBe(1);
    await seed.service.cancelDiscovery(seed.campaign.id);
  });

  it("uses page_size 20, exact opaque cursors, five resumable pages, and no performance calls", async () => {
    const seed = await fixture(100, 10); await seed.service.discover(seed.campaign.id);
    let page = 0;
    const adapter = { searchCreators: vi.fn(async (_filters, cursor) => {
      expect(cursor.pageSize).toBe(20);
      if (page === 0) expect(cursor).toEqual({ pageSize: 20 });
      else expect(cursor).toEqual({ pageSize: 20, pageToken: `token-${page}`, searchKey: "opaque-search" });
      const result = { creators: creators(20, page * 20), searchKey: "opaque-search", nextPageToken: page < 4 ? `token-${page + 1}` : undefined, hasMore: page < 4 };
      page++; return result;
    }) };
    for (let i = 0; i < 5; i++) { expect(await seed.processor.processNext(adapter)).toBe(true); now = new Date(now.getTime() + 1001); }
    expect(adapter.searchCreators).toHaveBeenCalledTimes(5);
    expect(await prisma.discoveryCandidate.count({ where: { discoveryRun: { campaignId: seed.campaign.id } } })).toBe(100);
    expect(await prisma.campaignRecipient.count({ where: { campaignId: seed.campaign.id } })).toBe(100);
    expect(await prisma.discoveryRun.findUniqueOrThrow({ where: { campaignId: seed.campaign.id } })).toMatchObject({ state: "COMPLETE", pagesFetched: 5, candidatesFetched: 100 });
  });

  it("replays a page idempotently by exact Creator Open ID", async () => {
    const seed = await fixture(20); await seed.service.discover(seed.campaign.id);
    const adapter = { searchCreators: vi.fn(async () => ({ creators: [...creators(10), ...creators(10)], searchKey: "private", hasMore: false })) };
    await seed.processor.processNext(adapter);
    expect(await prisma.discoveryCandidate.count({ where: { discoveryRun: { campaignId: seed.campaign.id } } })).toBe(10);
    expect(await prisma.campaignRecipient.count({ where: { campaignId: seed.campaign.id } })).toBe(10);
  });

  it.each([
    [36009002, 429, "MARKETPLACE_THROTTLED"],
    [undefined, 429, "MARKETPLACE_THROTTLED"],
    [45101004, 429, "DAILY_QUOTA"]
  ])("persists resumable throttle code %s", async (code, status, category) => {
    const seed = await fixture(); await seed.service.discover(seed.campaign.id);
    const due = new Date(now.getTime() + 15 * 60_000);
    await seed.processor.processNext({ searchCreators: async () => { throw new TikTokApiError("RATE_LIMIT", "SEARCH_CREATORS", status, code, "request-id", "secret", undefined, due); } });
    const run = await prisma.discoveryRun.findUniqueOrThrow({ where: { campaignId: seed.campaign.id } });
    expect(run).toMatchObject({ state: "BACKING_OFF", nextAttemptAt: due, failureCategory: category, totalProviderRequests: 1 });
    expect(JSON.stringify(publicDiscoveryRun(run))).not.toContain("secret");
  });

  it("polling is local, refresh does not restart, and cooldown cannot be bypassed", async () => {
    const seed = await fixture(); await seed.service.discover(seed.campaign.id);
    const due = new Date(now.getTime() + 900_000); const adapter = { searchCreators: vi.fn() };
    await prisma.discoveryRun.update({ where: { campaignId: seed.campaign.id }, data: { state: "BACKING_OFF", nextAttemptAt: due } });
    const polled = await seed.service.get(seed.campaign.id); await seed.service.get(seed.campaign.id); await seed.service.discover(seed.campaign.id);
    expect(JSON.stringify(polled)).not.toContain("providerSearchKey"); expect(JSON.stringify(polled)).not.toContain("providerNextPageToken"); expect(JSON.stringify(polled)).not.toContain("shopCipher");
    expect(await seed.processor.processNext(adapter)).toBe(false); expect(adapter.searchCreators).not.toHaveBeenCalled();
    expect(await prisma.discoveryRun.count({ where: { campaignId: seed.campaign.id } })).toBe(1);
  });

  it("restart instance resumes persisted cursor and terminal errors do not spin", async () => {
    const seed = await fixture(40); await seed.service.discover(seed.campaign.id);
    await seed.processor.processNext({ searchCreators: async () => ({ creators: creators(20), searchKey: "search", nextPageToken: "next-exact", hasMore: true }) });
    now = new Date(now.getTime() + 1001);
    const restarted = new DiscoveryProcessor(prisma as any, {} as any, new CreatorIdentityResolver(prisma as any), { now: () => now, random: () => 0 });
    const adapter = { searchCreators: vi.fn(async (_filters, cursor) => { expect(cursor).toEqual({ pageSize: 20, pageToken: "next-exact", searchKey: "search" }); throw new TikTokApiError("PERMISSION", "SEARCH_CREATORS", 403, 105005, "r", "denied"); }) };
    await restarted.processNext(adapter);
    expect(await prisma.discoveryRun.findUniqueOrThrow({ where: { campaignId: seed.campaign.id } })).toMatchObject({ state: "FAILED", failureCategory: "PERMISSION", pagesFetched: 1, totalProviderRequests: 2 });
    expect(await restarted.processNext(adapter)).toBe(false); expect(adapter.searchCreators).toHaveBeenCalledTimes(1);
  });
});
