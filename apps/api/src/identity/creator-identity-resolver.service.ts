import { BadRequestException, Injectable } from "@nestjs/common";
import { lockCreatorEligibility, Prisma } from "@affiliate/db";
import type { CreatorCandidate } from "@affiliate/domain";
import type { ProviderConversation } from "@affiliate/contracts";
import { PrismaService } from "../shared";

type ExactLinkEvidence = {
  evidenceType: "CONVERSATION_RETURNED_BOTH_IDENTIFIERS" | "DOCUMENTED_PROVIDER_MAPPING";
  creatorImId: string;
  creatorOpenId: string;
  mappingReference?: string;
};

@Injectable()
export class CreatorIdentityResolver {
  constructor(private readonly prisma: PrismaService) {}

  private async identity(
    tx: Prisma.TransactionClient,
    creatorId: string,
    identityType: "TIKTOK_CREATOR_OPEN_ID" | "TIKTOK_CREATOR_USER_ID" | "TIKTOK_CREATOR_IM_ID",
    identifier: string,
    linkState: "VERIFIED" | "UNRESOLVED",
    evidenceType: string
  ) {
    const existing = await tx.creatorProviderIdentity.findUnique({
      where: { provider_identityType_identifier: { provider: "TIKTOK_SHOP", identityType, identifier } }
    });
    if (existing && existing.creatorId !== creatorId) {
      throw new BadRequestException(`Creator identity conflict for ${identityType}`);
    }
    return tx.creatorProviderIdentity.upsert({
      where: { provider_identityType_identifier: { provider: "TIKTOK_SHOP", identityType, identifier } },
      update: { creatorId, linkState, evidenceType },
      create: { creatorId, identityType, identifier, linkState, evidenceType }
    });
  }

  async ensureMarketplaceCreator(candidate: CreatorCandidate) {
    if (!candidate.creatorOpenId) throw new BadRequestException("Marketplace creator_open_id is required");
    return this.prisma.$transaction(async (tx) => {
      const byOpen = await tx.creator.findUnique({ where: { creatorOpenId: candidate.creatorOpenId } });
      const byUser = candidate.creatorUserId ? await tx.creator.findUnique({ where: { creatorUserId: candidate.creatorUserId } }) : null;
      if (byOpen && byUser && byOpen.id !== byUser.id) throw new BadRequestException("Conflicting exact Marketplace creator identifiers");
      if (byUser?.creatorOpenId && byUser.creatorOpenId !== candidate.creatorOpenId) {
        throw new BadRequestException("Creator User ID is already linked to a different Creator Open ID");
      }
      if (candidate.creatorUserId && byOpen?.creatorUserId && byOpen.creatorUserId !== candidate.creatorUserId) {
        throw new BadRequestException("Creator Open ID is already linked to a different Creator User ID");
      }
      const creator = byOpen ?? byUser ?? await tx.creator.create({ data: {
        creatorOpenId: candidate.creatorOpenId, creatorUserId: candidate.creatorUserId,
        username: candidate.username, nickname: candidate.nickname, avatarUrl: candidate.avatarUrl, selectionRegion: candidate.selectionRegion
      } });
      const updated = await tx.creator.update({ where: { id: creator.id }, data: {
        creatorOpenId: candidate.creatorOpenId, creatorUserId: candidate.creatorUserId,
        username: candidate.username, nickname: candidate.nickname, avatarUrl: candidate.avatarUrl, selectionRegion: candidate.selectionRegion
      } });
      await this.identity(tx, updated.id, "TIKTOK_CREATOR_OPEN_ID", candidate.creatorOpenId, "VERIFIED", "MARKETPLACE_EXACT_FIELD");
      if (candidate.creatorUserId) await this.identity(tx, updated.id, "TIKTOK_CREATOR_USER_ID", candidate.creatorUserId, "VERIFIED", "MARKETPLACE_EXACT_FIELD");
      return updated;
    });
  }

