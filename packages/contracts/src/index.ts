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

export type CampaignCloneFromPreviewInput = {
  name: string;
  productName: string;
  messageTemplate: string;
  targetCount: number;
};

export type CreatorSearchPage = {
  creators: CreatorCandidate[];
  nextPageToken?: string;
  searchKey: string;
  hasMore: boolean;
};

export type AdapterCapabilities = {
  mode: "MOCK" | "READ_ONLY" | "LIVE" | "DISABLED";
  market: "ID";
  currency: string | null;
  currencySource: "MOCK_FIXED" | "PROVIDER_RESPONSE_REQUIRED";
  pageSizes: number[];
  filters: string[];
  rankingMetrics: RankingMetric[];
  messageTypes: ["TEXT"];
  maxMessageLength: number;
};

export type ProviderMessage = {
  id: string;
  conversationId: string;
  creatorOpenId?: string;
  creatorImId?: string;
  direction: "OUTBOUND" | "INBOUND";
  content: string;
  createdAt: Date;
};

export type ProviderPage<T> = {
  items: T[];
  nextPageToken?: string;
  hasMore: boolean;
};

export type ProviderConversation = { id: string; creatorOpenId?: string; creatorImId: string; username?: string; avatarUrl?: string; unreadCount?: number };

export type SendMessageResult =
  | { status: "SENT"; messageId: string; requestId: string }
  | { status: "DELIVERY_UNKNOWN"; requestId: string }
  | { status: "RETRYABLE_ERROR" | "QUOTA_LIMITED"; requestId: string; errorCode: string; retryAfterMs: number }
  | { status: "RESTRICTED"; requestId: string; errorCode: string };

export type AuthorizedTikTokShop = { id: string; cipher: string; code?: string; name: string; region: string; sellerType?: string };

export interface TikTokReadAdapter {
  getCapabilities(): Promise<AdapterCapabilities>;
  searchCreators(filters: CreatorFilters, cursor?: { pageToken?: string; searchKey?: string; pageSize: number }): Promise<CreatorSearchPage>;
  getCreatorPerformance(creatorOpenId: string): Promise<CreatorCandidate>;
  getAuthorizedShops?(): Promise<AuthorizedTikTokShop[]>;
  listConversations(cursor?: { pageToken?: string; pageSize: number }): Promise<ProviderPage<ProviderConversation>>;
  listMessages(conversationId: string, cursor?: { pageToken?: string; pageSize: number; creatorImId?: string }): Promise<ProviderPage<ProviderMessage>>;
  getLatestUnreadMessages?(): Promise<ProviderMessage[]>;
}

export interface TikTokAffiliateAdapter extends TikTokReadAdapter {
  createOrGetConversation(creatorOpenId: string): Promise<{ conversationId: string; isNew: boolean }>;
  sendMessage(conversationId: string, creatorOpenId: string, content: string, options: { idempotencyKey: string }): Promise<SendMessageResult>;
}

/** The outbound worker receives this deliberately narrow capability. */
export type TikTokOutboundAdapter = Pick<TikTokAffiliateAdapter, "createOrGetConversation" | "sendMessage">;
