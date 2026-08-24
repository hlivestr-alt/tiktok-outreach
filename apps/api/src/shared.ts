import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, PrismaClient } from "@affiliate/db";
import { loadConfig } from "@affiliate/config";
import { Queue } from "bullmq";

export const config = loadConfig();
const redis = new URL(config.REDIS_URL);
export const queueConnection = { host: redis.hostname, port: Number(redis.port || 6379), password: redis.password || undefined };

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> { await this.$disconnect(); }
}

type OutreachQueue = Pick<Queue, "add" | "getJob">;

export async function expireFrozenCampaigns(prisma: PrismaClient, now = new Date()): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const expired = await tx.campaign.findMany({ where: { state: "FROZEN", freezeExpiresAt: { lte: now } }, select: { id: true, shopId: true } });
    for (const campaign of expired) {
      const changed = await tx.campaign.updateMany({
        where: { id: campaign.id, state: "FROZEN", freezeExpiresAt: { lte: now } },
        data: { state: "PREVIEW_EXPIRED", version: { increment: 1 } }
      });
      if (!changed.count) continue;
      await tx.outreachReservation.deleteMany({ where: { recipient: { campaignId: campaign.id } } });
      await tx.campaignRecipient.updateMany({
        where: { campaignId: campaign.id, state: "RESERVED" },
        data: { state: "SELECTED", frozenMessage: null, contentHash: null }
      });
      await tx.auditEvent.create({ data: {
        shopId: campaign.shopId, campaignId: campaign.id, eventType: "CAMPAIGN_FREEZE_EXPIRED",
        payload: { expiredAt: now.toISOString(), reservationsReleased: true }
      } });
    }
    return expired.length;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 20_000 });
}

export async function reconcileOutbox(prisma: PrismaClient, outreach: OutreachQueue, limit = config.OUTBOUND_QUEUE_RECONCILE_BATCH_SIZE): Promise<{ enqueued: number; failed: number }> {
  if (config.OUTBOUND_MODE === "read_only") return { enqueued: 0, failed: 0 };
  const missing = await prisma.campaignRecipient.findMany({
    where: { state: "QUEUED", delivery: { isNot: null }, campaign: { state: { in: ["QUEUED", "RUNNING"] } } },
    include: { delivery: true }, take: limit
  });
  for (const recipient of missing) {
    if (!recipient.delivery) continue;
    await prisma.queueOutbox.upsert({
      where: { recipientId: recipient.id }, update: {},
      create: {
        campaignId: recipient.campaignId, deliveryId: recipient.delivery.id, recipientId: recipient.id,
        deterministicJobId: `send-${recipient.id}`
      }
    });
  }

  const entries = await prisma.queueOutbox.findMany({
    where: {
      state: { in: ["PENDING", "ENQUEUED"] }, availableAt: { lte: new Date() },
      campaign: { state: { in: ["QUEUED", "RUNNING"] } }, delivery: { recipient: { state: "QUEUED" } }
    },
    orderBy: { createdAt: "asc" }, take: limit
  });
  let enqueued = 0;
  let failed = 0;
  for (const entry of entries) {
    try {
      const existing = await outreach.getJob(entry.deterministicJobId);
      if (existing) {
        const state = await existing.getState();
        if (state === "completed" || state === "failed") await existing.remove();
        else {
          await prisma.queueOutbox.update({ where: { id: entry.id }, data: { state: "ENQUEUED", enqueuedAt: new Date(), lastError: null } });
          continue;
        }
      }
      await outreach.add(entry.jobName, { recipientId: entry.recipientId }, {
        jobId: entry.deterministicJobId, attempts: 4, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 1000
      });
      await prisma.queueOutbox.update({ where: { id: entry.id }, data: {
        state: "ENQUEUED", enqueuedAt: new Date(), enqueueAttempts: { increment: 1 }, lastError: null
      } });
      enqueued++;
    } catch (error) {
      failed++;
      await prisma.queueOutbox.update({ where: { id: entry.id }, data: {
        state: "PENDING", enqueueAttempts: { increment: 1 },
        availableAt: new Date(Date.now() + 5_000), lastError: error instanceof Error ? error.message : "Queue enqueue failed"
      } });
    }
  }
  return { enqueued, failed };
}

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  readonly outreach = new Queue("outreach", { connection: queueConnection });
  private timer?: NodeJS.Timeout;
  constructor(private readonly prisma: PrismaService) {}
  async onModuleInit(): Promise<void> {
    await expireFrozenCampaigns(this.prisma).catch((error) => console.error("Reservation expiry sweep failed", error));
    await reconcileOutbox(this.prisma, this.outreach).catch((error) => console.error("Outbox reconciliation failed", error));
    this.timer = setInterval(() => {
      void expireFrozenCampaigns(this.prisma).catch((error) => console.error("Reservation expiry sweep failed", error));
      void reconcileOutbox(this.prisma, this.outreach).catch((error) => console.error("Outbox reconciliation failed", error));
    }, config.OUTBOUND_QUEUE_POLL_INTERVAL_MS);
    this.timer.unref();
  }
  async reconcile(): Promise<{ enqueued: number; failed: number }> { return reconcileOutbox(this.prisma, this.outreach); }
  async onModuleDestroy(): Promise<void> { if (this.timer) clearInterval(this.timer); await this.outreach.close(); }
}

export async function ensureMockShop(prisma: PrismaService) {
  const existing = await prisma.shop.findFirst({ where: { connectionMode: "MOCK" }, orderBy: { createdAt: "asc" } });
  if (existing) return existing;
  return prisma.$transaction(async (tx) => {
    const shop = await tx.shop.create({ data: {
      name: "Indonesia Mock Shop", region: "ID", currency: "IDR", timezone: config.SHOP_TIMEZONE,
      connectionMode: "MOCK", maxRecipientsPerCampaign: config.MAX_RECIPIENTS_PER_CAMPAIGN
    } });
    await tx.safetySettingsAudit.create({ data: {
      shopId: shop.id, source: "ENVIRONMENT_INITIALIZATION_ONLY", effectiveValues: {
        maxRecipientsPerCampaign: shop.maxRecipientsPerCampaign,
        providerDrivenAdaptiveConcurrency: true,
        timezone: shop.timezone
      }
    } });
    return shop;
  });
}
