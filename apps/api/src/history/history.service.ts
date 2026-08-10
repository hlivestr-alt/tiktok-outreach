import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { Prisma } from "@affiliate/db";
import { MockTikTokAffiliateAdapter } from "@affiliate/tiktok-adapter";
import { ensureMockShop, PrismaService } from "../shared";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

@Injectable()
export class HistoryService {
  private readonly adapter = new MockTikTokAffiliateAdapter();
  constructor(private readonly prisma: PrismaService) {}

  async contacts() {
    const shop = await ensureMockShop(this.prisma);
    const contacts = await this.prisma.creatorShopContactState.findMany({
      where: { shopId: shop.id }, orderBy: [{ lastContactedAt: "desc" }, { updatedAt: "desc" }], take: 500,
      include: { creator: { include: {
        snapshots: { orderBy: { sourceFetchedAt: "desc" }, take: 1 },
        conversations: { where: { shopId: shop.id }, orderBy: { lastSyncedAt: "desc" }, take: 1 }
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
    return contacts.map((contact) => ({
      id: contact.id,
      creatorOpenId: contact.creator.creatorOpenId,
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
    }));
  }

  async syncMockHistory() {
    const shop = await ensureMockShop(this.prisma);
    const run = await this.prisma.contactHistorySyncRun.create({ data: { shopId: shop.id, source: "MOCK_TIKTOK", state: "RUNNING", startedAt: new Date() } });
    try {
      const conversations = await this.adapter.listConversations();
      let earliest: Date | undefined;
      let latest: Date | undefined;
      let imported = 0;
      for (const providerConversation of conversations) {
        const creator = await this.prisma.creator.upsert({ where: { creatorOpenId: providerConversation.creatorOpenId }, update: {}, create: { creatorOpenId: providerConversation.creatorOpenId, selectionRegion: "ID" } });
        const conversation = await this.prisma.conversation.upsert({
          where: { externalConversationId: providerConversation.id },
          update: { lastSyncedAt: new Date() },
          create: { shopId: shop.id, creatorId: creator.id, externalConversationId: providerConversation.id, lastSyncedAt: new Date() }
        });
        const messages = await this.adapter.listMessages(providerConversation.id);
        for (const message of messages.filter((item) => item.direction === "OUTBOUND")) {
          const existingMessage = await this.prisma.conversationMessage.findUnique({ where: { externalMessageId: message.id } });
          await this.prisma.conversationMessage.upsert({
            where: { externalMessageId: message.id }, update: {},
            create: { conversationId: conversation.id, externalMessageId: message.id, direction: "OUTBOUND", content: message.content, contentHash: hash(message.content), providerCreatedAt: message.createdAt, importSource: "MOCK_TIKTOK" }
          });
          const existing = await this.prisma.creatorShopContactState.findUnique({ where: { shopId_creatorId: { shopId: shop.id, creatorId: creator.id } } });
          await this.prisma.creatorShopContactState.upsert({
            where: { shopId_creatorId: { shopId: shop.id, creatorId: creator.id } },
            update: {
              firstContactedAt: existing?.firstContactedAt && existing.firstContactedAt < message.createdAt ? existing.firstContactedAt : message.createdAt,
              lastContactedAt: existing?.lastContactedAt && existing.lastContactedAt > message.createdAt ? existing.lastContactedAt : message.createdAt,
              contactCount: existingMessage ? undefined : { increment: 1 },
              historyCoverageStart: existing?.historyCoverageStart && existing.historyCoverageStart < message.createdAt
                ? existing.historyCoverageStart : message.createdAt
            },
            create: { shopId: shop.id, creatorId: creator.id, firstContactedAt: message.createdAt, lastContactedAt: message.createdAt, contactCount: 1, historyCoverageStart: message.createdAt }
          });
          earliest = !earliest || message.createdAt < earliest ? message.createdAt : earliest;
          latest = !latest || message.createdAt > latest ? message.createdAt : latest;
          if (!existingMessage) imported++;
        }
      }
      const unreadMessages = await this.adapter.getLatestUnreadMessages();
      for (const message of unreadMessages) {
        const existingMessage = await this.prisma.conversationMessage.findUnique({ where: { externalMessageId: message.id } });
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
            content: message.content, contentHash: hash(message.content), providerCreatedAt: message.createdAt, importSource: "MOCK_TIKTOK"
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
        state: "COMPLETE", completedAt: new Date(), conversationsScanned: conversations.length,
        messagesImported: imported, earliestCoveredAt: earliest, latestCoveredAt: latest
      }});
    } catch (error) {
      await this.prisma.contactHistorySyncRun.update({ where: { id: run.id }, data: { state: "FAILED", completedAt: new Date(), error: error instanceof Error ? error.message : "Unknown sync error" } });
      throw error;
    }
  }

  async importCsv(input: { sourceName: string; csv: string }) {
    if (!input.sourceName || !input.csv) throw new BadRequestException("sourceName and csv are required");
    const shop = await ensureMockShop(this.prisma);
    const sourceHash = hash(input.csv);
    const prior = await this.prisma.historicalContactImport.findUnique({ where: { shopId_sourceHash: { shopId: shop.id, sourceHash } } });
    if (prior) return prior;
    const rows = parse(input.csv, { columns: true, skip_empty_lines: true, trim: true }) as Array<Record<string, string>>;
    const historicalImport = await this.prisma.historicalContactImport.create({ data: { shopId: shop.id, sourceName: input.sourceName, sourceHash, state: "RUNNING", rowCount: rows.length } });
    let importedCount = 0;
    let unmatchedCount = 0;
    let conflictCount = 0;
    for (const [index, row] of rows.entries()) {
      const contactedAt = new Date(row.contacted_at);
      let creatorOpenId: string | undefined = row.creator_open_id?.trim() || undefined;
      const conversationId: string | undefined = row.conversation_id?.trim() || undefined;
      if (!creatorOpenId && conversationId) {
        const existingConversation = await this.prisma.conversation.findUnique({
          where: { externalConversationId: conversationId }, include: { creator: true }
        });
        creatorOpenId = existingConversation?.creator.creatorOpenId;
      }
      const resolutionState = creatorOpenId ? "MATCHED" : "UNMATCHED";
      if (Number.isNaN(contactedAt.getTime())) { conflictCount++; continue; }
      const sourceRecordId = row.source_record_id || `${index + 1}:${hash(JSON.stringify(row)).slice(0, 12)}`;
      await this.prisma.historicalContactRecord.create({ data: {
        importId: historicalImport.id, sourceRecordId, creatorOpenId: creatorOpenId || null, conversationId: conversationId || null,
        externalMessageId: row.external_message_id || null, contactedAt, sendStatus: (row.send_status || "SENT").toUpperCase(),
        campaignName: row.campaign_name || null, messageContent: row.message_body || null, resolutionState
      }});
      if (!creatorOpenId) { unmatchedCount++; continue; }
      const creator = await this.prisma.creator.upsert({ where: { creatorOpenId }, update: {}, create: { creatorOpenId, username: row.username || null, selectionRegion: "ID" } });
      const status = (row.send_status || "SENT").toUpperCase();
      if (status === "SENT") {
        const existing = await this.prisma.creatorShopContactState.findUnique({ where: { shopId_creatorId: { shopId: shop.id, creatorId: creator.id } } });
        await this.prisma.creatorShopContactState.upsert({
          where: { shopId_creatorId: { shopId: shop.id, creatorId: creator.id } },
          update: {
            firstContactedAt: existing?.firstContactedAt && existing.firstContactedAt < contactedAt ? existing.firstContactedAt : contactedAt,
            lastContactedAt: existing?.lastContactedAt && existing.lastContactedAt > contactedAt ? existing.lastContactedAt : contactedAt,
            contactCount: { increment: 1 },
            historyCoverageStart: existing?.historyCoverageStart && existing.historyCoverageStart < contactedAt
              ? existing.historyCoverageStart : contactedAt
          },
          create: { shopId: shop.id, creatorId: creator.id, firstContactedAt: contactedAt, lastContactedAt: contactedAt, contactCount: 1, historyCoverageStart: contactedAt }
        });
      } else if (status === "UNKNOWN") {
        await this.prisma.creatorShopContactState.upsert({ where: { shopId_creatorId: { shopId: shop.id, creatorId: creator.id } }, update: { unresolvedDelivery: true }, create: { shopId: shop.id, creatorId: creator.id, unresolvedDelivery: true } });
      }
      importedCount++;
    }
    return this.prisma.historicalContactImport.update({ where: { id: historicalImport.id }, data: {
      state: unmatchedCount || conflictCount ? "PARTIAL" : "COMPLETE", importedCount, unmatchedCount, conflictCount, completedAt: new Date()
    }});
  }

  async readiness() {
    const shop = await ensureMockShop(this.prisma);
    const latestSync = await this.prisma.contactHistorySyncRun.findFirst({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" } });
    const imports = await this.prisma.historicalContactImport.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" }, take: 10 });
    const fresh = Boolean(latestSync?.completedAt && Date.now() - latestSync.completedAt.getTime() <= 86_400_000);
    const conflicts = imports.reduce((sum, item) => sum + item.unmatchedCount + item.conflictCount, 0);
    const historyReady = latestSync?.state === "COMPLETE" && fresh && conflicts === 0;
    return { mode: "MOCK", historyReady, liveReady: false, latestSync, imports, blockers: [
      ...(latestSync?.state === "COMPLETE" ? [] : ["A complete TikTok conversation sync is required"]),
      ...(fresh ? [] : ["History sync must be less than 24 hours old"]),
      ...(conflicts ? [`${conflicts} imported rows require identity review`] : []),
      "Production sending is not implemented in phase one"
    ] };
  }
}
