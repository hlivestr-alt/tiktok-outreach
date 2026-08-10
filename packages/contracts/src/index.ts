import type { CreatorCandidate, CreatorFilters, RankingMetric } from "@affiliate/domain";

export type CampaignCreateInput = {
  name: string;
  productName: string;
  targetCount: number;
  candidateLimit?: number;
  cooldownDays: number;
  messageTemplate: string;
  filters: CreatorFilters;
  rankingMetric: RankingMetric;
  rankingDirection?: "ASC" | "DESC";
};

export type CreatorSearchPage = {
  creators: CreatorCandidate[];
  nextPageToken?: string;
  searchKey: string;
  hasMore: boolean;
};

export type AdapterCapabilities = {
  mode: "MOCK" | "DISABLED";
  market: "ID";
  currency: "IDR";
  pageSizes: number[];
  filters: string[];
  rankingMetrics: RankingMetric[];
  messageTypes: ["TEXT"];
  maxMessageLength: number;
};

export type ProviderMessage = {
  id: string;
  conversationId: string;
  creatorOpenId: string;
  direction: "OUTBOUND" | "INBOUND";
  content: string;
  createdAt: Date;
};

export type SendMessageResult =
  | { status: "SENT"; messageId: string; requestId: string }
  | { status: "DELIVERY_UNKNOWN"; requestId: string }
  | { status: "RETRYABLE_ERROR" | "QUOTA_LIMITED"; requestId: string; errorCode: string; retryAfterMs: number }
  | { status: "RESTRICTED"; requestId: string; errorCode: string };

export interface TikTokAffiliateAdapter {
  getCapabilities(): Promise<AdapterCapabilities>;
  searchCreators(filters: CreatorFilters, cursor?: { pageToken?: string; searchKey?: string; pageSize: number }): Promise<CreatorSearchPage>;
  getCreatorPerformance(creatorOpenId: string): Promise<CreatorCandidate>;
  createOrGetConversation(creatorOpenId: string): Promise<{ conversationId: string; isNew: boolean }>;
  sendMessage(conversationId: string, creatorOpenId: string, content: string): Promise<SendMessageResult>;
  listConversations(): Promise<Array<{ id: string; creatorOpenId: string }>>;
  listMessages(conversationId: string): Promise<ProviderMessage[]>;
  getLatestUnreadMessages(): Promise<ProviderMessage[]>;
}
