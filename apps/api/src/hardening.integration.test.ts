import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockCreatorEligibility, PrismaClient } from "@affiliate/db";
import { Queue } from "bullmq";
import type { TikTokAffiliateAdapter } from "@affiliate/contracts";
import { MockTikTokAffiliateAdapter } from "@affiliate/tiktok-adapter";
import { OutreachService } from "./outreach/outreach.service";
import { HistoryService } from "./history/history.service";
import { ensureMockShop, expireFrozenCampaigns, reconcileOutbox } from "./shared";
import { reserveDispatchSlot, SafetyDelay, shopDate } from "../../worker/src/dispatch-safety";
import { deliveryAction, recoverDispatchingDelivery } from "../../worker/src/delivery-policy";
import { createHash } from "node:crypto";
import { TikTokIntegrationService } from "./integrations/tiktok.service";

const prisma = new PrismaClient();
const tiktokStub = { activeShop: () => ensureMockShop(prisma as any), adapter: async () => new MockTikTokAffiliateAdapter() } as any;
const testIds = new Set<string>();
const stamp = () => `hardening_${Date.now()}_${Math.random().toString(16).slice(2)}`;

async function createShop(overrides: Partial<{ maxRecipientsPerCampaign: number; maxDispatchesPerMinute: number }> = {}) {
  const shop = await prisma.shop.create({ data: {
    name: stamp(), connectionMode: "MOCK", maxRecipientsPerCampaign: 1000,
    maxDispatchesPerMinute: 1000, ...overrides
  } });
  testIds.add(shop.id);
  return shop;
}

async function createRecipient(shopId: string, campaignState: any = "PREVIEW_READY", creatorOpenId = stamp(), campaignOverrides: Record<string, unknown> = {}) {
  const creator = await prisma.creator.upsert({ where: { creatorOpenId }, update: {}, create: { creatorOpenId, selectionRegion: "ID" } });
  const snapshot = await prisma.creatorMetricSnapshot.create({ data: {
    creatorId: creator.id, followerCount: 1000, categoryIds: ["beauty"], gmvAmount: 100, gmvCurrency: "IDR",
    unitsSold: 10, avgVideoViews: 100, avgLiveViewers: 10, sourceFetchedAt: new Date()
  } });
  const campaign = await prisma.campaign.create({ data: {
    shopId, name: stamp(), productName: "Mock product", targetCount: 1, candidateLimit: 1, cooldownDays: 30,
    messageTemplate: "Hi {{creator_display_name}}", filters: {}, rankingMetric: "GMV", state: campaignState,
    summary: { requested: 1, eligible: 1, selected: 1, shortfall: 0 }, ...campaignOverrides
  } });
  const recipient = await prisma.campaignRecipient.create({ data: {
    campaignId: campaign.id, creatorId: creator.id, snapshotId: snapshot.id, discoveryOrdinal: 1,
    eligibility: "ELIGIBLE", rankingValue: 100, selected: true, state: campaignState === "PREVIEW_READY" ? "SELECTED" : "QUEUED",
    frozenMessage: campaignState === "PREVIEW_READY" ? null : "Hi creator", contentHash: campaignState === "PREVIEW_READY" ? null : "hash"
  } });
  return { shop: await prisma.shop.findUniqueOrThrow({ where: { id: shopId } }), creator, snapshot, campaign, recipient };
}

async function addDelivery(seed: Awaited<ReturnType<typeof createRecipient>>, state: any = "PENDING") {
  const delivery = await prisma.outreachDelivery.create({ data: {
    campaignId: seed.campaign.id, campaignRecipientId: seed.recipient.id,
    deterministicKey: `${seed.campaign.id}:${seed.creator.id}`, contentHash: "hash", state
  } });
  await prisma.outreachReservation.upsert({
    where: { campaignRecipientId: seed.recipient.id }, update: {},
    create: { shopId: seed.campaign.shopId, creatorId: seed.creator.id, campaignRecipientId: seed.recipient.id, expiresAt: new Date("9999-12-31T23:59:59.999Z") }
  });
  return delivery;
}

