import { createHash } from "node:crypto";
import { DelayedError, Job, Queue, Worker } from "bullmq";
import { Prisma, PrismaClient } from "@affiliate/db";
import { loadConfig } from "@affiliate/config";
import { reconcileUnknownDelivery } from "@affiliate/domain";
import { MockTikTokAffiliateAdapter } from "@affiliate/tiktok-adapter";

const config = loadConfig();
const redisUrl = new URL(config.REDIS_URL);
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), password: redisUrl.password || undefined };
const prisma = new PrismaClient();
const adapter = new MockTikTokAffiliateAdapter();
const queue = new Queue("outreach", { connection });
const reconciliationDelays = config.MOCK_RECONCILIATION_DELAYS_MS.split(",").map(Number);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

class SafetyDelay extends Error {
  constructor(readonly delayMs: number, message: string) { super(message); }
}

const shopDate = (date: Date, timezone: string): Date => {
  const formatted = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return new Date(`${formatted}T00:00:00.000Z`);
};

async function delayJob(job: Job, delayMs: number): Promise<never> {
  if (!job.token) throw new Error("Active job has no token");
  await job.moveToDelayed(Date.now() + delayMs, job.token);
  throw new DelayedError();
}

async function reserveDispatchSlot(recipient: any): Promise<void> {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`outbound:${recipient.campaign.shopId}`}))`;
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: recipient.campaignId }, include: { shop: true } });
    if (campaign.dispatchCount >= campaign.shop.maxSendsPerCampaign) throw new SafetyDelay(86_400_000, "Campaign safety ceiling reached");
    const oneMinuteAgo = new Date(now.getTime() - 60_000);
    const recent = await tx.outboundDispatchEvent.count({ where: { shopId: campaign.shopId, dispatchedAt: { gt: oneMinuteAgo } } });
    if (recent >= campaign.shop.maxDispatchesPerMinute) throw new SafetyDelay(60_000, "Absolute dispatch-rate ceiling reached");
    const date = shopDate(now, campaign.shop.timezone);
    const usage = await tx.shopOutboundDailyUsage.findUnique({ where: { shopId_shopDate: { shopId: campaign.shopId, shopDate: date } } });
    if ((usage?.dispatchCount ?? 0) >= campaign.shop.maxSendsPerDay) throw new SafetyDelay(15 * 60_000, "Daily shop ceiling reached");
    await tx.shopOutboundDailyUsage.upsert({
      where: { shopId_shopDate: { shopId: campaign.shopId, shopDate: date } },
      update: { dispatchCount: { increment: 1 }, ceiling: campaign.shop.maxSendsPerDay },
      create: { shopId: campaign.shopId, shopDate: date, dispatchCount: 1, ceiling: campaign.shop.maxSendsPerDay }
    });
    await tx.outboundDispatchEvent.create({ data: { shopId: campaign.shopId, campaignId: campaign.id, deliveryId: recipient.delivery.id, dispatchedAt: now } });
    await tx.campaign.update({ where: { id: campaign.id }, data: { dispatchCount: { increment: 1 }, state: "RUNNING" } });
    await tx.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: {
      state: "DISPATCHING", firstDispatchedAt: recipient.delivery.firstDispatchedAt ?? now, attemptCount: { increment: 1 }
    } });
    await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "PROCESSING" } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function markSent(recipient: any, conversationId: string, externalMessageId: string, requestId?: string) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const previous = await tx.creatorShopContactState.findUnique({ where: { shopId_creatorId: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId } } });
    await tx.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: { state: "SENT", conversationId, externalMessageId, providerRequestId: requestId, sentAt: now } });
    await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "SENT" } });
    await tx.creatorShopContactState.upsert({
      where: { shopId_creatorId: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId } },
      update: { firstContactedAt: previous?.firstContactedAt ?? now, lastContactedAt: now, contactCount: { increment: 1 }, lastCampaignId: recipient.campaignId, lastDeliveryId: recipient.delivery.id, unresolvedDelivery: false },
      create: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId, firstContactedAt: now, lastContactedAt: now, contactCount: 1, lastCampaignId: recipient.campaignId, lastDeliveryId: recipient.delivery.id }
    });
    await tx.outreachReservation.deleteMany({ where: { campaignRecipientId: recipient.id } });
  });
}

async function scheduleReconciliation(deliveryId: string, attemptNumber: number) {
  const delay = reconciliationDelays[Math.min(attemptNumber - 1, reconciliationDelays.length - 1)] ?? 300_000;
  const scheduledFor = new Date(Date.now() + delay);
  await prisma.deliveryReconciliationRun.upsert({
    where: { deliveryId_attemptNumber: { deliveryId, attemptNumber } }, update: { scheduledFor },
    create: { deliveryId, attemptNumber, scheduledFor }
  });
  await queue.add("reconcile", { deliveryId, attemptNumber }, { jobId: `reconcile-${deliveryId}-${attemptNumber}`, delay, removeOnComplete: 1000 });
}

async function markTerminalFailure(recipient: any, errorCode: string, errorDetail: string) {
  await prisma.$transaction([
    prisma.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: {
      state: "FAILED_TERMINAL", lastErrorCode: errorCode, lastErrorDetail: errorDetail
    } }),
    prisma.campaignRecipient.update({ where: { id: recipient.id }, data: {
      state: "FAILED", skipReason: errorCode, skipDetail: errorDetail
    } }),
    prisma.outreachReservation.deleteMany({ where: { campaignRecipientId: recipient.id } })
  ]);
}

async function markDeliveryUnknown(recipient: any, attemptId: string, requestId: string | undefined, detail: string) {
  await prisma.$transaction([
    prisma.deliveryAttempt.update({ where: { id: attemptId }, data: {
      outcome: "DELIVERY_UNKNOWN", providerRequestId: requestId, providerCode: "DELIVERY_UNKNOWN", completedAt: new Date()
    } }),
    prisma.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: {
      state: "DELIVERY_UNKNOWN", providerRequestId: requestId, lastErrorCode: "DELIVERY_UNKNOWN", lastErrorDetail: detail
    } }),
    prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "DELIVERY_UNKNOWN" } }),
    prisma.creatorShopContactState.upsert({
      where: { shopId_creatorId: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId } },
      update: { unresolvedDelivery: true },
      create: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId, unresolvedDelivery: true }
    })
  ]);
  await scheduleReconciliation(recipient.delivery.id, 1);
}

async function completeCampaignIfDone(campaignId: string) {
  const unfinished = await prisma.campaignRecipient.count({ where: { campaignId, selected: true, state: { in: ["RESERVED", "QUEUED", "PROCESSING", "DELIVERY_UNKNOWN"] } } });
  if (unfinished) return;
  const failures = await prisma.campaignRecipient.count({ where: { campaignId, selected: true, state: { in: ["FAILED", "DELIVERY_UNKNOWN_UNRESOLVED"] } } });
  await prisma.campaign.update({ where: { id: campaignId }, data: { state: failures ? "COMPLETED_WITH_ERRORS" : "COMPLETED" } });
}

async function processSend(job: Job<{ recipientId: string }>) {
  const recipient = await prisma.campaignRecipient.findUnique({
    where: { id: job.data.recipientId },
    include: { creator: true, campaign: { include: { shop: true } }, delivery: true, reservation: true }
  });
  if (!recipient?.delivery || !recipient.frozenMessage || !recipient.contentHash) return;
  if (["SENT", "FAILED_TERMINAL", "DELIVERY_UNKNOWN", "DELIVERY_UNKNOWN_UNRESOLVED"].includes(recipient.delivery.state)) return;
  if (recipient.delivery.state === "DISPATCHING") {
    await prisma.$transaction([
      prisma.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: { state: "DELIVERY_UNKNOWN", lastErrorDetail: "Worker restarted after dispatch began" } }),
      prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "DELIVERY_UNKNOWN" } }),
      prisma.creatorShopContactState.upsert({ where: { shopId_creatorId: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId } }, update: { unresolvedDelivery: true }, create: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId, unresolvedDelivery: true } })
    ]);
    await scheduleReconciliation(recipient.delivery.id, 1);
    return;
  }
  if (["PAUSE_REQUESTED", "PAUSED"].includes(recipient.campaign.state)) {
    if (recipient.campaign.state === "PAUSE_REQUESTED") await prisma.campaign.update({ where: { id: recipient.campaignId }, data: { state: "PAUSED" } });
    return delayJob(job, 5000);
  }
  const providerConversation = await adapter.createOrGetConversation(recipient.creator.creatorOpenId);
  const conversation = await prisma.conversation.upsert({
    where: { externalConversationId: providerConversation.conversationId }, update: {},
    create: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId, externalConversationId: providerConversation.conversationId }
  });
  await prisma.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: { conversationId: conversation.id } });
  recipient.delivery.conversationId = conversation.id;
  try { await reserveDispatchSlot(recipient); }
  catch (error) { if (error instanceof SafetyDelay) return delayJob(job, error.delayMs); throw error; }

  const attemptNumber = recipient.delivery.attemptCount + 1;
  const attempt = await prisma.deliveryAttempt.create({ data: { deliveryId: recipient.delivery.id, attemptNumber, outcome: "STARTED", startedAt: new Date() } });
  let result: Awaited<ReturnType<typeof adapter.sendMessage>>;
  try {
    result = await adapter.sendMessage(providerConversation.conversationId, recipient.creator.creatorOpenId, recipient.frozenMessage);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Network outcome was not observable";
    await markDeliveryUnknown(recipient, attempt.id, undefined, detail);
    await completeCampaignIfDone(recipient.campaignId);
    return;
  }
  if (result.status === "SENT") {
    await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { outcome: "SENT", providerRequestId: result.requestId, completedAt: new Date() } });
    await markSent(recipient, conversation.id, result.messageId, result.requestId);
  } else if (result.status === "DELIVERY_UNKNOWN") {
    await markDeliveryUnknown(recipient, attempt.id, result.requestId, "Provider response did not establish whether the message was accepted");
    const numeric = Number(recipient.creator.creatorOpenId.slice(-5));
    if (numeric % 74 === 0) {
      await prisma.conversationMessage.create({ data: {
        conversationId: conversation.id, externalMessageId: `mock_reconciled_${recipient.delivery.id}`, direction: "OUTBOUND",
        content: recipient.frozenMessage, contentHash: recipient.contentHash, providerCreatedAt: new Date(), importSource: "MOCK_PROVIDER_RECONCILIATION"
      }});
    }
  } else if (result.status === "RESTRICTED") {
    await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: {
      outcome: "FAILED_TERMINAL", providerRequestId: result.requestId, providerCode: result.errorCode, completedAt: new Date()
    } });
    await markTerminalFailure(recipient, result.errorCode, "Creator cannot receive affiliate messages");
  } else {
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: {
      outcome: finalAttempt ? "FAILED_TERMINAL" : "FAILED_RETRYABLE", providerRequestId: result.requestId,
      providerCode: result.errorCode, completedAt: new Date()
    } });
    if (finalAttempt) {
      await markTerminalFailure(recipient, result.errorCode, "Retry budget exhausted without a confirmed dispatch");
    } else {
      await prisma.$transaction([
        prisma.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: {
          state: "FAILED_RETRYABLE", lastErrorCode: result.errorCode, lastErrorDetail: `Retry after ${result.retryAfterMs}ms`
        } }),
        prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "QUEUED" } })
      ]);
      throw new Error(result.errorCode);
    }
  }
  await completeCampaignIfDone(recipient.campaignId);
}

async function processReconciliation(job: Job<{ deliveryId: string; attemptNumber: number }>) {
  const delivery = await prisma.outreachDelivery.findUnique({
    where: { id: job.data.deliveryId },
    include: { conversation: { include: { messages: true } }, recipient: { include: { creator: true, campaign: { include: { shop: true } } } } }
  });
  if (!delivery || delivery.state !== "DELIVERY_UNKNOWN" || !delivery.conversation || !delivery.firstDispatchedAt) return;
  const linked = await prisma.outreachDelivery.findMany({ where: { externalMessageId: { not: null } }, select: { externalMessageId: true } });
  const result = reconcileUnknownDelivery({
    conversationId: delivery.conversation.externalConversationId,
    contentHash: delivery.contentHash,
    dispatchedAt: delivery.firstDispatchedAt,
    alreadyLinkedMessageIds: new Set(linked.flatMap((item) => item.externalMessageId ? [item.externalMessageId] : [])),
    messages: delivery.conversation.messages.map((message) => ({
      id: message.externalMessageId, conversationId: delivery.conversation!.externalConversationId,
      direction: message.direction, contentHash: message.contentHash, createdAt: message.providerCreatedAt
    }))
  });
  if (result.status === "MATCHED") {
    await prisma.deliveryReconciliationRun.update({ where: { deliveryId_attemptNumber: { deliveryId: delivery.id, attemptNumber: job.data.attemptNumber } }, data: { state: "MATCHED", matchedMessageId: result.messageId, completedAt: new Date(), evidence: { exactContentHash: true, uniqueMatch: true } } });
    await markSent({ ...delivery.recipient, delivery, campaign: delivery.recipient.campaign }, delivery.conversation.id, result.messageId, "mock-reconciliation");
  } else if (job.data.attemptNumber < 3) {
    await prisma.deliveryReconciliationRun.update({ where: { deliveryId_attemptNumber: { deliveryId: delivery.id, attemptNumber: job.data.attemptNumber } }, data: { state: "UNRESOLVED", completedAt: new Date(), evidence: { reason: result.reason } } });
    await scheduleReconciliation(delivery.id, job.data.attemptNumber + 1);
  } else {
    await prisma.$transaction([
      prisma.deliveryReconciliationRun.update({ where: { deliveryId_attemptNumber: { deliveryId: delivery.id, attemptNumber: job.data.attemptNumber } }, data: { state: "UNRESOLVED", completedAt: new Date(), evidence: { reason: result.reason } } }),
      prisma.outreachDelivery.update({ where: { id: delivery.id }, data: { state: "DELIVERY_UNKNOWN_UNRESOLVED", lastErrorDetail: result.reason } }),
      prisma.campaignRecipient.update({ where: { id: delivery.campaignRecipientId }, data: { state: "DELIVERY_UNKNOWN_UNRESOLVED" } })
    ]);
  }
  await completeCampaignIfDone(delivery.campaignId);
}

const worker = new Worker("outreach", async (job) => {
  if (job.name === "reconcile") return processReconciliation(job as Job<{ deliveryId: string; attemptNumber: number }>);
  return processSend(job as Job<{ recipientId: string }>);
}, {
  connection,
  concurrency: 4,
  limiter: { max: config.MAX_DISPATCHES_PER_MINUTE, duration: 60_000 }
});

worker.on("failed", (job, error) => console.error("Outreach job failed", { jobId: job?.id, error: error.message }));
worker.on("error", (error) => console.error("Worker error", { error: error.message }));
console.log("Mock outreach worker ready", { mode: config.APP_MODE, outboundProvider: "mock-only" });

async function shutdown() {
  await worker.close();
  await queue.close();
  await prisma.$disconnect();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
