import { createHash } from "node:crypto";
import type { TikTokAffiliateAdapter, AdapterCapabilities, CreatorSearchPage, ProviderMessage, SendMessageResult } from "@affiliate/contracts";
import type { CreatorCandidate, CreatorFilters } from "@affiliate/domain";

const categories = ["beauty", "fashion", "home", "health", "food"];
const names = ["Ayu", "Bintang", "Citra", "Dewi", "Eka", "Fitri", "Gita", "Hana", "Intan", "Joko"];

export function generateMockCreators(): CreatorCandidate[] {
  const unique = Array.from({ length: 1500 }, (_, index): CreatorCandidate => {
    const id = `mock_creator_${String(index + 1).padStart(5, "0")}`;
    const followerCount = 1_000 + ((index * 7_919) % 490_000);
    const gmv = 100_000 + ((index * 982_451) % 250_000_000);
    return {
      creatorOpenId: id,
      creatorUserId: `uid_${index + 1}`,
      username: `creator.id.${index + 1}`,
      nickname: `${names[index % names.length]} ${index + 1}`,
      categoryIds: [categories[index % categories.length]],
      followerCount,
      gmv: { amount: String(gmv), currency: "IDR" },
      unitsSold: (index * 37) % 2500,
      avgVideoViews: 500 + ((index * 541) % 500_000),
      avgLiveViewers: 20 + ((index * 97) % 20_000),
      engagementRate: Number((0.01 + ((index * 13) % 180) / 1000).toFixed(4)),
      selectionRegion: "ID",
      discoveryOrdinal: index
    };
  });
  const duplicates = unique.slice(0, 40).map((creator, index) => ({ ...creator, discoveryOrdinal: 1500 + index }));
  return [...unique, ...duplicates];
}

const allCreators = generateMockCreators();

export class MockTikTokAffiliateAdapter implements TikTokAffiliateAdapter {
  private readonly sendAttempts = new Map<string, number>();
  async getCapabilities(): Promise<AdapterCapabilities> {
    return {
      mode: "MOCK", market: "ID", currency: "IDR", pageSizes: [12, 20], messageTypes: ["TEXT"], maxMessageLength: 2000,
      filters: ["keyword", "category", "followers", "gmv", "unitsSold", "avgVideoViews", "avgLiveViewers", "engagementRate", "followerDemographics"],
      rankingMetrics: ["GMV", "UNITS_SOLD", "FOLLOWERS", "AVG_VIDEO_VIEWS", "AVG_LIVE_VIEWERS", "ENGAGEMENT_RATE", "TIKTOK_RELEVANCE"]
    };
  }

  async searchCreators(
    _filters: CreatorFilters,
    cursor: { pageToken?: string; searchKey?: string; pageSize: number } = { pageSize: 20 }
  ): Promise<CreatorSearchPage> {
    const offset = Number(cursor.pageToken ?? 0);
    const pageSize = cursor.pageSize || 20;
    const creators = allCreators.slice(offset, offset + pageSize);
    const next = offset + creators.length;
    return {
      creators,
      searchKey: cursor.searchKey ?? "mock-stable-search-key",
      nextPageToken: next < allCreators.length ? String(next) : undefined,
      hasMore: next < allCreators.length
    };
  }

  async getCreatorPerformance(creatorOpenId: string): Promise<CreatorCandidate> {
    const found = allCreators.find((creator) => creator.creatorOpenId === creatorOpenId);
    if (!found) throw new Error("Mock creator not found");
    return found;
  }

  async createOrGetConversation(creatorOpenId: string): Promise<{ conversationId: string; isNew: boolean }> {
    return { conversationId: `mock_conversation_${creatorOpenId}`, isNew: false };
  }

  async sendMessage(_conversationId: string, creatorOpenId: string, content: string): Promise<SendMessageResult> {
    const numeric = Number(creatorOpenId.slice(-5));
    const attempt = (this.sendAttempts.get(creatorOpenId) ?? 0) + 1;
    this.sendAttempts.set(creatorOpenId, attempt);
    const requestId = `mock_request_${creatorOpenId}_${Date.now()}`;
    if (numeric % 43 === 0) return { status: "RESTRICTED", requestId, errorCode: "CREATOR_MESSAGING_RESTRICTED" };
    if (numeric % 47 === 0 && attempt === 1) return { status: "QUOTA_LIMITED", requestId, errorCode: "MOCK_QUOTA_LIMIT", retryAfterMs: 1500 };
    if (numeric % 41 === 0 && attempt === 1) return { status: "RETRYABLE_ERROR", requestId, errorCode: "MOCK_TEMPORARY_ERROR", retryAfterMs: 750 };
    if (numeric % 53 === 0 && attempt === 1) throw new Error("MOCK_NETWORK_TIMEOUT_AFTER_DISPATCH");
    if (numeric % 37 === 0) return { status: "DELIVERY_UNKNOWN", requestId };
    const digest = createHash("sha256").update(`${creatorOpenId}:${content}`).digest("hex").slice(0, 20);
    return { status: "SENT", messageId: `mock_message_${digest}`, requestId };
  }

  async listConversations(): Promise<Array<{ id: string; creatorOpenId: string }>> {
    return allCreators.slice(0, 230).map((creator) => ({ id: `mock_conversation_${creator.creatorOpenId}`, creatorOpenId: creator.creatorOpenId }));
  }

  async listMessages(conversationId: string): Promise<ProviderMessage[]> {
    const creatorOpenId = conversationId.replace("mock_conversation_", "");
    const index = Number(creatorOpenId.slice(-5)) || 1;
    return [{
      id: `historical_message_${creatorOpenId}`,
      conversationId,
      creatorOpenId,
      direction: "OUTBOUND",
      content: `Historical outreach to ${creatorOpenId}`,
      createdAt: new Date(Date.now() - (1 + (index % 29)) * 86_400_000)
    }];
  }

  async getLatestUnreadMessages(): Promise<ProviderMessage[]> {
    return [{
      id: "mock_reply_1", conversationId: "mock_conversation_mock_creator_00001", creatorOpenId: "mock_creator_00001",
      direction: "INBOUND", content: "Terima kasih, saya tertarik!", createdAt: new Date()
    }];
  }
}

export class DisabledTikTokAffiliateAdapter implements TikTokAffiliateAdapter {
  private disabled(): never { throw new Error("TikTok outbound integration is not implemented. APP_MODE must remain mock."); }
  async getCapabilities(): Promise<AdapterCapabilities> { return { mode: "DISABLED", market: "ID", currency: "IDR", pageSizes: [], filters: [], rankingMetrics: [], messageTypes: ["TEXT"], maxMessageLength: 0 }; }
  async searchCreators(_filters: CreatorFilters, _cursor?: { pageToken?: string; searchKey?: string; pageSize: number }): Promise<CreatorSearchPage> { return this.disabled(); }
  async getCreatorPerformance(_creatorOpenId: string): Promise<CreatorCandidate> { return this.disabled(); }
  async createOrGetConversation(_creatorOpenId: string): Promise<{ conversationId: string; isNew: boolean }> { return this.disabled(); }
  async sendMessage(_conversationId: string, _creatorOpenId: string, _content: string): Promise<SendMessageResult> { return this.disabled(); }
  async listConversations(): Promise<Array<{ id: string; creatorOpenId: string }>> { return this.disabled(); }
  async listMessages(_conversationId: string): Promise<ProviderMessage[]> { return this.disabled(); }
  async getLatestUnreadMessages(): Promise<ProviderMessage[]> { return this.disabled(); }
}
