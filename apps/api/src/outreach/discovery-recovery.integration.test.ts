import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@affiliate/db";
import type { CreatorCandidate } from "@affiliate/domain";
import { TikTokApiError } from "@affiliate/tiktok-adapter";
import { CreatorIdentityResolver } from "../identity/creator-identity-resolver.service";
import { CreatorDatabaseService } from "../creator-database/creator-database.service";
import { CreatorSyncProcessor } from "../creator-database/creator-sync.processor";
import { OutreachService } from "./outreach.service";

const prisma = new PrismaClient();
const shopIds = new Set<string>();
const stamp = () => `creator_sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;

function creator(id: string, followers = 1_200): CreatorCandidate {
  return { creatorOpenId: `open_${id}`, creatorUserId: `user_${id}`, username: `creator_${id}`, nickname: `Creator ${id}`,
    categoryIds: ["beauty"], followerCount: followers, gmv: { amount: "100", currency: "USD" }, unitsSold: 5,
    avgVideoViews: 1_000, avgLiveViewers: 50, engagementRate: 0.1, selectionRegion: "ID", discoveryOrdinal: 0 };
}

async function fixture(state: "RUNNING" | "PAUSED" = "RUNNING", options: { creatorsFetched?: number } = {}) {
  const shop = await prisma.shop.create({ data: { name: stamp(), connectionMode: "MOCK" } }); shopIds.add(shop.id);
  const job = await prisma.creatorSyncJob.create({ data: {
    shopId: shop.id, state, privateNextPageToken: "token200", privateSearchKey: "abc", pagesCompleted: 10,
    creatorsFetched: options.creatorsFetched ?? 200, creatorsFetchedThisRun: 0, spreadsheetId: "sheet-test", sheetImportedAt: new Date()
  } });
  const tiktok = { activeShop: async () => shop };
  const identities = new CreatorIdentityResolver(prisma as any);
  const processor = new CreatorSyncProcessor(prisma as any, {} as any, identities, {} as any, { now: () => new Date("2026-08-14T06:00:00Z"), random: () => 0 });
  const service = new CreatorDatabaseService(prisma as any, tiktok as any);
  const sheet = { readCreators: vi.fn(async () => []), reconcilePage: vi.fn(async () => undefined) };
  return { shop, job, processor, service, sheet };
}

afterEach(async () => { for (const id of shopIds) await prisma.shop.delete({ where: { id } }).catch(() => undefined); shopIds.clear(); });
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential("creator database continuation sync", () => {
  it("Resume uses the exact persisted cursor and advances only after the page is saved", async () => {
    const seed = await fixture("PAUSED"); await seed.service.resume();
    const adapter = { searchCreators: vi.fn(async (_filters, cursor) => {
      expect(cursor).toEqual({ pageSize: 20, pageToken: "token200", searchKey: "abc" });
      return { creators: [creator("220")], searchKey: "abc-next", nextPageToken: "token220", hasMore: true };
    }) };
    await seed.processor.processNext(adapter, seed.sheet);
    expect(adapter.searchCreators).toHaveBeenCalledTimes(1);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "RUNNING", currentStage: "PAGE_COMMITTED", privateNextPageToken: "token220", privateSearchKey: "abc-next",
      pagesCompleted: 11, creatorsFetched: 201, lastCreatorsReturned: 1, lastCreatorsAdded: 1, lastDuplicates: 0
    });
    expect(seed.sheet.reconcilePage).toHaveBeenCalledTimes(1);
    expect((await prisma.creatorSyncEvent.findMany({ where: { creatorSyncJobId: seed.job.id }, orderBy: { occurredAt: "asc" } })).map((event) => event.stage))
      .toEqual(expect.arrayContaining(["REQUESTING_TIKTOK", "TIKTOK_SUCCESS", "SAVING_DATABASE", "SAVING_SHEET", "COMMITTING_PAGE", "PAGE_COMMITTED", "CURSOR_ADVANCED"]));
  });

  it("a failed request preserves the previous cursor", async () => {
    const seed = await fixture();
    await seed.processor.processNext({ searchCreators: vi.fn(async () => { throw new TikTokApiError("PERMISSION", "SEARCH_CREATORS", 403, 105005, "r", "denied"); }) }, seed.sheet);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "ERROR", currentStage: "TIKTOK_ERROR", privateNextPageToken: "token200", privateSearchKey: "abc", pagesCompleted: 10,
      lastHttpStatus: 403, lastTikTokCode: "105005", lastAttemptPage: 11
    });
  });

  it("Pause lets an in-flight page commit and prevents the following request", async () => {
    const seed = await fixture();
    let release!: (value: { creators: CreatorCandidate[]; searchKey: string; nextPageToken: string; hasMore: boolean }) => void;
    let requested!: () => void;
    const started = new Promise<void>((resolve) => { requested = resolve; });
    const response = new Promise<{ creators: CreatorCandidate[]; searchKey: string; nextPageToken: string; hasMore: boolean }>((resolve) => { release = resolve; });
    const adapter = { searchCreators: vi.fn(async () => { requested(); return response; }) };
    const work = seed.processor.processNext(adapter, seed.sheet); await started; await seed.service.pause();
    release({ creators: [creator("pause")], searchKey: "abc", nextPageToken: "token220", hasMore: true });
    await work;
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({ state: "PAUSED", privateNextPageToken: "token220", pagesCompleted: 11 });
    expect(await seed.processor.processNext(adapter, seed.sheet)).toBe(false);
    expect(adapter.searchCreators).toHaveBeenCalledTimes(1);
  });

  it("restart leaves PAUSED idle and RUNNING resumes from persisted state", async () => {
    const seed = await fixture("PAUSED"); const adapter = { searchCreators: vi.fn(async () => ({ creators: [], searchKey: "abc", hasMore: false })) };
    const restarted = new CreatorSyncProcessor(prisma as any, {} as any, new CreatorIdentityResolver(prisma as any), {} as any);
    expect(await restarted.processNext(adapter, seed.sheet)).toBe(false); expect(adapter.searchCreators).not.toHaveBeenCalled();
    await seed.service.resume(); await restarted.processNext(adapter, seed.sheet);
    expect(adapter.searchCreators).toHaveBeenCalledWith({}, { pageSize: 20, pageToken: "token200", searchKey: "abc" });
  });

  it("has no total creator cap and marks genuine pagination exhaustion without a page-one search", async () => {
    const growing = await fixture("RUNNING", { creatorsFetched: 50_000 });
    const more = { searchCreators: vi.fn(async () => ({ creators: [creator("50001")], searchKey: "abc", nextPageToken: "token220", hasMore: true })) };
    await growing.processor.processNext(more, growing.sheet);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: growing.job.id } })).toMatchObject({ state: "RUNNING", creatorsFetched: 50_001, privateNextPageToken: "token220" });

    const exhausted = await fixture();
    const last = { searchCreators: vi.fn(async (_filters, cursor) => {
      expect(cursor.pageToken).toBe("token200"); return { creators: [], searchKey: "abc", hasMore: false };
    }) };
    await exhausted.processor.processNext(last, exhausted.sheet);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: exhausted.job.id } })).toMatchObject({ state: "EXHAUSTED", pagesCompleted: 11 });
    expect(last.searchCreators).toHaveBeenCalledTimes(1);
  });

  it("temporary throttling retries in 5 seconds with the same cursor", async () => {
    const seed = await fixture(); const due = new Date("2026-08-14T06:00:05Z");
    await seed.processor.processNext({ searchCreators: vi.fn(async () => { throw new TikTokApiError("RATE_LIMIT", "SEARCH_CREATORS", 429, 36009002, "r", "throttled", undefined, due); }) }, seed.sheet);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "WAITING", currentStage: "WAITING_RETRY", privateNextPageToken: "token200", privateSearchKey: "abc",
      pagesCompleted: 10, nextAttemptAt: due, lastHttpStatus: 429, lastTikTokCode: "36009002", lastAttemptPage: 11
    });
    const publicStatus = await seed.service.status();
    expect(publicStatus).toMatchObject({ currentStage: "WAITING_RETRY", lastHttpStatus: 429, lastTikTokCode: "36009002" });
    expect(publicStatus.recentActivity.find((event) => event.stage === "TIKTOK_THROTTLED")).toMatchObject({
      stage: "TIKTOK_THROTTLED",
      pageNumber: 11,
      tiktokCode: "36009002"
    });
    expect(JSON.stringify(publicStatus)).not.toContain("token200");
    expect(JSON.stringify(publicStatus)).not.toContain("\"abc\"");
    const retry = { searchCreators: vi.fn(async (_filters, cursor) => {
      expect(cursor).toEqual({ pageSize: 20, pageToken: "token200", searchKey: "abc" });
      return { creators: [], searchKey: "abc", hasMore: false };
    }) };
    const dueProcessor = new CreatorSyncProcessor(
      prisma as any, {} as any, new CreatorIdentityResolver(prisma as any), {} as any,
      { now: () => due, random: () => 0 }
    );
    await dueProcessor.processNext(retry, seed.sheet);
    expect(retry.searchCreators).toHaveBeenCalledTimes(1);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "EXHAUSTED", pagesCompleted: 11
    });
  });

  it("honors a longer provider Retry-After without changing the cursor", async () => {
    const seed = await fixture(); const due = new Date("2026-08-14T06:02:00Z");
    await seed.processor.processNext({ searchCreators: vi.fn(async () => { throw new TikTokApiError("RATE_LIMIT", "SEARCH_CREATORS", 429, 36009002, "r", "throttled", 120_000, due); }) }, seed.sheet);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "WAITING", privateNextPageToken: "token200", privateSearchKey: "abc", pagesCompleted: 10, nextAttemptAt: due
    });
  });

  it("Pause cancels a scheduled retry and Resume retains the persisted cursor", async () => {
    const seed = await fixture();
    await prisma.creatorSyncJob.update({ where: { id: seed.job.id }, data: { state: "WAITING", nextAttemptAt: new Date("2026-08-14T06:00:30Z") } });
    await seed.service.pause();
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "PAUSED", nextAttemptAt: null, privateNextPageToken: "token200", privateSearchKey: "abc", pagesCompleted: 10
    });
    expect(await seed.processor.processNext({ searchCreators: vi.fn() }, seed.sheet)).toBe(false);
    await seed.service.resume();
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "RUNNING", nextAttemptAt: null, privateNextPageToken: "token200", privateSearchKey: "abc", pagesCompleted: 10
    });
  });

  it("keeps continuation requests single-flight", async () => {
    const seed = await fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const adapter = { searchCreators: vi.fn(async () => {
      await pending;
      return { creators: [], searchKey: "abc", hasMore: false };
    }) };
    const first = seed.processor.processNext(adapter, seed.sheet);
    await vi.waitFor(() => expect(adapter.searchCreators).toHaveBeenCalledTimes(1));
    await seed.processor.processNext(adapter, seed.sheet);
    expect(adapter.searchCreators).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("persists separate Google Sheets and cursor failure stages without advancing", async () => {
    const sheetFailure = await fixture();
    const successfulPage = { searchCreators: vi.fn(async () => ({ creators: [creator("sheet-failure")], searchKey: "abc", nextPageToken: "token220", hasMore: true })) };
    await sheetFailure.processor.processNext(successfulPage, { ...sheetFailure.sheet, reconcilePage: vi.fn(async () => { throw new Error("private sheet detail"); }) });
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: sheetFailure.job.id } })).toMatchObject({
      state: "ERROR", currentStage: "SHEET_ERROR", pagesCompleted: 10, privateNextPageToken: "token200",
      lastSafeError: "Google Sheets save failed; the page was not committed"
    });

    const cursorFailure = await fixture();
    await cursorFailure.processor.processNext({ searchCreators: vi.fn(async () => ({ creators: [], searchKey: "abc", nextPageToken: "token200", hasMore: true })) }, cursorFailure.sheet);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: cursorFailure.job.id } })).toMatchObject({
      state: "ERROR", currentStage: "CURSOR_ERROR", pagesCompleted: 10, privateNextPageToken: "token200",
      lastSafeError: "Page commit failed; the cursor was not advanced"
    });
  });

  it("persists a PostgreSQL failure stage without exposing database details", async () => {
    const seed = await fixture();
    vi.spyOn(seed.processor as any, "persistCreators").mockRejectedValueOnce(new Error("private database detail"));
    await seed.processor.processNext({ searchCreators: vi.fn(async () => ({ creators: [creator("db-failure")], searchKey: "abc", nextPageToken: "token220", hasMore: true })) }, seed.sheet);
    const job = await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } });
    expect(job).toMatchObject({ state: "ERROR", currentStage: "DATABASE_ERROR", pagesCompleted: 10, privateNextPageToken: "token200" });
    expect(job.lastSafeError).toBe("PostgreSQL save failed; the page was not committed");
    expect(JSON.stringify(job)).not.toContain("private database detail");
  });
});

describe.sequential("Outreach uses stored creator snapshots", () => {
  it("changing filters performs zero Marketplace searches and frozen recipients do not grow", async () => {
    const shop = await prisma.shop.create({ data: { name: stamp(), connectionMode: "MOCK", maxRecipientsPerCampaign: 10 } }); shopIds.add(shop.id);
    const identities = new CreatorIdentityResolver(prisma as any);
    const namespace = stamp(); const smallId = `small_${namespace}`; const largeId = `large_${namespace}`;
    for (const item of [creator(smallId, 1_200), creator(largeId, 7_000)]) {
      const stored = await identities.ensureMarketplaceCreator(item);
      await prisma.creatorMetricSnapshot.create({ data: { creatorId: stored.id, shopId: shop.id, sourcePageKey: `test:${item.creatorOpenId}`,
        followerCount: item.followerCount, categoryIds: item.categoryIds, gmvAmount: new Prisma.Decimal("100"), gmvCurrency: "USD",
        unitsSold: 5, avgVideoViews: 1000, avgLiveViewers: 50, sourceFetchedAt: new Date(), rawPayload: item as unknown as Prisma.InputJsonValue } });
    }
    const marketplaceSearch = vi.fn();
    const tiktok = { activeShop: async () => shop, discoveryAdapter: marketplaceSearch };
    const outreach = new OutreachService(prisma as any, {} as any, tiktok as any);
    const make = async (name: string, minFollowers: number, maxFollowers: number, keyword: string) => {
      const campaign = await outreach.create({ name, productName: "Product", targetCount: 1, candidateLimit: 1, cooldownDays: 0,
        messageTemplate: "Hi {{creator_display_name}}", filters: { keyword, minFollowers, maxFollowers }, rankingMetric: "FOLLOWERS" });
      await outreach.discover(campaign.id); return campaign;
    };
    const small = await make(stamp(), 1_000, 1_500, smallId); const large = await make(stamp(), 5_000, 10_000, largeId);
    expect(marketplaceSearch).not.toHaveBeenCalled();
    expect((await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: small.id, selected: true }, include: { creator: true } })).creator.creatorOpenId).toBe(`open_${smallId}`);
    expect((await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: large.id, selected: true }, include: { creator: true } })).creator.creatorOpenId).toBe(`open_${largeId}`);

    await prisma.campaign.update({ where: { id: small.id }, data: { state: "FROZEN", frozenAt: new Date(), freezeExpiresAt: new Date(Date.now() + 60_000) } });
    const before = await prisma.campaignRecipient.count({ where: { campaignId: small.id } });
    const added = creator(`later_${namespace}`, 1_300); const stored = await identities.ensureMarketplaceCreator(added);
    await prisma.creatorMetricSnapshot.create({ data: { creatorId: stored.id, shopId: shop.id, sourcePageKey: `test:later:${namespace}`, followerCount: 1_300,
      categoryIds: ["beauty"], sourceFetchedAt: new Date(), rawPayload: added as unknown as Prisma.InputJsonValue } });
    expect(await prisma.campaignRecipient.count({ where: { campaignId: small.id } })).toBe(before);
  });
});
