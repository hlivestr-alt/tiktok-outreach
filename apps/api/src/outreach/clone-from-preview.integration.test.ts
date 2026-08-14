import { afterAll, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@affiliate/db";
import type { CampaignCloneFromPreviewInput } from "@affiliate/contracts";
import type { CreatorCandidate, CreatorFilters } from "@affiliate/domain";
import { CreatorIdentityResolver } from "../identity/creator-identity-resolver.service";
import { rebuildLocalPreview } from "./local-preview";
import { OutreachService } from "./outreach.service";

const prisma = new PrismaClient();
const shopIds = new Set<string>();
const now = new Date("2026-08-13T00:00:00.000Z");
const stamp = () => `clone_${Date.now()}_${Math.random().toString(16).slice(2)}`;

function candidate(index: number): CreatorCandidate {
  return {
    creatorOpenId: `${stamp()}_open_${index}`, creatorUserId: `${stamp()}_user_${index}`,
    username: `creator.${index}`, nickname: `Creator ${index}`, categoryIds: [index === 0 ? "other" : "beauty"],
    followerCount: 10_000 + index, gmv: { amount: String(1_000 + index), currency: "IDR" },
    unitsSold: 100 + index, avgVideoViews: 1_000 + index, avgLiveViewers: 100 + index,
    engagementRate: 0.1, selectionRegion: "ID", discoveryOrdinal: index
  };
}

async function fixture(options: { state?: string; complete?: boolean; count?: number; target?: number; filters?: CreatorFilters } = {}) {
  const shop = await prisma.shop.create({ data: { name: stamp(), connectionMode: "READ_ONLY", selectedForReadOnly: false } });
  shopIds.add(shop.id);
  const candidates = Array.from({ length: options.count ?? 20 }, (_, index) => candidate(index));
  const identities = new CreatorIdentityResolver(prisma as any);
  for (const item of candidates) await identities.ensureMarketplaceCreator(item);
  const campaign = await prisma.campaign.create({ data: {
    shopId: shop.id, name: "Source preview", productName: "Original product", targetCount: options.target ?? 10,
    candidateLimit: candidates.length, cooldownDays: 30, messageTemplate: "Hi {{creator_display_name}}",
    filters: (options.filters ?? {}) as Prisma.InputJsonValue, rankingMetric: "FOLLOWERS", rankingDirection: "DESC",
    state: "DRAFT"
  } });
  const run = await prisma.discoveryRun.create({ data: {
    campaignId: campaign.id, shopId: shop.id, state: "BACKING_OFF", nextAttemptAt: new Date("2099-01-01T00:00:00.000Z"), requestedTarget: campaign.targetCount,
    candidateLimit: candidates.length, candidatesFetched: candidates.length, pagesFetched: 1,
    totalProviderRequests: 1, providerSearchKey: "raw-secret-search-key", providerNextPageToken: "raw-secret-page-token",
    providerHasMore: false
  } });
  for (const item of candidates) await prisma.discoveryCandidate.create({ data: {
    discoveryRunId: run.id, creatorOpenId: item.creatorOpenId, discoveryOrdinal: item.discoveryOrdinal,
    candidate: { ...item, searchKey: "must-not-copy", pageToken: "must-not-copy" } as unknown as Prisma.InputJsonValue
  } });
  if (options.complete !== false) await prisma.$transaction((tx) => rebuildLocalPreview(tx, run.id, now));
  else await prisma.discoveryRun.update({ where: { id: run.id }, data: { state: "FAILED", failureCategory: "TEST_INCOMPLETE" } });
  if (options.state && options.state !== "PREVIEW_READY") {
    await prisma.campaign.update({ where: { id: campaign.id }, data: { state: options.state as any } });
  }
  const provider = {
    activeShop: vi.fn(() => { throw new Error("provider shop lookup forbidden during clone"); }),
    discoveryAdapter: vi.fn(() => { throw new Error("Marketplace Search forbidden during clone"); }),
    adapter: vi.fn(() => { throw new Error("provider reads forbidden during clone"); })
  };
  const queues = { reconcile: vi.fn(() => { throw new Error("queue mutation forbidden during clone"); }) };
  return { shop, candidates, campaign: await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } }), run, provider, queues, service: new OutreachService(prisma as any, queues as any, provider as any) };
}

const cloneInput: CampaignCloneFromPreviewInput = {
  name: "PROYA Sheet Mask Creator Collaboration - One Recipient Validation",
  productName: "Sheet Mask", targetCount: 1,
  messageTemplate: "Hi {{creator_display_name}}, we'd love to invite you to collaborate on {{product_name}} for our {{campaign_name}} campaign."
};