beforeAll(async () => { await ensureMockShop(prisma as any); });
afterAll(async () => {
  for (const id of testIds) await prisma.shop.delete({ where: { id } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("TikTok authorization state persistence", () => {
  it("rejects mismatched, expired, and reused states before any token request", async () => {
    const service = new TikTokIntegrationService(prisma as any);
    await expect(service.callback({ state: stamp(), code: "code" })).rejects.toThrow(/does not match/i);
    const expired = stamp();
    await prisma.tikTokAuthorizationState.create({ data: { stateHash: createHash("sha256").update(expired).digest("hex"), expiresAt: new Date(Date.now() - 1000) } });
    await expect(service.callback({ state: expired, code: "code" })).rejects.toThrow(/expired/i);
    const reused = stamp();
    await prisma.tikTokAuthorizationState.create({ data: { stateHash: createHash("sha256").update(reused).digest("hex"), expiresAt: new Date(Date.now() + 60_000), consumedAt: new Date() } });
    await expect(service.callback({ state: reused, code: "code" })).rejects.toThrow(/already used/i);
  });
});

describe.sequential("PostgreSQL campaign reservation safety", () => {
  it("serializes concurrent campaign freezes and reserves a creator only once", async () => {
    const shop = await createShop();
    const creatorId = stamp();
    const first = await createRecipient(shop.id, "PREVIEW_READY", creatorId);
    const second = await createRecipient(shop.id, "PREVIEW_READY", creatorId);
    const service = new OutreachService(prisma as any, { reconcile: async () => ({ enqueued: 0, failed: 0 }) } as any, tiktokStub);
    await Promise.all([service.freeze(first.campaign.id, 1), service.freeze(second.campaign.id, 1)]);
    expect(await prisma.outreachReservation.count({ where: { shopId: shop.id, creatorId: first.creator.id } })).toBe(1);
    expect(await prisma.campaignRecipient.count({ where: { campaignId: { in: [first.campaign.id, second.campaign.id] }, selected: true } })).toBe(1);
  });

  it("re-checks cooldown that appears between preview and freeze", async () => {
    const shop = await createShop();
    const seed = await createRecipient(shop.id);
    await prisma.creatorShopContactState.create({ data: { shopId: shop.id, creatorId: seed.creator.id, contactCount: 1, lastContactedAt: new Date() } });
    const service = new OutreachService(prisma as any, { reconcile: async () => ({ enqueued: 0, failed: 0 }) } as any, tiktokStub);
    const frozen = await service.freeze(seed.campaign.id, 1);
    expect(frozen.state).toBe("PREVIEW_EXPIRED");
    expect(frozen.freezeExpiresAt).toBeNull();
    expect((frozen.summary as any).selected).toBe(0);
    expect((frozen.summary as any).freezeAdjustment).toBe(1);
    expect(await prisma.outreachReservation.count({ where: { shopId: shop.id } })).toBe(0);
    expect(await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: seed.recipient.id } })).toMatchObject({ selected: false, skipReason: "COOLDOWN" });
  });

  it("serializes freeze with an overlapping contact-history mutation", async () => {
    const shop = await createShop();
    const seed = await createRecipient(shop.id);
    const service = new OutreachService(prisma as any, { reconcile: async () => ({ enqueued: 0, failed: 0 }) } as any, tiktokStub);
    let locked!: () => void;
    let release!: () => void;
    const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const mutation = prisma.$transaction(async (tx) => {
      await lockCreatorEligibility(tx, shop.id, [seed.creator.id]);
      locked();
      await releasePromise;
      await tx.creatorShopContactState.create({ data: {
        shopId: shop.id, creatorId: seed.creator.id, contactCount: 1,
        firstContactedAt: new Date(), lastContactedAt: new Date(), historyCoverageStart: new Date()
      } });
    });
    await lockedPromise;
    const freezing = service.freeze(seed.campaign.id, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all([mutation, freezing]);
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: seed.campaign.id } })).toMatchObject({ state: "PREVIEW_EXPIRED" });
    expect(await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: seed.recipient.id } })).toMatchObject({ selected: false, skipReason: "COOLDOWN" });
    expect(await prisma.outreachReservation.count({ where: { campaignRecipientId: seed.recipient.id } })).toBe(0);
  });

  it("expires frozen reservations idempotently and makes the campaign unstartable", async () => {
    const shop = await createShop();
    const seed = await createRecipient(shop.id, "FROZEN", stamp(), { freezeExpiresAt: new Date(Date.now() - 1000) });
    await prisma.campaignRecipient.update({ where: { id: seed.recipient.id }, data: { state: "RESERVED" } });
    await prisma.outreachReservation.create({ data: { shopId: shop.id, creatorId: seed.creator.id, campaignRecipientId: seed.recipient.id, expiresAt: new Date(Date.now() - 1000) } });
    expect(await expireFrozenCampaigns(prisma)).toBe(1);
    await expireFrozenCampaigns(prisma);
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: seed.campaign.id } })).toMatchObject({ state: "PREVIEW_EXPIRED" });
    expect(await prisma.outreachReservation.count({ where: { shopId: shop.id } })).toBe(0);
    const service = new OutreachService(prisma as any, { reconcile: async () => ({ enqueued: 0, failed: 0 }) } as any, tiktokStub);
    await expect(service.start(seed.campaign.id, { version: 2, confirmationName: seed.campaign.name, confirmationCount: 1 })).rejects.toThrow("stale or expired");
  });
});

