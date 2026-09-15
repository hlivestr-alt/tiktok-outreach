import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@affiliate/db";
import { DEFAULT_OUTREACH_MESSAGE_TEMPLATE } from "@affiliate/domain";
import { OutreachService } from "./outreach.service";
import { campaignDateKeyWib } from "./campaign-naming";

const prisma = new PrismaClient();
const stamp = () => `campaign_creation_${Date.now()}_${Math.random().toString(16).slice(2)}`;
let shopId = "";
let service: OutreachService;

const input = (overrides: Record<string, unknown> = {}) => ({
  targetCount: 1,
  candidateLimit: 1,
  cooldownDays: 0,
  filters: {},
  rankingMetric: "FOLLOWERS" as const,
  rankingDirection: "DESC" as const,
  ...overrides
});

beforeAll(async () => {
  const shop = await prisma.shop.create({ data: { name: stamp(), connectionMode: "MOCK", maxRecipientsPerCampaign: 500 } });
  shopId = shop.id;
  const openId = stamp();
  const creator = await prisma.creator.create({ data: { creatorOpenId: openId, username: "ayu", nickname: "Ayu Cántik 🇮🇩" } });
  await prisma.creatorProviderIdentity.create({ data: {
    creatorId: creator.id, identityType: "TIKTOK_CREATOR_OPEN_ID", identifier: openId,
    evidenceType: "CAMPAIGN_CREATION_TEST"
  } });
  await prisma.creatorMetricSnapshot.create({ data: {
    creatorId: creator.id, shopId, followerCount: 12_000, categoryIds: ["beauty"],
    gmvAmount: 100, gmvCurrency: "IDR", sourceFetchedAt: new Date()
  } });
  const unnamedOpenId = stamp();
  const unnamed = await prisma.creator.create({ data: { creatorOpenId: unnamedOpenId } });
  await prisma.creatorProviderIdentity.create({ data: {
    creatorId: unnamed.id, identityType: "TIKTOK_CREATOR_OPEN_ID", identifier: unnamedOpenId,
    evidenceType: "CAMPAIGN_CREATION_TEST"
  } });
  await prisma.creatorMetricSnapshot.create({ data: {
    creatorId: unnamed.id, shopId, followerCount: 11_000, categoryIds: ["beauty"],
    gmvAmount: 90, gmvCurrency: "IDR", sourceFetchedAt: new Date()
  } });
  const tiktok = {
    activeShop: async () => prisma.shop.findUniqueOrThrow({ where: { id: shopId } }),
    outboundCapability: async () => ({ mode: "MOCK", mutationCapability: true, available: true, workerState: "NOT_REQUIRED", reason: null })
  };
  service = new OutreachService(prisma as any, {} as any, tiktok as any);
});

afterAll(async () => {
  if (shopId) await prisma.shop.delete({ where: { id: shopId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe.sequential("new campaign creation defaults", () => {
  it("accepts no client name/product/message and stores canonical defaults", async () => {
    const campaign = await service.create(input());
    expect(campaign.name).toMatch(new RegExp(`^${campaignDateKeyWib(new Date())}_\\d{3,}$`));
    expect(campaign.productName).toBe("");
    expect(campaign.messageTemplate).toBe(DEFAULT_OUTREACH_MESSAGE_TEMPLATE);
    expect((await service.get(campaign.id)).name).toBe(campaign.name);
  });

  it("preserves an edited message and does not overwrite another draft's custom text", async () => {
    const historical = await prisma.campaign.create({ data: {
      shopId, name: stamp(), productName: "Legacy product", targetCount: 1, candidateLimit: 1,
      cooldownDays: 0, messageTemplate: "Historical custom draft", filters: {}, rankingMetric: "FOLLOWERS"
    } });
    const edited = "Halo khusus {{creator_display_name}} — pesan yang diedit";
    const campaign = await service.create(input({ messageTemplate: edited }));
    expect(campaign.messageTemplate).toBe(edited);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: historical.id } })).messageTemplate).toBe("Historical custom draft");
  });

  it("serializes simultaneous names in PostgreSQL", async () => {
    const campaigns = await Promise.all([service.create(input()), service.create(input())]);
    expect(new Set(campaigns.map((campaign) => campaign.name)).size).toBe(2);
    const sequences = campaigns.map((campaign) => Number(campaign.name.split("_")[1])).sort((a, b) => a - b);
    expect(sequences[1]).toBe(sequences[0] + 1);
  });

  it("owns production GMV currency on the server and ignores no client currency option", async () => {
    const campaign = await service.create(input({
      filters: { minGmv: 0, maxGmv: 100 }, rankingMetric: "GMV"
    }));
    expect(campaign.filters).toMatchObject({ minGmv: 0, maxGmv: 100, gmvCurrency: "USD" });
  });

  it("returns validation errors instead of storing invalid cooldowns", async () => {
    for (const cooldownDays of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 100_000_001]) {
      await expect(service.create(input({ cooldownDays }))).rejects.toThrow("Contact cooldown must be a whole number");
    }
  });

  it("previews without name/product and keeps equivalent-filter eligibility unchanged", async () => {
    const withoutProduct = await service.create(input({ messageTemplate: "Hi {{creator_display_name}}" }));
    const withLegacyProduct = await service.create(input({ productName: "Legacy product", messageTemplate: "Hi {{creator_display_name}}" }));
    await service.discover(withoutProduct.id);
    await service.discover(withLegacyProduct.id);
    const [first, second] = await Promise.all([service.preview(withoutProduct.id), service.preview(withLegacyProduct.id)]);
    expect(first?.state).toBe("PREVIEW_READY");
    expect(first?.recipients.map((recipient) => [recipient.creatorId, recipient.selected, recipient.skipReason])).toEqual(
      second?.recipients.map((recipient) => [recipient.creatorId, recipient.selected, recipient.skipReason])
    );
  });

  it("freezes Unicode names and the existing missing-name fallback into immutable messages", async () => {
    const campaign = await service.create(input({ targetCount: 2, candidateLimit: 2 }));
    await service.discover(campaign.id);
    const ready = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    await service.freeze(campaign.id, ready.version);
    const recipients = await prisma.campaignRecipient.findMany({ where: { campaignId: campaign.id }, include: { creator: true } });
    expect(recipients.find((recipient) => recipient.creator.nickname === "Ayu Cántik 🇮🇩")?.frozenMessage)
      .toContain("Halo kak Ayu Cántik 🇮🇩");
    expect(recipients.find((recipient) => !recipient.creator.nickname && !recipient.creator.username)?.frozenMessage)
      .toContain("Halo kak there");
    await prisma.campaign.update({ where: { id: campaign.id }, data: { messageTemplate: "Changed after freeze" } });
    expect((await prisma.campaignRecipient.findMany({ where: { campaignId: campaign.id } })).every((recipient) =>
      recipient.frozenMessage?.startsWith("Halo kak ")
    )).toBe(true);
  });
});
