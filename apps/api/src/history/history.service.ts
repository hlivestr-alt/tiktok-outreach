import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { lockCreatorEligibility, Prisma } from "@affiliate/db";
import type { TikTokReadAdapter } from "@affiliate/contracts";
import { config, PrismaService } from "../shared";
import { TikTokIntegrationService } from "../integrations/tiktok.service";
import { CreatorIdentityResolver } from "../identity/creator-identity-resolver.service";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

@Injectable()
export class HistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tiktok: TikTokIntegrationService,
    private readonly identities: CreatorIdentityResolver = new CreatorIdentityResolver(prisma)
  ) {}

  async contacts() {
    const shop = await this.tiktok.activeShop();
    const contacts = await this.prisma.creatorShopContactState.findMany({
      where: { shopId: shop.id }, orderBy: [{ lastContactedAt: "desc" }, { updatedAt: "desc" }], take: 500,
      include: { creator: { include: {
        snapshots: { orderBy: { sourceFetchedAt: "desc" }, take: 1 },
        conversations: { where: { shopId: shop.id }, orderBy: { lastSyncedAt: "desc" }, take: 1 },
        providerIdentities: { where: {
          provider: "TIKTOK_SHOP", identityType: "TIKTOK_CREATOR_OPEN_ID", linkState: "VERIFIED"
        } }
      } } }
    });
    const campaignIds = [...new Set(contacts.flatMap((item) => item.lastCampaignId ? [item.lastCampaignId] : []))];
    const deliveryIds = [...new Set(contacts.flatMap((item) => item.lastDeliveryId ? [item.lastDeliveryId] : []))];
    const [campaigns, deliveries] = await Promise.all([
      this.prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true } }),
      this.prisma.outreachDelivery.findMany({ where: { id: { in: deliveryIds } }, select: { id: true, state: true } })
    ]);
    const campaignById = new Map(campaigns.map((item) => [item.id, item.name]));
    const deliveryById = new Map(deliveries.map((item) => [item.id, item.state]));
    return contacts.map((contact) => {
      const marketplaceLinked = Boolean(contact.creator.creatorOpenId && contact.creator.providerIdentities.some(
        (identity) => identity.identifier === contact.creator.creatorOpenId
      ));
      return ({
      id: contact.id,
      creatorOpenId: contact.creator.creatorOpenId,
      creatorImId: contact.creator.creatorImId,
      identityCoverage: marketplaceLinked ? "LINKED_TO_MARKETPLACE" : contact.creator.creatorImId && !contact.creator.creatorOpenId ? "IM_ONLY_UNRESOLVED" : "UNRESOLVED",
      username: contact.creator.username,
      nickname: contact.creator.nickname,
      categoryIds: contact.creator.snapshots[0]?.categoryIds ?? [],
      followerCount: contact.creator.snapshots[0]?.followerCount,
      gmvAmount: contact.creator.snapshots[0]?.gmvAmount,
      conversationId: contact.creator.conversations[0]?.externalConversationId,
      firstContactedAt: contact.firstContactedAt,
      lastContactedAt: contact.lastContactedAt,
      contactCount: contact.contactCount,
      lastCampaign: contact.lastCampaignId ? campaignById.get(contact.lastCampaignId) ?? contact.lastCampaignId : null,
      sendStatus: contact.lastDeliveryId ? deliveryById.get(contact.lastDeliveryId) ?? "HISTORICAL" : "HISTORICAL",
      replyStatus: contact.latestReplyStatus,
      unresolvedDelivery: contact.unresolvedDelivery,
      doNotContact: contact.doNotContact
    });
    });
  }

  async syncMockHistory(adapter?: TikTokReadAdapter, source = config.APP_MODE === "mock" ? "MOCK_TIKTOK" : "REAL_TIKTOK_READ_ONLY", validationMode = false) {
    if (validationMode) return this.validateConversationList(adapter);
    const effectiveAdapter = adapter ?? await this.tiktok.adapter({ validationMode });
    const shop = await this.tiktok.activeShop();
    const resumable = await this.prisma.contactHistorySyncRun.findFirst({
      where: { shopId: shop.id, source, state: { in: ["PARTIAL", "FAILED"] }, cursor: { not: Prisma.DbNull } },
      orderBy: { createdAt: "desc" }
    });
    const run = resumable
      ? await this.prisma.contactHistorySyncRun.update({ where: { id: resumable.id }, data: { state: "RUNNING", error: null, completedAt: null } })
      : await this.prisma.contactHistorySyncRun.create({ data: {
          shopId: shop.id, source, state: "RUNNING", startedAt: new Date(),
          cursor: { phase: "CONVERSATIONS", conversationPageToken: null, conversationIndex: 0, messagePageToken: null }
        } });
    type SyncCursor = { phase: "CONVERSATIONS" | "UNREAD"; conversationPageToken?: string | null; conversationIndex: number; messagePageToken?: string | null };
    let cursor = (run.cursor as SyncCursor | null) ?? { phase: "CONVERSATIONS", conversationPageToken: null, conversationIndex: 0, messagePageToken: null };
    let earliest = run.earliestCoveredAt ?? undefined;
    let latest = run.latestCoveredAt ?? undefined;
    let imported = run.messagesImported;
    let scanned = run.conversationsScanned;
    try {
      while (cursor.phase === "CONVERSATIONS") {
        const pageToken = cursor.conversationPageToken ?? undefined;
        const page = await effectiveAdapter.listConversations({ pageToken, pageSize: 50 });
        for (let index = cursor.conversationIndex; index < page.items.length; index++) {
          const providerConversation = page.items[index];
          const creator = await this.identities.ensureConversationCreator(providerConversation);
          const conversation = await this.prisma.conversation.upsert({
            where: { externalConversationId: providerConversation.id }, update: { lastSyncedAt: new Date() },
            create: { shopId: shop.id, creatorId: creator.id, externalConversationId: providerConversation.id, lastSyncedAt: new Date() }
          });
          let messagePageToken = index === cursor.conversationIndex ? cursor.messagePageToken ?? undefined : undefined;
          while (true) {
            const messages = await effectiveAdapter.listMessages(providerConversation.id, { pageToken: messagePageToken, pageSize: 20, creatorImId: providerConversation.creatorImId });
            for (const message of messages.items) {
              const wasImported = await this.prisma.$transaction(async (tx) => {
                await lockCreatorEligibility(tx, shop.id, [creator.id]);
                const existingMessage = await tx.conversationMessage.findUnique({ where: { externalMessageId: message.id } });
                await tx.conversationMessage.upsert({
                  where: { externalMessageId: message.id }, update: {},
                  create: { conversationId: conversation.id, externalMessageId: message.id, direction: message.direction, content: message.content, contentHash: hash(message.content), providerCreatedAt: message.createdAt, importSource: source }
                });
                const existing = await tx.creatorShopContactState.findUnique({ where: { shopId_creatorId: { shopId: shop.id, creatorId: creator.id } } });
                if (message.direction === "OUTBOUND") await tx.creatorShopContactState.upsert({
                  where: { shopId_creatorId: { shopId: shop.id, creatorId: creator.id } }, update: {
                    firstContactedAt: existing?.firstContactedAt && existing.firstContactedAt < message.createdAt ? existing.firstContactedAt : message.createdAt,
                    lastContactedAt: existing?.lastContactedAt && existing.lastContactedAt > message.createdAt ? existing.lastContactedAt : message.createdAt,
                    contactCount: existingMessage ? undefined : { increment: 1 }, historyCoverageStart: existing?.historyCoverageStart && existing.historyCoverageStart < message.createdAt ? existing.historyCoverageStart : message.createdAt
                  }, create: { shopId: shop.id, creatorId: creator.id, firstContactedAt: message.createdAt, lastContactedAt: message.createdAt, contactCount: 1, historyCoverageStart: message.createdAt }
                });
                else await tx.creatorShopContactState.upsert({ where: { shopId_creatorId: { shopId: shop.id, creatorId: creator.id } }, update: { latestReplyStatus: "REPLIED" }, create: { shopId: shop.id, creatorId: creator.id, latestReplyStatus: "REPLIED" } });
                return !existingMessage;
              });
              earliest = !earliest || message.createdAt < earliest ? message.createdAt : earliest;
              latest = !latest || message.createdAt > latest ? message.createdAt : latest;
              if (wasImported) imported++;
            }
            messagePageToken = messages.nextPageToken;
            cursor = { phase: "CONVERSATIONS", conversationPageToken: pageToken ?? null, conversationIndex: index, messagePageToken: messagePageToken ?? null };
            await this.prisma.contactHistorySyncRun.update({ where: { id: run.id }, data: {
              cursor: cursor as Prisma.InputJsonValue, messagesImported: imported, earliestCoveredAt: earliest, latestCoveredAt: latest
            } });
            if (!messages.hasMore) break;
          }
          scanned++;
          cursor = { phase: "CONVERSATIONS", conversationPageToken: pageToken ?? null, conversationIndex: index + 1, messagePageToken: null };
          await this.prisma.contactHistorySyncRun.update({ where: { id: run.id }, data: { cursor: cursor as Prisma.InputJsonValue, conversationsScanned: scanned } });
        }
        if (page.hasMore) cursor = { phase: "CONVERSATIONS", conversationPageToken: page.nextPageToken ?? null, conversationIndex: 0, messagePageToken: null };
        else cursor = { phase: "UNREAD", conversationPageToken: null, conversationIndex: 0, messagePageToken: null };
        await this.prisma.contactHistorySyncRun.update({ where: { id: run.id }, data: { cursor: cursor as Prisma.InputJsonValue } });
      }
      const unreadMessages = effectiveAdapter.getLatestUnreadMessages ? await effectiveAdapter.getLatestUnreadMessages() : [];
      for (const message of unreadMessages) {
        const existingMessage = await this.prisma.conversationMessage.findUnique({ where: { externalMessageId: message.id } });
        if (!message.creatorOpenId) throw new BadRequestException("Unread message omitted creator_open_id");
        const creator = await this.prisma.creator.upsert({
          where: { creatorOpenId: message.creatorOpenId }, update: {},
          create: { creatorOpenId: message.creatorOpenId, selectionRegion: "ID" }
        });
        const conversation = await this.prisma.conversation.upsert({
          where: { externalConversationId: message.conversationId },
          update: { unreadCount: existingMessage ? undefined : { increment: 1 }, lastSyncedAt: new Date() },
          create: { shopId: shop.id, creatorId: creator.id, externalConversationId: message.conversationId, unreadCount: 1, lastSyncedAt: new Date() }
        });
        await this.prisma.conversationMessage.upsert({
          where: { externalMessageId: message.id }, update: {},
          create: {
            conversationId: conversation.id, externalMessageId: message.id, direction: "INBOUND",
            content: message.content, contentHash: hash(message.content), providerCreatedAt: message.createdAt, importSource: source
          }
        });
        await this.prisma.creatorShopContactState.upsert({
          where: { shopId_creatorId: { shopId: shop.id, creatorId: creator.id } },
          update: { latestReplyStatus: "REPLIED" },
          create: { shopId: shop.id, creatorId: creator.id, latestReplyStatus: "REPLIED" }
        });
        if (!existingMessage) imported++;
        latest = !latest || message.createdAt > latest ? message.createdAt : latest;
      }
      return this.prisma.contactHistorySyncRun.update({ where: { id: run.id }, data: {
        state: "COMPLETE", completedAt: new Date(), cursor: Prisma.DbNull, conversationsScanned: scanned,
        messagesImported: imported, earliestCoveredAt: earliest, latestCoveredAt: latest, error: null
      }});
    } catch (error) {
      await this.prisma.contactHistorySyncRun.update({ where: { id: run.id }, data: {
        state: "PARTIAL", cursor: cursor as Prisma.InputJsonValue, conversationsScanned: scanned, messagesImported: imported,
        earliestCoveredAt: earliest, latestCoveredAt: latest, error: error instanceof Error ? error.message : "Unknown sync error"
      } });
      throw error;
    }
  }

  private historicalIdentity(sourceName: string, row: Record<string, string>, contactedAt: Date): { identityKey: string; externalSource: string; sourceRecordId: string } {
    const normalizedSourceName = sourceName.trim().replace(/\\/g, "/").split("/").at(-1)?.trim().toLowerCase().replace(/\s+/g, "_") || "unnamed-csv";
    const externalSource = (row.external_source || row.source_system || row.provider || normalizedSourceName).trim().toLowerCase();
    const externalMessageId = row.external_message_id?.trim();
    const sourceRecordId = row.source_record_id?.trim();
    if (externalMessageId) return { identityKey: `message:${externalSource}:${externalMessageId}`, externalSource, sourceRecordId: sourceRecordId || externalMessageId };
    if (sourceRecordId) return { identityKey: `source:${externalSource}:${sourceRecordId}`, externalSource, sourceRecordId };
    const fallback = [
      row.creator_open_id?.trim(), row.conversation_id?.trim(), Number.isNaN(contactedAt.getTime()) ? row.contacted_at?.trim() : contactedAt.toISOString(),
      (row.send_status || "SENT").toUpperCase(), row.campaign_name?.trim(), row.message_body?.trim()
    ].map((value) => value ?? "").join("\u001f");
    return { identityKey: `fallback:${externalSource}:${hash(fallback)}`, externalSource, sourceRecordId: `fallback:${hash(fallback).slice(0, 20)}` };
  }

  private async rebuildContactState(db: Prisma.TransactionClient, shopId: string, creatorId: string): Promise<void> {
    const [deliveries, messages, facts, unknownDeliveries] = await Promise.all([
      db.outreachDelivery.findMany({
        where: { state: "SENT", recipient: { creatorId }, campaign: { shopId } },
        select: { id: true, externalMessageId: true, sentAt: true, firstDispatchedAt: true, campaignId: true }, orderBy: { sentAt: "desc" }
      }),
      db.conversationMessage.findMany({
        where: { direction: "OUTBOUND", conversation: { shopId, creatorId } },
        select: { externalMessageId: true, providerCreatedAt: true }
      }),
      (async () => {
        const openId = (await db.creator.findUniqueOrThrow({ where: { id: creatorId } })).creatorOpenId;
        return openId ? db.historicalContactFact.findMany({ where: { shopId, creatorOpenId: openId } }) : [];
      })(),
      db.outreachDelivery.count({ where: { state: { in: ["DELIVERY_UNKNOWN", "DELIVERY_UNKNOWN_UNRESOLVED"] }, recipient: { creatorId }, campaign: { shopId } } })
    ]);
    const contacts = new Map<string, Date>();
    for (const delivery of deliveries) contacts.set(delivery.externalMessageId ? `provider:${delivery.externalMessageId}` : `delivery:${delivery.id}`, delivery.sentAt ?? delivery.firstDispatchedAt ?? new Date(0));
    for (const message of messages) contacts.set(`provider:${message.externalMessageId}`, message.providerCreatedAt);
    for (const fact of facts.filter((item) => item.sendStatus === "SENT" && item.resolutionState === "MATCHED")) {
      contacts.set(fact.externalMessageId ? `provider:${fact.externalMessageId}` : `historical:${fact.identityKey}`, fact.contactedAt);
    }
    const dates = [...contacts.values()].filter((date) => date.getTime() > 0).sort((a, b) => a.getTime() - b.getTime());
    const historicalDates = facts.filter((item) => item.resolutionState === "MATCHED").map((item) => item.contactedAt).sort((a, b) => a.getTime() - b.getTime());
    const latestDelivery = deliveries[0];
    await db.creatorShopContactState.upsert({
      where: { shopId_creatorId: { shopId, creatorId } },
      update: {
        firstContactedAt: dates[0] ?? null, lastContactedAt: dates.at(-1) ?? null, contactCount: contacts.size,
        historyCoverageStart: historicalDates[0] ?? undefined,
        unresolvedDelivery: unknownDeliveries > 0 || facts.some((item) => item.sendStatus === "UNKNOWN" && item.resolutionState === "MATCHED"),
        lastCampaignId: latestDelivery?.campaignId, lastDeliveryId: latestDelivery?.id
      },
      create: {
        shopId, creatorId, firstContactedAt: dates[0] ?? null, lastContactedAt: dates.at(-1) ?? null, contactCount: contacts.size,
        historyCoverageStart: historicalDates[0], unresolvedDelivery: unknownDeliveries > 0 || facts.some((item) => item.sendStatus === "UNKNOWN" && item.resolutionState === "MATCHED"),
        lastCampaignId: latestDelivery?.campaignId, lastDeliveryId: latestDelivery?.id
      }
    });
  }

  async importCsv(input: { sourceName: string; csv: string }) {
    if (!input.sourceName || !input.csv) throw new BadRequestException("sourceName and csv are required");
    const shop = await this.tiktok.activeShop();
    const sourceHash = hash(input.csv);
    const prior = await this.prisma.historicalContactImport.findUnique({ where: { shopId_sourceHash: { shopId: shop.id, sourceHash } } });
    if (prior) return prior;
    const rows = parse(input.csv, { columns: true, skip_empty_lines: true, trim: true }) as Array<Record<string, string>>;
    const historicalImport = await this.prisma.historicalContactImport.create({ data: { shopId: shop.id, sourceName: input.sourceName, sourceHash, state: "RUNNING", rowCount: rows.length } });
    let importedCount = 0;
    let duplicateCount = 0;
    let unmatchedCount = 0;
    let conflictCount = 0;
    for (const row of rows) {
      const contactedAt = new Date(row.contacted_at);
      const identity = this.historicalIdentity(input.sourceName, row, contactedAt);
      let creatorOpenId: string | undefined = row.creator_open_id?.trim() || undefined;
      const conversationId: string | undefined = row.conversation_id?.trim() || undefined;
      if (!creatorOpenId && conversationId) {
        const existingConversation = await this.prisma.conversation.findUnique({
          where: { externalConversationId: conversationId }, include: { creator: true }
        });
        creatorOpenId = existingConversation?.creator.creatorOpenId ?? undefined;
      }
      const status = (row.send_status || "SENT").toUpperCase();
      const invalidDate = Number.isNaN(contactedAt.getTime());
      const resolutionState = invalidDate ? "CONFLICT" : creatorOpenId ? "MATCHED" : "UNMATCHED";
      if (invalidDate) {
        conflictCount++;
        await this.prisma.historicalContactRecord.create({ data: {
          importId: historicalImport.id, shopId: shop.id, sourceRecordId: identity.sourceRecordId, identityKey: identity.identityKey,
          creatorOpenId: creatorOpenId || null, conversationId: conversationId || null, externalMessageId: row.external_message_id || null,
          contactedAt: new Date(0), sendStatus: status, campaignName: row.campaign_name || null, messageContent: row.message_body || null, resolutionState
        } });
        continue;
      }
      if (!creatorOpenId) unmatchedCount++;
      const outcome = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`historical-identity:${shop.id}:${identity.identityKey}`}))`;
        const existingFact = await tx.historicalContactFact.findUnique({ where: { shopId_identityKey: { shopId: shop.id, identityKey: identity.identityKey } } });
        const creatorOpenIds = new Set([existingFact?.creatorOpenId, creatorOpenId].filter((value): value is string => Boolean(value)));
        const creators: Array<{ id: string }> = [];
        for (const openId of creatorOpenIds) {
          creators.push(await tx.creator.upsert({
            where: { creatorOpenId: openId },
            update: openId === creatorOpenId ? { username: row.username || undefined } : {},
            create: { creatorOpenId: openId, username: openId === creatorOpenId ? row.username || null : null, selectionRegion: "ID" }
          }));
        }
        await lockCreatorEligibility(tx, shop.id, creators.map((creator) => creator.id));
        const same = existingFact && existingFact.creatorOpenId === (creatorOpenId ?? null) && existingFact.conversationId === (conversationId ?? null)
          && existingFact.contactedAt.getTime() === contactedAt.getTime() && existingFact.sendStatus === status && existingFact.resolutionState === resolutionState;
        if (same) {
          await tx.historicalContactRecord.create({ data: {
            importId: historicalImport.id, shopId: shop.id, sourceRecordId: identity.sourceRecordId, identityKey: identity.identityKey,
            creatorOpenId: creatorOpenId || null, conversationId: conversationId || null, externalMessageId: row.external_message_id || null,
            contactedAt, sendStatus: status, campaignName: row.campaign_name || null, messageContent: row.message_body || null,
            resolutionState: "DUPLICATE", contactFactId: existingFact.id
          } });
          return "DUPLICATE" as const;
        }
        const fact = existingFact
          ? await tx.historicalContactFact.update({ where: { id: existingFact.id }, data: {
              externalSource: identity.externalSource, sourceRecordId: identity.sourceRecordId, externalMessageId: row.external_message_id || null,
              creatorOpenId: creatorOpenId || null, conversationId: conversationId || null, contactedAt, sendStatus: status, resolutionState
            } })
          : await tx.historicalContactFact.create({ data: {
              shopId: shop.id, identityKey: identity.identityKey, externalSource: identity.externalSource,
              sourceRecordId: identity.sourceRecordId, externalMessageId: row.external_message_id || null,
              creatorOpenId: creatorOpenId || null, conversationId: conversationId || null, contactedAt, sendStatus: status, resolutionState
            } });
        const created = await tx.historicalContactRecord.create({ data: {
          importId: historicalImport.id, shopId: shop.id, sourceRecordId: identity.sourceRecordId, identityKey: identity.identityKey,
          creatorOpenId: creatorOpenId || null, conversationId: conversationId || null, externalMessageId: row.external_message_id || null,
          contactedAt, sendStatus: status, campaignName: row.campaign_name || null, messageContent: row.message_body || null,
          resolutionState, contactFactId: fact.id
        } });
        if (existingFact?.currentRecordId) await tx.historicalContactRecord.update({ where: { id: existingFact.currentRecordId }, data: { resolutionState: "SUPERSEDED", supersededByRecordId: created.id } });
        await tx.historicalContactRecord.updateMany({ where: {
          shopId: shop.id, identityKey: identity.identityKey, id: { not: created.id }, resolutionState: { in: ["UNMATCHED", "CONFLICT"] }, supersededByRecordId: null
        }, data: { resolutionState: "SUPERSEDED", supersededByRecordId: created.id } });
        await tx.historicalContactFact.update({ where: { id: fact.id }, data: { currentRecordId: created.id } });
        for (const creator of creators) await this.rebuildContactState(tx, shop.id, creator.id);
        return "IMPORTED" as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      if (outcome === "DUPLICATE") duplicateCount++;
      else importedCount++;
    }
    return this.prisma.historicalContactImport.update({ where: { id: historicalImport.id }, data: {
      state: unmatchedCount || conflictCount ? "PARTIAL" : "COMPLETE", importedCount, duplicateCount, unmatchedCount, conflictCount, completedAt: new Date()
    }});
  }

  async readiness() {
    const shop = await this.tiktok.activeShop();
    const latestSync = await this.prisma.contactHistorySyncRun.findFirst({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" } });
    const imports = await this.prisma.historicalContactImport.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" }, take: 10 });
    const fresh = Boolean(latestSync?.completedAt && Date.now() - latestSync.completedAt.getTime() <= 86_400_000);
    const conflicts = await this.prisma.historicalContactRecord.count({ where: {
      shopId: shop.id, resolutionState: { in: ["UNMATCHED", "CONFLICT"] }, supersededByRecordId: null
    } });
    const historicalContacts = await this.prisma.creatorShopContactState.findMany({
      where: { shopId: shop.id, contactCount: { gt: 0 } }, select: { contactCount: true, creator: { select: {
        creatorOpenId: true, creatorImId: true,
        providerIdentities: { where: { provider: "TIKTOK_SHOP", identityType: "TIKTOK_CREATOR_OPEN_ID", linkState: "VERIFIED" }, select: { identifier: true, evidenceType: true } }
      } } }
    });
    const trustedMarketplaceEvidence = new Set([
      "MARKETPLACE_EXACT_FIELD", "CONVERSATION_EXACT_FIELD", "CONVERSATION_RETURNED_BOTH_IDENTIFIERS", "DOCUMENTED_PROVIDER_MAPPING"
    ]);
    const marketplaceLinked = (item: (typeof historicalContacts)[number]) => Boolean(
      item.creator.creatorOpenId && item.creator.providerIdentities.some((identity) =>
        identity.identifier === item.creator.creatorOpenId && trustedMarketplaceEvidence.has(identity.evidenceType)
      )
    );
    const totalHistoricalCreators = historicalContacts.length;
    const fullyLinkedHistoricalCreators = historicalContacts.filter(marketplaceLinked).length;
    const historicalCreatorsMissingVerifiedMarketplaceIdentity = totalHistoricalCreators - fullyLinkedHistoricalCreators;
    const imOnlyHistoricalCreators = historicalContacts.filter((item) => item.creator.creatorImId && !item.creator.creatorOpenId).length;
    const outboundContactsOnUnresolvedIdentities = historicalContacts
      .filter((item) => !marketplaceLinked(item))
      .reduce((sum, item) => sum + item.contactCount, 0);
    const unresolvedCreatorIdentities = await this.prisma.creatorProviderIdentity.count({
      where: { linkState: "UNRESOLVED", creator: { contacts: { some: { shopId: shop.id, contactCount: { gt: 0 } } } } }
    });
    const paginationComplete = latestSync?.state === "COMPLETE";
    const identityReconciliationComplete = unresolvedCreatorIdentities === 0 && outboundContactsOnUnresolvedIdentities === 0 && conflicts === 0;
    const discoveryUsableForAnalysis = paginationComplete && fresh;
    const futureOutboundSafe = discoveryUsableForAnalysis && identityReconciliationComplete;
    const identityCoveragePercent = totalHistoricalCreators === 0 ? 100 : Math.round((fullyLinkedHistoricalCreators / totalHistoricalCreators) * 10_000) / 100;
    return {
      mode: config.APP_MODE === "mock" ? "MOCK" : "READ_ONLY",
      historyReady: futureOutboundSafe,
      historyPaginationComplete: paginationComplete,
      identityReconciliationComplete,
      discoveryUsableForAnalysis,
      futureOutboundSafe,
      cooldownDedupeCoverageComplete: futureOutboundSafe,
      outboundEnabled: false,
      latestSync,
      imports,
      unresolvedImportConflicts: conflicts,
      identityCoverage: {
        totalHistoricalCreators,
        fullyLinkedHistoricalCreators,
        historicalCreatorsMissingVerifiedMarketplaceIdentity,
        imOnlyHistoricalCreators,
        unresolvedCreatorIdentities,
        outboundContactsOnUnresolvedIdentities,
        percent: identityCoveragePercent
      },
      warning: identityReconciliationComplete ? null : "HISTORY IDENTITY COVERAGE INCOMPLETE",
      blockers: [
      ...(latestSync?.state === "COMPLETE" ? [] : ["A complete TikTok conversation sync is required"]),
      ...(fresh ? [] : ["History sync must be less than 24 hours old"]),
      ...(conflicts ? [`${conflicts} imported rows require identity review`] : []),
      ...(imOnlyHistoricalCreators ? [`${imOnlyHistoricalCreators} IM-only historical creator identities cannot yet be safely linked to Marketplace identities`] : []),
      ...(historicalCreatorsMissingVerifiedMarketplaceIdentity ? [`${historicalCreatorsMissingVerifiedMarketplaceIdentity} historical creators lack a verified Marketplace identity link`] : []),
      ...(outboundContactsOnUnresolvedIdentities ? [`${outboundContactsOnUnresolvedIdentities} outbound historical contacts are attached to unresolved identities`] : []),
      config.APP_MODE === "mock" ? "Only mock outbound dispatch is available" : "Real TikTok outbound is physically unavailable in Phase 2A"
    ] };
  }

  async validateConversationList(adapter?: TikTokReadAdapter) {
    const effectiveAdapter = adapter ?? await this.tiktok.adapter({ validationMode: true });
    const page = await effectiveAdapter.listConversations({ pageSize: 50 });
    return {
      validationMode: true, providerCallCeiling: 1, providerPagesInspected: 1,
      intentionallyTruncated: true, providerHasMore: page.hasMore,
      nextPageToken: page.nextPageToken, conversations: page.items
    };
  }

  async validateMessageList(conversationId: string, creatorImId?: string, adapter?: TikTokReadAdapter) {
    if (!conversationId?.trim()) throw new BadRequestException("A specific conversationId is required for message validation");
    const effectiveAdapter = adapter ?? await this.tiktok.adapter({ validationMode: true });
    const page = await effectiveAdapter.listMessages(conversationId, { pageSize: 20, creatorImId });
    return {
      validationMode: true, providerCallCeiling: 1, providerPagesInspected: 1,
      intentionallyTruncated: true, providerHasMore: page.hasMore,
      nextPageToken: page.nextPageToken, conversationId, messages: page.items
    };
  }
}