describe.sequential("durable queue outbox", () => {
  it("recovers a partial Redis enqueue failure with deterministic jobs", async () => {
    const shop = await createShop();
    const seeds = [await createRecipient(shop.id, "QUEUED"), await createRecipient(shop.id, "QUEUED")];
    for (const seed of seeds) {
      const delivery = await addDelivery(seed);
      await prisma.queueOutbox.create({ data: { campaignId: seed.campaign.id, deliveryId: delivery.id, recipientId: seed.recipient.id, deterministicJobId: `send-${seed.recipient.id}` } });
    }
    const jobs = new Map<string, any>();
    let calls = 0;
    const flaky = {
      getJob: async (id: string) => jobs.get(id),
      add: async (_name: string, data: any, options: any) => {
        calls++;
        if (calls === 2) throw new Error("REDIS_UNAVAILABLE");
        const job = { id: options.jobId, data, getState: async () => "waiting", remove: async () => jobs.delete(options.jobId) };
        jobs.set(options.jobId, job); return job;
      }
    };
    expect(await reconcileOutbox(prisma, flaky as any)).toMatchObject({ enqueued: 1, failed: 1 });
    await prisma.queueOutbox.updateMany({ where: { campaignId: { in: seeds.map((item) => item.campaign.id) } }, data: { availableAt: new Date(0) } });
    const healthy = { ...flaky, add: async (_name: string, data: any, options: any) => {
      const job = { id: options.jobId, data, getState: async () => "waiting", remove: async () => jobs.delete(options.jobId) };
      jobs.set(options.jobId, job); return job;
    } };
    await reconcileOutbox(prisma, healthy as any);
    expect(jobs.size).toBe(2);
    expect(await prisma.queueOutbox.count({ where: { campaignId: { in: seeds.map((item) => item.campaign.id) }, state: "ENQUEUED" } })).toBe(2);
  });

  it("reconciles idempotently against real Redis/BullMQ", async () => {
    const shop = await createShop();
    const seed = await createRecipient(shop.id, "QUEUED");
    const delivery = await addDelivery(seed);
    await prisma.queueOutbox.create({ data: { campaignId: seed.campaign.id, deliveryId: delivery.id, recipientId: seed.recipient.id, deterministicJobId: `send-${seed.recipient.id}` } });
    const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
    const testQueue = new Queue(`outreach-hardening-${stamp()}`, { connection: { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), password: redisUrl.password || undefined } });
    try {
      await reconcileOutbox(prisma, testQueue);
      await reconcileOutbox(prisma, testQueue);
      expect((await testQueue.getJobs(["waiting", "delayed", "active"])).filter((job) => job.id === `send-${seed.recipient.id}`)).toHaveLength(1);
    } finally {
      await testQueue.obliterate({ force: true });
      await testQueue.close();
    }
  });

  it("does not recreate jobs across repeated reconciliation for SAFETY_PAUSED campaigns", async () => {
    const shop = await createShop();
    const seed = await createRecipient(shop.id, "SAFETY_PAUSED");
    const delivery = await addDelivery(seed);
    await prisma.queueOutbox.create({ data: {
      campaignId: seed.campaign.id, deliveryId: delivery.id, recipientId: seed.recipient.id,
      deterministicJobId: `send-${seed.recipient.id}`, state: "PENDING"
    } });
    let adds = 0;
    const queue = { getJob: async () => undefined, add: async (_name: string, data: { recipientId: string }) => {
      if (data.recipientId === seed.recipient.id) adds++;
    } };
    await reconcileOutbox(prisma, queue as any);
    await reconcileOutbox(prisma, queue as any);
    await reconcileOutbox(prisma, queue as any);
    expect(adds).toBe(0);
    expect(await prisma.queueOutbox.count({ where: { campaignId: seed.campaign.id } })).toBe(1);
    expect(await prisma.queueOutbox.findUniqueOrThrow({ where: { recipientId: seed.recipient.id } })).toMatchObject({ state: "PENDING", enqueueAttempts: 0 });
  });
});

