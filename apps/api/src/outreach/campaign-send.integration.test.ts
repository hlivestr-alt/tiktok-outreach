import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@affiliate/db";
import { DEFAULT_OUTREACH_MESSAGE_TEMPLATE } from "@affiliate/domain";
import { OutreachService } from "./outreach.service";

const prisma = new PrismaClient();
const stamp = () => `campaign_send_${Date.now()}_${Math.random().toString(16).slice(2)}`;

describe.sequential("500-recipient one-click Send", () => {
  let shopId = "";
  let service: OutreachService;
  const reconcile = vi.fn(async () => undefined);

  beforeAll(async () => {
    const namespace = stamp();
    const shop = await prisma.shop.create({
      data: { name: namespace, connectionMode: "MOCK", maxRecipientsPerCampaign: 500 }
    });
    shopId = shop.id;
    await prisma.creator.createMany({
      data: Array.from({ length: 500 }, (_, index) => ({
        creatorOpenId: `${namespace}-open-${index}`,
        username: `${namespace}-user-${index}`,
        nickname: index === 0 ? "Ayu Cantik 🇮🇩" : `Creator ${index}`
      }))
    });
    const creators = await prisma.creator.findMany({
      where: { creatorOpenId: { startsWith: `${namespace}-open-` } },
      orderBy: { creatorOpenId: "asc" }
    });
    await prisma.creatorProviderIdentity.createMany({
      data: creators.map((creator) => ({
        creatorId: creator.id,
        identityType: "TIKTOK_CREATOR_OPEN_ID",
        identifier: creator.creatorOpenId!,
        evidenceType: "CAMPAIGN_SEND_TEST"
      }))
    });
    await prisma.creatorMetricSnapshot.createMany({
      data: creators.map((creator, index) => ({
        creatorId: creator.id,
        shopId,
        followerCount: index * 2_500,
        categoryIds: ["beauty"],
        gmvAmount: index * 100,
        gmvCurrency: "USD",
        sourceFetchedAt: new Date()
      }))
    });
    const tiktok = {
      activeShop: async () => prisma.shop.findUniqueOrThrow({ where: { id: shopId } }),
      outboundCapability: async () => ({
        mode: "MOCK", mutationCapability: true, available: true, workerState: "NOT_REQUIRED", reason: null
      })
    };
    service = new OutreachService(prisma as any, { reconcile } as any, tiktok as any);
  }, 30_000);

  afterAll(async () => {
    if (shopId) await prisma.shop.delete({ where: { id: shopId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("freezes, snapshots, materializes, and idempotently sends 500-row mocked campaigns at 30/90/180/360 days", async () => {
    for (const cooldownDays of [30, 90, 180, 360]) {
      const campaign = await service.create({
        targetCount: 500,
        candidateLimit: 500,
        cooldownDays,
        messageTemplate: DEFAULT_OUTREACH_MESSAGE_TEMPLATE,
        filters: { minFollowers: 0, minGmv: 0 },
        rankingMetric: "GMV",
        rankingDirection: "DESC"
      });
      expect(campaign.productName).toBe("");
      expect(campaign.cooldownDays).toBe(cooldownDays);
      await service.discover(campaign.id);
      const ready = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });

      const first = await service.send(campaign.id, ready.version);
      const repeated = await service.send(campaign.id, ready.version);

      expect(first.state).toBe("QUEUED");
      expect(repeated.state).toBe("QUEUED");
      expect(first.progress.frozen).toBe(500);
      const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      expect(stored.cooldownDays).toBe(cooldownDays);
      expect(stored.frozenFilters).toMatchObject({ minFollowers: 0, minGmv: 0, gmvCurrency: "USD", cooldownDays });
      expect(stored.frozenContext).toMatchObject({ cooldownDays });
      expect(await prisma.campaignRecipient.count({
        where: { campaignId: campaign.id, selected: true, state: "QUEUED", frozenMessage: { not: null } }
      })).toBe(500);
      expect(await prisma.outreachDelivery.count({ where: { campaignId: campaign.id } })).toBe(500);
      expect(await prisma.queueOutbox.count({ where: { campaignId: campaign.id } })).toBe(500);
      expect(await prisma.queueOutbox.count({
        where: { campaignId: campaign.id, deterministicJobId: { startsWith: "send-" } }
      })).toBe(500);
      expect(new Set((await prisma.queueOutbox.findMany({
        where: { campaignId: campaign.id }, select: { deterministicJobId: true }
      })).map((row) => row.deterministicJobId)).size).toBe(500);
      expect((await prisma.campaignRecipient.findFirstOrThrow({
        where: { campaignId: campaign.id, creator: { nickname: "Ayu Cantik 🇮🇩" } }
      })).frozenMessage).toContain("Halo kak Ayu Cantik 🇮🇩");

      // Release this mocked campaign's reservations before exercising the next cooldown.
      await service.cancel(campaign.id);
    }
    expect(reconcile).toHaveBeenCalledTimes(4);
  }, 120_000);
});