afterAll(async () => {
  for (const id of shopIds) await prisma.shop.delete({ where: { id } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe.sequential("clone from PREVIEW_READY", () => {
  it("requires a PREVIEW_READY source with completed persisted discovery", async () => {
    const draft = await fixture({ state: "DRAFT" });
    await expect(draft.service.cloneFromPreview(draft.campaign.id, cloneInput, stamp())).rejects.toThrow("PREVIEW_READY");

    const incomplete = await fixture({ complete: false });
    await prisma.campaign.update({ where: { id: incomplete.campaign.id }, data: { state: "PREVIEW_READY" } });
    await expect(incomplete.service.cloneFromPreview(incomplete.campaign.id, cloneInput, stamp())).rejects.toThrow("completed discovery run");
  });

  it("copies candidates locally, reruns ranking/safety, preserves exact identity, and leaves the source unchanged", async () => {
    const seed = await fixture({ filters: { categoryIds: ["beauty"] } });
    const byOpenId = new Map((await prisma.creator.findMany({ where: { creatorOpenId: { in: seed.candidates.map((item) => item.creatorOpenId) } } })).map((item) => [item.creatorOpenId!, item]));
    const ranked = [...seed.candidates].sort((a, b) => b.followerCount! - a.followerCount!);
    await prisma.creatorShopContactState.create({ data: { shopId: seed.shop.id, creatorId: byOpenId.get(ranked[0].creatorOpenId)!.id, doNotContact: true } });
    await prisma.creatorShopContactState.create({ data: {
      shopId: seed.shop.id, creatorId: byOpenId.get(ranked[1].creatorOpenId)!.id, contactCount: 1,
      firstContactedAt: now, lastContactedAt: now, lastCampaignId: seed.campaign.id
    } });
    await prisma.creatorShopContactState.create({ data: {
      shopId: seed.shop.id, creatorId: byOpenId.get(ranked[2].creatorOpenId)!.id, unresolvedDelivery: true
    } });
    const reservedRecipient = await prisma.campaignRecipient.findFirstOrThrow({
      where: { campaignId: seed.campaign.id, creatorId: byOpenId.get(ranked[3].creatorOpenId)!.id }
    });
    await prisma.outreachReservation.create({ data: {
      shopId: seed.shop.id, creatorId: reservedRecipient.creatorId, campaignRecipientId: reservedRecipient.id,
      expiresAt: new Date("2099-01-01T00:00:00.000Z")
    } });
    const sourceBefore = await prisma.campaign.findUniqueOrThrow({ where: { id: seed.campaign.id }, include: { recipients: true, discoveryRun: { include: { candidates: true } } } });
    expect(sourceBefore.recipients.filter((item) => item.selected)).toHaveLength(10);

    const response = await seed.service.cloneFromPreview(seed.campaign.id, cloneInput, "safe-submit-1");
    expect(response).toMatchObject({ state: "PREVIEW_READY", fetched: 20, eligible: 15, selected: 1, warnings: [] });
    expect(JSON.stringify(response)).not.toContain("creatorOpenId");
    expect(JSON.stringify(response)).not.toContain("search");
    expect(seed.provider.activeShop).not.toHaveBeenCalled();
    expect(seed.provider.discoveryAdapter).not.toHaveBeenCalled();
    expect(seed.provider.adapter).not.toHaveBeenCalled();
    expect(seed.queues.reconcile).not.toHaveBeenCalled();

    const sourceAfter = await prisma.campaign.findUniqueOrThrow({ where: { id: seed.campaign.id }, include: { recipients: true, discoveryRun: { include: { candidates: true } } } });
    expect(sourceAfter).toEqual(sourceBefore);
    expect(sourceAfter.recipients.filter((item) => item.selected)).toHaveLength(10);

    const clone = await prisma.campaign.findUniqueOrThrow({ where: { id: response.id }, include: {
      discoveryRun: { include: { candidates: { orderBy: { discoveryOrdinal: "asc" } } } },
      recipients: { include: { creator: { include: { providerIdentities: true } }, snapshot: true } },
      deliveries: true, outboxEntries: true
    } });
    expect(clone).toMatchObject({ state: "PREVIEW_READY", targetCount: 1, frozenAt: null, freezeExpiresAt: null });
    expect(clone.discoveryRun).toMatchObject({ state: "COMPLETE", totalProviderRequests: 0, pagesFetched: 0, providerSearchKey: null, providerNextPageToken: null });
    expect(clone.discoveryRun!.candidates).toHaveLength(20);
    expect(clone.discoveryRun!.candidates.map((item) => item.creatorOpenId)).toEqual(sourceBefore.discoveryRun!.candidates.sort((a, b) => a.discoveryOrdinal - b.discoveryOrdinal).map((item) => item.creatorOpenId));
    expect(JSON.stringify(clone.discoveryRun!.candidates)).not.toContain("must-not-copy");
    expect(clone.recipients).toHaveLength(20);
    expect(new Set(clone.recipients.map((item) => item.id))).not.toEqual(new Set(sourceBefore.recipients.map((item) => item.id)));
    const selected = clone.recipients.filter((item) => item.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0].creator.creatorOpenId).toBe(ranked[4].creatorOpenId);
    expect(selected[0].creator.providerIdentities).toEqual(expect.arrayContaining([expect.objectContaining({
      identityType: "TIKTOK_CREATOR_OPEN_ID", identifier: ranked[4].creatorOpenId, linkState: "VERIFIED"
    })]));
    expect(clone.recipients.find((item) => item.creator.creatorOpenId === ranked[0].creatorOpenId)?.skipReason).toBe("DO_NOT_CONTACT");
    expect(clone.recipients.find((item) => item.creator.creatorOpenId === ranked[1].creatorOpenId)?.skipReason).toBe("CONTACTED_BY_APP_WITHIN_COOLDOWN");
    expect(clone.recipients.find((item) => item.creator.creatorOpenId === ranked[2].creatorOpenId)?.skipReason).toBe("DELIVERY_UNKNOWN");
    expect(clone.recipients.find((item) => item.creator.creatorOpenId === ranked[3].creatorOpenId)?.skipReason).toBe("ACTIVE_RESERVATION");
    expect(clone.recipients.find((item) => item.creator.creatorOpenId === seed.candidates[0].creatorOpenId)?.skipReason).toBe("FILTER_MISMATCH");
    expect(clone.deliveries).toHaveLength(0);
    expect(clone.outboxEntries).toHaveLength(0);
    expect(await prisma.deliveryAttempt.count({ where: { delivery: { campaignId: clone.id } } })).toBe(0);
    expect(await prisma.outreachReservation.count({ where: { recipient: { campaignId: clone.id } } })).toBe(0);
    expect(await prisma.auditEvent.findFirst({ where: { campaignId: clone.id, eventType: "CAMPAIGN_CLONED_FROM_PREVIEW" } })).not.toBeNull();
    expect(await prisma.auditEvent.findFirst({ where: { campaignId: clone.id, eventType: "PREVIEW_READY" } })).not.toBeNull();
  });

  it("returns a safe zero-selected preview without weakening filters", async () => {
    const seed = await fixture({ filters: { minFollowers: 1_000_000 } });
    const response = await seed.service.cloneFromPreview(seed.campaign.id, cloneInput, stamp());
    expect(response).toMatchObject({ state: "PREVIEW_READY", eligible: 0, selected: 0 });
    expect(response.warnings).toHaveLength(1);
    expect(await prisma.campaignRecipient.count({ where: { campaignId: response.id, selected: true } })).toBe(0);
  });

  it("is idempotent for duplicate submissions and rejects missing exact identity evidence", async () => {
    const seed = await fixture();
    const first = await seed.service.cloneFromPreview(seed.campaign.id, cloneInput, "duplicate-submit");
    const second = await seed.service.cloneFromPreview(seed.campaign.id, cloneInput, "duplicate-submit");
    expect(second).toEqual(first);
    expect(await prisma.auditEvent.count({ where: { eventType: "CAMPAIGN_CLONED_FROM_PREVIEW", campaignId: first.id } })).toBe(1);

    const invalid = await fixture();
    await prisma.creatorProviderIdentity.deleteMany({ where: { identifier: invalid.candidates[0].creatorOpenId } });
    await expect(invalid.service.cloneFromPreview(invalid.campaign.id, cloneInput, stamp())).rejects.toThrow("verified exact Creator Open ID evidence");
    expect(await prisma.campaign.count({ where: { shopId: invalid.shop.id } })).toBe(1);
  });

  it("validates normal template placeholders before creating anything", async () => {
    const seed = await fixture();
    await expect(seed.service.cloneFromPreview(seed.campaign.id, { ...cloneInput, messageTemplate: "Hi {{not_allowed}}" }, stamp())).rejects.toThrow("Unsupported template placeholder");
    expect(await prisma.campaign.count({ where: { shopId: seed.shop.id } })).toBe(1);
  });
});