describe.sequential("recipient-driven dispatch capacity and delivery policy", () => {
  it("does not use the campaign dispatch counter as a recipient-processing ceiling", async () => {
    const shop = await createShop({ maxRecipientsPerCampaign: 1000 });
    const seed = await createRecipient(shop.id, "QUEUED", stamp(), { dispatchCount: 10_000 });
    const delivery = await addDelivery(seed);
    const recipient = { ...seed.recipient, campaignId: seed.campaign.id, campaign: { ...seed.campaign, shopId: shop.id }, delivery };
    expect(await reserveDispatchSlot(prisma, recipient)).toMatchObject({ claimed: true });
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: seed.campaign.id } })).toMatchObject({ state: "RUNNING", dispatchCount: 10_001 });
  });

  it("keeps transient retries separate from the number of distinct recipients", async () => {
    const shop = await createShop({ maxRecipientsPerCampaign: 1 });
    const seed = await createRecipient(shop.id, "QUEUED");
    let delivery = await addDelivery(seed);
    let recipient: any = { ...seed.recipient, campaignId: seed.campaign.id, campaign: { ...seed.campaign, shopId: shop.id }, delivery };
    expect((await reserveDispatchSlot(prisma, recipient)).claimed).toBe(true);
    delivery = await prisma.outreachDelivery.update({ where: { id: delivery.id }, data: { state: "FAILED_RETRYABLE" } });
    await prisma.campaignRecipient.update({ where: { id: seed.recipient.id }, data: { state: "QUEUED" } });
    recipient.delivery = delivery;
    expect((await reserveDispatchSlot(prisma, recipient)).claimed).toBe(true);
    delivery = await prisma.outreachDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    delivery = await prisma.outreachDelivery.update({ where: { id: delivery.id }, data: { state: "FAILED_RETRYABLE" } });
    await prisma.campaignRecipient.update({ where: { id: seed.recipient.id }, data: { state: "QUEUED" } });
    recipient.delivery = delivery;
    expect((await reserveDispatchSlot(prisma, recipient)).claimed).toBe(true);
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: seed.campaign.id } })).toMatchObject({ state: "RUNNING", dispatchCount: 3 });
  });

  it("records daily dispatch usage without blocking while preserving the rolling-minute pacing ceiling", async () => {
    const dailyShop = await createShop();
    const daily = await createRecipient(dailyShop.id, "QUEUED");
    const dailyDelivery = await addDelivery(daily);
    const date = shopDate(new Date(), dailyShop.timezone);
    await prisma.shopOutboundDailyUsage.create({ data: { shopId: dailyShop.id, shopDate: date, dispatchCount: 10_000 } });
    await expect(reserveDispatchSlot(prisma, { ...daily.recipient, campaignId: daily.campaign.id, campaign: { ...daily.campaign, shopId: dailyShop.id }, delivery: dailyDelivery })).resolves.toMatchObject({ claimed: true });
    expect(await prisma.shopOutboundDailyUsage.findUniqueOrThrow({ where: { shopId_shopDate: { shopId: dailyShop.id, shopDate: date } } })).toMatchObject({ dispatchCount: 10_001 });

    const minuteShop = await createShop({ maxDispatchesPerMinute: 1 });
    const first = await createRecipient(minuteShop.id, "QUEUED");
    const firstDelivery = await addDelivery(first);
    await prisma.outboundDispatchEvent.create({ data: { shopId: minuteShop.id, campaignId: first.campaign.id, deliveryId: firstDelivery.id, dispatchedAt: new Date() } });
    await expect(reserveDispatchSlot(prisma, { ...first.recipient, campaignId: first.campaign.id, campaign: { ...first.campaign, shopId: minuteShop.id }, delivery: firstDelivery })).rejects.toBeInstanceOf(SafetyDelay);
  });

  it("skips duplicate executions and never sends DELIVERY_UNKNOWN again", () => {
    expect(deliveryAction("SENT")).toBe("SKIP");
    expect(deliveryAction("DELIVERY_UNKNOWN")).toBe("SKIP");
    expect(deliveryAction("DELIVERY_UNKNOWN_UNRESOLVED")).toBe("SKIP");
  });

  it("allows only one concurrent claim for duplicate BullMQ execution", async () => {
    const shop = await createShop();
    const seed = await createRecipient(shop.id, "QUEUED");
    const delivery = await addDelivery(seed);
    const recipient = { ...seed.recipient, campaignId: seed.campaign.id, campaign: { ...seed.campaign, shopId: shop.id }, delivery };
    const claims = await Promise.all([reserveDispatchSlot(prisma, recipient), reserveDispatchSlot(prisma, recipient)]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: seed.campaign.id } })).dispatchCount).toBe(1);
  });

  it("cancels an unsafe recipient before claim without consuming a dispatch attempt", async () => {
    const shop = await createShop();
    const seed = await createRecipient(shop.id, "QUEUED");
    const delivery = await addDelivery(seed);
    await prisma.queueOutbox.create({ data: {
      campaignId: seed.campaign.id, deliveryId: delivery.id, recipientId: seed.recipient.id,
      deterministicJobId: `send-${seed.recipient.id}`, state: "ENQUEUED"
    } });
    await prisma.creatorShopContactState.create({ data: { shopId: shop.id, creatorId: seed.creator.id, doNotContact: true } });
    const recipient = { ...seed.recipient, campaignId: seed.campaign.id, campaign: { ...seed.campaign, shopId: shop.id }, delivery };
    expect(await reserveDispatchSlot(prisma, recipient)).toMatchObject({ claimed: false, cancelled: true, reason: "DO_NOT_CONTACT" });
    expect(await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: seed.recipient.id } })).toMatchObject({ state: "CANCELLED", skipReason: "DO_NOT_CONTACT" });
    expect(await prisma.outreachDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({ state: "FAILED_TERMINAL", attemptCount: 0 });
    expect(await prisma.outboundDispatchEvent.count({ where: { deliveryId: delivery.id } })).toBe(0);
    expect(await prisma.outreachReservation.count({ where: { campaignRecipientId: seed.recipient.id } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { campaignId: seed.campaign.id, eventType: "RECIPIENT_CANCELLED_PRE_DISPATCH" } })).toBe(1);
  });

  it("turns a DISPATCHING delivery left by worker restart into DELIVERY_UNKNOWN", async () => {
    const shop = await createShop();
    const seed = await createRecipient(shop.id, "QUEUED");
    const delivery = await addDelivery(seed, "DISPATCHING");
    await recoverDispatchingDelivery(prisma, { ...seed.recipient, campaign: { ...seed.campaign, shop: { id: shop.id }, shopId: shop.id }, delivery });
    expect(await prisma.outreachDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({ state: "DELIVERY_UNKNOWN" });
    expect(await prisma.creatorShopContactState.findUniqueOrThrow({ where: { shopId_creatorId: { shopId: shop.id, creatorId: seed.creator.id } } })).toMatchObject({ unresolvedDelivery: true });
  });
});