  async ensureConversationCreator(conversation: ProviderConversation) {
    if (!conversation.creatorImId) throw new BadRequestException("Conversation creator_im_id is required");
    const existingByIm = await this.prisma.creator.findUnique({ where: { creatorImId: conversation.creatorImId } });
    if (conversation.creatorOpenId) {
      const existingByOpen = await this.prisma.creator.findUnique({ where: { creatorOpenId: conversation.creatorOpenId } });
      if (existingByIm?.creatorOpenId && existingByIm.creatorOpenId !== conversation.creatorOpenId) {
        throw new BadRequestException("Creator IM ID is already linked to a different Creator Open ID");
      }
      if (existingByOpen?.creatorImId && existingByOpen.creatorImId !== conversation.creatorImId) {
        throw new BadRequestException("Creator Open ID is already linked to a different Creator IM ID");
      }
      if (existingByIm && existingByOpen && existingByIm.id !== existingByOpen.id) {
        return this.linkExactProviderIdentities(existingByIm.id, existingByOpen.id, {
          evidenceType: "CONVERSATION_RETURNED_BOTH_IDENTIFIERS", creatorImId: conversation.creatorImId, creatorOpenId: conversation.creatorOpenId
        });
      }
      return this.prisma.$transaction(async (tx) => {
        const creator = existingByIm ?? existingByOpen ?? await tx.creator.create({ data: {
          creatorOpenId: conversation.creatorOpenId, creatorImId: conversation.creatorImId,
          username: conversation.username, avatarUrl: conversation.avatarUrl, selectionRegion: "ID"
        } });
        const updated = await tx.creator.update({ where: { id: creator.id }, data: {
          creatorOpenId: conversation.creatorOpenId, creatorImId: conversation.creatorImId,
          username: conversation.username, avatarUrl: conversation.avatarUrl
        } });
        await this.identity(tx, updated.id, "TIKTOK_CREATOR_OPEN_ID", conversation.creatorOpenId!, "VERIFIED", "CONVERSATION_EXACT_FIELD");
        await this.identity(tx, updated.id, "TIKTOK_CREATOR_IM_ID", conversation.creatorImId, "VERIFIED", "CONVERSATION_RETURNED_BOTH_IDENTIFIERS");
        return updated;
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const creator = existingByIm
        ? await tx.creator.update({ where: { id: existingByIm.id }, data: { username: conversation.username, avatarUrl: conversation.avatarUrl } })
        : await tx.creator.create({ data: { creatorImId: conversation.creatorImId, username: conversation.username, avatarUrl: conversation.avatarUrl, selectionRegion: "ID" } });
      const prior = await tx.creatorProviderIdentity.findUnique({
        where: { provider_identityType_identifier: { provider: "TIKTOK_SHOP", identityType: "TIKTOK_CREATOR_IM_ID", identifier: conversation.creatorImId } }
      });
      await this.identity(tx, creator.id, "TIKTOK_CREATOR_IM_ID", conversation.creatorImId, "UNRESOLVED", "CONVERSATION_IM_ONLY");
      if (!prior) await tx.creatorIdentityAudit.create({ data: {
        action: "UNRESOLVED_IDENTITY_OBSERVED", sourceCreatorId: creator.id, evidenceType: "CONVERSATION_IM_ONLY",
        evidence: { identityNamespace: "TIKTOK_CREATOR_IM_ID" }
      } });
      return creator;
    });
  }

  async linkExactProviderIdentities(sourceCreatorId: string, targetCreatorId: string, evidence: ExactLinkEvidence) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`creator-identity:${[sourceCreatorId, targetCreatorId].sort().join(":")}`}))`;
      let [source, target] = await Promise.all([
        tx.creator.findUnique({ where: { id: sourceCreatorId }, include: { contacts: true } }),
        tx.creator.findUniqueOrThrow({ where: { id: targetCreatorId }, include: { contacts: true } })
      ]);
      if (!source) {
        const alreadyLinked = await tx.creator.findUnique({ where: { creatorImId: evidence.creatorImId }, include: { contacts: true } });
        if (alreadyLinked?.id === target.id && target.creatorOpenId === evidence.creatorOpenId) return target;
        throw new BadRequestException("Source creator identity no longer exists and is not linked to the target");
      }
      if (source.id === target.id) {
        await this.identity(tx, target.id, "TIKTOK_CREATOR_IM_ID", evidence.creatorImId, "VERIFIED", evidence.evidenceType);
        return target;
      }
      if (source.creatorImId !== evidence.creatorImId || target.creatorOpenId !== evidence.creatorOpenId) {
        throw new BadRequestException("Exact provider identity evidence does not match the stored identities");
      }
      if (source.creatorOpenId && source.creatorOpenId !== target.creatorOpenId) throw new BadRequestException("Source creator already has a conflicting Open ID");
      if (target.creatorImId && target.creatorImId !== source.creatorImId) throw new BadRequestException("Target creator already has a conflicting IM ID");
      if (evidence.evidenceType === "DOCUMENTED_PROVIDER_MAPPING" && !evidence.mappingReference?.trim()) {
        throw new BadRequestException("A documented provider mapping reference is required");
      }
      const affectedCreatorIds = [source.id, target.id];
      const [contactShops, conversationShops, recipientShops, reservationShops] = await Promise.all([
        tx.creatorShopContactState.findMany({ where: { creatorId: { in: affectedCreatorIds } }, select: { shopId: true } }),
        tx.conversation.findMany({ where: { creatorId: { in: affectedCreatorIds } }, select: { shopId: true } }),
        tx.campaignRecipient.findMany({ where: { creatorId: { in: affectedCreatorIds } }, select: { campaign: { select: { shopId: true } } } }),
        tx.outreachReservation.findMany({ where: { creatorId: { in: affectedCreatorIds } }, select: { shopId: true } })
      ]);
      const affectedShopIds = [...new Set([
        ...contactShops.map((item) => item.shopId),
        ...conversationShops.map((item) => item.shopId),
        ...recipientShops.map((item) => item.campaign.shopId),
        ...reservationShops.map((item) => item.shopId)
      ])].sort();
      for (const shopId of affectedShopIds) await lockCreatorEligibility(tx, shopId, affectedCreatorIds);
      const duplicateCampaign = await tx.campaignRecipient.findFirst({
        where: { creatorId: source.id, campaign: { recipients: { some: { creatorId: target.id } } } }, select: { campaignId: true }
      });
      if (duplicateCampaign) throw new BadRequestException("Identity merge conflicts with existing campaign history");
      const duplicateReservation = await tx.outreachReservation.findFirst({
        where: { creatorId: source.id, shop: { reservations: { some: { creatorId: target.id } } } }, select: { shopId: true }
      });
      if (duplicateReservation) throw new BadRequestException("Identity merge conflicts with an active creator reservation");

      const preserved = new Map<string, { doNotContact: boolean; unresolvedDelivery: boolean; latestReplyStatus: string; historyCoverageStart?: Date }>();
      for (const state of [...source.contacts, ...target.contacts]) {
        const current = preserved.get(state.shopId);
        preserved.set(state.shopId, {
          doNotContact: Boolean(current?.doNotContact || state.doNotContact),
          unresolvedDelivery: Boolean(current?.unresolvedDelivery || state.unresolvedDelivery),
          latestReplyStatus: current?.latestReplyStatus === "REPLIED" || state.latestReplyStatus === "REPLIED" ? "REPLIED" : state.latestReplyStatus,
          historyCoverageStart: !current?.historyCoverageStart || (state.historyCoverageStart && state.historyCoverageStart < current.historyCoverageStart)
            ? state.historyCoverageStart ?? current?.historyCoverageStart : current.historyCoverageStart
        });
      }

      await tx.creatorProviderIdentity.updateMany({ where: { creatorId: source.id }, data: { creatorId: target.id, linkState: "VERIFIED", evidenceType: evidence.evidenceType } });
      await tx.creatorMetricSnapshot.updateMany({ where: { creatorId: source.id }, data: { creatorId: target.id } });
      await tx.conversation.updateMany({ where: { creatorId: source.id }, data: { creatorId: target.id } });
      await tx.campaignRecipient.updateMany({ where: { creatorId: source.id }, data: { creatorId: target.id } });
      await tx.outreachReservation.updateMany({ where: { creatorId: source.id }, data: { creatorId: target.id } });
      await tx.creatorShopContactState.deleteMany({ where: { creatorId: { in: [source.id, target.id] } } });
      await tx.creator.delete({ where: { id: source.id } });
      await tx.creator.update({ where: { id: target.id }, data: {
        creatorImId: source.creatorImId, username: target.username ?? source.username, nickname: target.nickname ?? source.nickname,
        avatarUrl: target.avatarUrl ?? source.avatarUrl, profileUri: target.profileUri ?? source.profileUri
      } });

      for (const [shopId, flags] of preserved) await this.rebuildContactState(tx, shopId, target.id, flags);
      await tx.creatorIdentityAudit.create({ data: {
        action: "EXACT_PROVIDER_IDENTITIES_LINKED", sourceCreatorId, targetCreatorId, evidenceType: evidence.evidenceType,
        evidence: { mappingReference: evidence.mappingReference ?? null, identityNamespaces: ["TIKTOK_CREATOR_IM_ID", "TIKTOK_CREATOR_OPEN_ID"] }
      } });
      return tx.creator.findUniqueOrThrow({ where: { id: target.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 20_000 });
  }

  private async rebuildContactState(
    tx: Prisma.TransactionClient,
    shopId: string,
    creatorId: string,
    preserved: { doNotContact: boolean; unresolvedDelivery: boolean; latestReplyStatus: string; historyCoverageStart?: Date }
  ) {
    const creator = await tx.creator.findUniqueOrThrow({ where: { id: creatorId } });
    const [deliveries, messages, facts, unknownDeliveries] = await Promise.all([
      tx.outreachDelivery.findMany({ where: { state: "SENT", recipient: { creatorId }, campaign: { shopId } }, select: { id: true, externalMessageId: true, sentAt: true, firstDispatchedAt: true, campaignId: true }, orderBy: { sentAt: "desc" } }),
      tx.conversationMessage.findMany({ where: { direction: "OUTBOUND", conversation: { shopId, creatorId } }, select: { externalMessageId: true, providerCreatedAt: true } }),
      creator.creatorOpenId ? tx.historicalContactFact.findMany({ where: { shopId, creatorOpenId: creator.creatorOpenId } }) : Promise.resolve([]),
      tx.outreachDelivery.count({ where: { state: { in: ["DELIVERY_UNKNOWN", "DELIVERY_UNKNOWN_UNRESOLVED"] }, recipient: { creatorId }, campaign: { shopId } } })
    ]);
    const contacts = new Map<string, Date>();
    for (const item of deliveries) contacts.set(item.externalMessageId ? `provider:${item.externalMessageId}` : `delivery:${item.id}`, item.sentAt ?? item.firstDispatchedAt ?? new Date(0));
    for (const item of messages) contacts.set(`provider:${item.externalMessageId}`, item.providerCreatedAt);
    for (const item of facts.filter((fact) => fact.sendStatus === "SENT" && fact.resolutionState === "MATCHED")) {
      contacts.set(item.externalMessageId ? `provider:${item.externalMessageId}` : `historical:${item.identityKey}`, item.contactedAt);
    }
    const dates = [...contacts.values()].filter((date) => date.getTime() > 0).sort((a, b) => a.getTime() - b.getTime());
    const factDates = facts.filter((item) => item.resolutionState === "MATCHED").map((item) => item.contactedAt);
    const coverageDates = [...factDates, ...(preserved.historyCoverageStart ? [preserved.historyCoverageStart] : [])].sort((a, b) => a.getTime() - b.getTime());
    const latest = deliveries[0];
    await tx.creatorShopContactState.create({ data: {
      shopId, creatorId, firstContactedAt: dates[0] ?? null, lastContactedAt: dates.at(-1) ?? null, contactCount: contacts.size,
      historyCoverageStart: coverageDates[0], doNotContact: preserved.doNotContact,
      unresolvedDelivery: preserved.unresolvedDelivery || unknownDeliveries > 0 || facts.some((item) => item.sendStatus === "UNKNOWN" && item.resolutionState === "MATCHED"),
      latestReplyStatus: preserved.latestReplyStatus, lastCampaignId: latest?.campaignId, lastDeliveryId: latest?.id
    } });
  }
}