describe.sequential("historical import identity and paged sync", () => {
  it("uses explicit source identity to deduplicate the same stable record id", async () => {
    const service = new HistoryService(prisma as any, tiktokStub);
    const sourceRecordId = stamp();
    const creatorOpenId = stamp();
    const header = "external_source,source_record_id,creator_open_id,contacted_at,send_status,campaign_name\n";
    await service.importCsv({ sourceName: "first.csv", csv: `${header}affiliate-crm,${sourceRecordId},${creatorOpenId},2026-01-05T00:00:00Z,SENT,first\n` });
    const duplicate = await service.importCsv({ sourceName: "second.csv", csv: `${header}affiliate-crm,${sourceRecordId},${creatorOpenId},2026-01-05T00:00:00Z,SENT,second\n` });
    expect(duplicate.duplicateCount).toBe(1);
    const shop = await ensureMockShop(prisma as any);
    expect(await prisma.historicalContactFact.count({ where: { shopId: shop.id, identityKey: `source:affiliate-crm:${sourceRecordId}` } })).toBe(1);
  });

  it("keeps equal stable record ids from different implicit filename sources distinct", async () => {
    const service = new HistoryService(prisma as any, tiktokStub);
    const sourceRecordId = stamp();
    const creatorOpenId = stamp();
    const header = "source_record_id,creator_open_id,contacted_at,send_status,campaign_name\n";
    await service.importCsv({ sourceName: "old_tiktok_export.csv", csv: `${header}${sourceRecordId},${creatorOpenId},2026-01-06T00:00:00Z,SENT,tiktok-export\n` });
    const second = await service.importCsv({ sourceName: "affiliate_crm_export.csv", csv: `${header}${sourceRecordId},${creatorOpenId},2026-01-06T00:00:00Z,SENT,crm-export\n` });
    expect(second.duplicateCount).toBe(0);
    const shop = await ensureMockShop(prisma as any);
    expect(await prisma.historicalContactFact.count({ where: {
      shopId: shop.id, sourceRecordId, externalSource: { in: ["old_tiktok_export.csv", "affiliate_crm_export.csv"] }
    } })).toBe(2);
  });

  it("deduplicates different filenames when both declare the same external source", async () => {
    const service = new HistoryService(prisma as any, tiktokStub);
    const sourceRecordId = stamp();
    const creatorOpenId = stamp();
    const header = "external_source,source_record_id,creator_open_id,contacted_at,send_status,campaign_name\n";
    await service.importCsv({ sourceName: "export-a.csv", csv: `${header}shared-system,${sourceRecordId},${creatorOpenId},2026-01-07T00:00:00Z,SENT,a\n` });
    const duplicate = await service.importCsv({ sourceName: "export-b.csv", csv: `${header}shared-system,${sourceRecordId},${creatorOpenId},2026-01-07T00:00:00Z,SENT,b\n` });
    expect(duplicate.duplicateCount).toBe(1);
    const shop = await ensureMockShop(prisma as any);
    expect(await prisma.historicalContactFact.count({ where: { shopId: shop.id, identityKey: `source:shared-system:${sourceRecordId}` } })).toBe(1);
  });

  it("deduplicates the same provider message across files and reordered CSVs", async () => {
    const service = new HistoryService(prisma as any, tiktokStub);
    const id = stamp();
    const creator = stamp();
    const header = "external_source,external_message_id,source_record_id,creator_open_id,contacted_at,send_status,campaign_name\n";
    await service.importCsv({ sourceName: "first.csv", csv: `${header}tiktok,${id},one,${creator},2026-01-01T00:00:00Z,SENT,first-export\n` });
    const duplicate = await service.importCsv({ sourceName: "different-file.csv", csv: `${header}tiktok,${id},one,${creator},2026-01-01T00:00:00Z,SENT,second-export\n` });
    expect(duplicate.duplicateCount).toBe(1);
    const shop = await ensureMockShop(prisma as any);
    expect(await prisma.historicalContactFact.count({ where: { shopId: shop.id, identityKey: `message:tiktok:${id}` } })).toBe(1);
    const dbCreator = await prisma.creator.findUniqueOrThrow({ where: { creatorOpenId: creator } });
    expect((await prisma.creatorShopContactState.findUniqueOrThrow({ where: { shopId_creatorId: { shopId: shop.id, creatorId: dbCreator.id } } })).contactCount).toBe(1);

    const a = stamp(), b = stamp(), reorderedCreator = stamp();
    const bySourceHeader = "source_system,source_record_id,creator_open_id,contacted_at,send_status\n";
    await service.importCsv({ sourceName: "ordered.csv", csv: `${bySourceHeader}erp,${a},${reorderedCreator},2026-01-02T00:00:00Z,SENT\nerp,${b},${reorderedCreator},2026-01-03T00:00:00Z,SENT\n` });
    const reordered = await service.importCsv({ sourceName: "reordered.csv", csv: `${bySourceHeader}erp,${b},${reorderedCreator},2026-01-03T00:00:00Z,SENT\nerp,${a},${reorderedCreator},2026-01-02T00:00:00Z,SENT\n` });
    expect(reordered.duplicateCount).toBe(2);
    const reorderedDbCreator = await prisma.creator.findUniqueOrThrow({ where: { creatorOpenId: reorderedCreator } });
    expect((await prisma.creatorShopContactState.findUniqueOrThrow({ where: { shopId_creatorId: { shopId: shop.id, creatorId: reorderedDbCreator.id } } })).contactCount).toBe(2);
  });

  it("lets a corrected import supersede an earlier unresolved row", async () => {
    const service = new HistoryService(prisma as any, tiktokStub);
    const sourceRecord = stamp();
    const creator = stamp();
    const header = "source_system,source_record_id,creator_open_id,contacted_at,send_status\n";
    await service.importCsv({ sourceName: "bad.csv", csv: `${header}erp,${sourceRecord},,2026-02-01T00:00:00Z,SENT\n` });
    await service.importCsv({ sourceName: "corrected.csv", csv: `${header}erp,${sourceRecord},${creator},2026-02-01T00:00:00Z,SENT\n` });
    const shop = await ensureMockShop(prisma as any);
    const rows = await prisma.historicalContactRecord.findMany({ where: { shopId: shop.id, identityKey: `source:erp:${sourceRecord}` }, orderBy: { id: "asc" } });
    expect(rows.map((row) => row.resolutionState).sort()).toEqual(["MATCHED", "SUPERSEDED"]);
    expect((await prisma.historicalContactFact.findUniqueOrThrow({ where: { shopId_identityKey: { shopId: shop.id, identityKey: `source:erp:${sourceRecord}` } } })).creatorOpenId).toBe(creator);
  });

  it("persists page cursors, survives interruption, and resumes idempotently to exhaustion", async () => {
    const prefix = stamp();
    let shouldFail = true;
    const conversations = [{ id: `${prefix}_c1`, creatorOpenId: `${prefix}_u1`, creatorImId: `${prefix}_im1` }, { id: `${prefix}_c2`, creatorOpenId: `${prefix}_u2`, creatorImId: `${prefix}_im2` }];
    const adapter: TikTokAffiliateAdapter = {
      getCapabilities: () => new MockTikTokAffiliateAdapter().getCapabilities(),
      searchCreators: (...args: any[]) => (new MockTikTokAffiliateAdapter().searchCreators as any)(...args),
      getCreatorPerformance: (id) => new MockTikTokAffiliateAdapter().getCreatorPerformance(id),
      createOrGetConversation: async (id) => ({ conversationId: `${prefix}_${id}`, isNew: false }),
      sendMessage: async () => { throw new Error("not used"); },
      listConversations: async ({ pageToken } = { pageSize: 1 }) => {
        const index = Number(pageToken ?? 0); return { items: conversations.slice(index, index + 1), nextPageToken: index === 0 ? "1" : undefined, hasMore: index === 0 };
      },
      listMessages: async (conversationId) => {
        if (conversationId.endsWith("c2") && shouldFail) { shouldFail = false; throw new Error("INTERRUPTED"); }
        const creatorOpenId = conversations.find((item) => item.id === conversationId)!.creatorOpenId;
        return { items: [{ id: `${conversationId}_m1`, conversationId, creatorOpenId, direction: "OUTBOUND", content: "history", createdAt: new Date("2026-03-01T00:00:00Z") }], hasMore: false };
      },
      getLatestUnreadMessages: async () => []
    };
    const source = `${prefix}_source`;
    const service = new HistoryService(prisma as any, tiktokStub);
    await expect(service.syncMockHistory(adapter, source)).rejects.toThrow("INTERRUPTED");
    const shop = await ensureMockShop(prisma as any);
    const partial = await prisma.contactHistorySyncRun.findFirstOrThrow({ where: { shopId: shop.id, source } });
    expect(partial.state).toBe("PARTIAL");
    expect(partial.cursor).not.toBeNull();
    const complete = await service.syncMockHistory(adapter, source);
    expect(complete).toMatchObject({ id: partial.id, state: "COMPLETE", conversationsScanned: 2, messagesImported: 2 });
    expect(await prisma.conversationMessage.count({ where: { externalMessageId: { startsWith: prefix } } })).toBe(2);
  });
});
