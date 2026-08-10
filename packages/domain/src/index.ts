export type Money = { amount: string; currency: string };

export type CreatorCandidate = {
  creatorOpenId: string;
  creatorUserId?: string;
  username?: string;
  nickname?: string;
  categoryIds: string[];
  followerCount: number | null;
  gmv: Money | null;
  unitsSold: number | null;
  avgVideoViews: number | null;
  avgLiveViewers: number | null;
  engagementRate?: number;
  selectionRegion: string;
  discoveryOrdinal: number;
};

export type CreatorFilters = {
  keyword?: string;
  categoryIds?: string[];
  minFollowers?: number;
  maxFollowers?: number;
  minGmv?: number;
  maxGmv?: number;
  minUnitsSold?: number;
  minAvgVideoViews?: number;
  minAvgLiveViewers?: number;
  minEngagementRate?: number;
};

export type RankingMetric =
  | "GMV"
  | "UNITS_SOLD"
  | "FOLLOWERS"
  | "AVG_VIDEO_VIEWS"
  | "AVG_LIVE_VIEWERS"
  | "ENGAGEMENT_RATE"
  | "TIKTOK_RELEVANCE";

export type ContactState = {
  lastContactedAt?: Date;
  firstContactedAt?: Date;
  contactCount: number;
  doNotContact?: boolean;
  unresolvedDelivery?: boolean;
  historical?: boolean;
};

export type SkipReason =
  | "INVALID_MESSAGING_ID"
  | "FILTER_MISMATCH"
  | "DUPLICATE"
  | "DO_NOT_CONTACT"
  | "DELIVERY_UNKNOWN"
  | "COOLDOWN"
  | "ACTIVE_RESERVATION";

export type EvaluatedCreator = CreatorCandidate & {
  eligibility: "ELIGIBLE" | "EXCLUDED";
  skipReason?: SkipReason;
  skipDetail?: string;
  rankingValue: number;
  selected: boolean;
};

export type PreviewSummary = {
  requested: number;
  fetchedOccurrences: number;
  excludedByFilter: number;
  skippedDuplicates: number;
  skippedDoNotContact: number;
  skippedUnknownDelivery: number;
  skippedCooldown: number;
  skippedActiveReservation: number;
  eligible: number;
  selected: number;
  shortfall: number;
  truncated: boolean;
};

export type PreviewResult = { creators: EvaluatedCreator[]; summary: PreviewSummary };

const numericGmv = (creator: CreatorCandidate): number | null => creator.gmv ? Number(creator.gmv.amount) : null;

export function matchesFilters(creator: CreatorCandidate, filters: CreatorFilters): boolean {
  const keyword = filters.keyword?.trim().toLowerCase();
  if (keyword && !`${creator.username ?? ""} ${creator.nickname ?? ""}`.toLowerCase().includes(keyword)) return false;
  if (filters.categoryIds?.length && !filters.categoryIds.some((id) => creator.categoryIds.includes(id))) return false;
  if (filters.minFollowers != null && (creator.followerCount == null || creator.followerCount < filters.minFollowers)) return false;
  if (filters.maxFollowers != null && (creator.followerCount == null || creator.followerCount > filters.maxFollowers)) return false;
  const gmv = numericGmv(creator);
  if (filters.minGmv != null && (gmv == null || gmv < filters.minGmv)) return false;
  if (filters.maxGmv != null && (gmv == null || gmv > filters.maxGmv)) return false;
  if (filters.minUnitsSold != null && (creator.unitsSold == null || creator.unitsSold < filters.minUnitsSold)) return false;
  if (filters.minAvgVideoViews != null && (creator.avgVideoViews == null || creator.avgVideoViews < filters.minAvgVideoViews)) return false;
  if (filters.minAvgLiveViewers != null && (creator.avgLiveViewers == null || creator.avgLiveViewers < filters.minAvgLiveViewers)) return false;
  if (filters.minEngagementRate != null && (creator.engagementRate == null || creator.engagementRate < filters.minEngagementRate)) return false;
  return true;
}

export function rankingValue(creator: CreatorCandidate, metric: RankingMetric): number {
  switch (metric) {
    case "GMV": return numericGmv(creator) ?? Number.MIN_SAFE_INTEGER;
    case "UNITS_SOLD": return creator.unitsSold ?? Number.MIN_SAFE_INTEGER;
    case "FOLLOWERS": return creator.followerCount ?? Number.MIN_SAFE_INTEGER;
    case "AVG_VIDEO_VIEWS": return creator.avgVideoViews ?? Number.MIN_SAFE_INTEGER;
    case "AVG_LIVE_VIEWERS": return creator.avgLiveViewers ?? Number.MIN_SAFE_INTEGER;
    case "ENGAGEMENT_RATE": return creator.engagementRate ?? Number.MIN_SAFE_INTEGER;
    case "TIKTOK_RELEVANCE": return -creator.discoveryOrdinal;
  }
}

export function renderMessage(template: string, values: { creatorDisplayName: string; productName: string; campaignName: string }): string {
  const allowed = new Set(["creator_display_name", "product_name", "campaign_name"]);
  for (const match of template.matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
    const placeholder = match[1].trim();
    if (!allowed.has(placeholder)) throw new Error(`Unsupported template placeholder: ${placeholder}`);
  }
  const rendered = template
    .replace(/{{\s*creator_display_name\s*}}/g, values.creatorDisplayName)
    .replace(/{{\s*product_name\s*}}/g, values.productName)
    .replace(/{{\s*campaign_name\s*}}/g, values.campaignName);
  if (/{{|}}/.test(rendered)) throw new Error("Message template contains an invalid or unclosed placeholder");
  return rendered;
}

export function buildPreview(input: {
  creators: CreatorCandidate[];
  filters: CreatorFilters;
  contacts: Map<string, ContactState>;
  activeReservations: Set<string>;
  requested: number;
  cooldownDays: number;
  rankingMetric: RankingMetric;
  rankingDirection?: "ASC" | "DESC";
  now: Date;
  truncated?: boolean;
}): PreviewResult {
  const seen = new Set<string>();
  const cutoff = new Date(input.now.getTime() - input.cooldownDays * 86_400_000);
  const creators: EvaluatedCreator[] = input.creators.map((creator) => {
    const contact = input.contacts.get(creator.creatorOpenId);
    let skipReason: SkipReason | undefined;
    let skipDetail: string | undefined;
    if (!creator.creatorOpenId) skipReason = "INVALID_MESSAGING_ID";
    else if (!matchesFilters(creator, input.filters)) skipReason = "FILTER_MISMATCH";
    else if (seen.has(creator.creatorOpenId)) skipReason = "DUPLICATE";
    else if (contact?.doNotContact) skipReason = "DO_NOT_CONTACT";
    else if (contact?.unresolvedDelivery) skipReason = "DELIVERY_UNKNOWN";
    else if (contact?.lastContactedAt && contact.lastContactedAt > cutoff) {
      skipReason = "COOLDOWN";
      skipDetail = `${contact.historical ? "Historical" : "App"} contact at ${contact.lastContactedAt.toISOString()}`;
    } else if (input.activeReservations.has(creator.creatorOpenId)) skipReason = "ACTIVE_RESERVATION";
    if (creator.creatorOpenId) seen.add(creator.creatorOpenId);
    return {
      ...creator,
      eligibility: skipReason ? "EXCLUDED" : "ELIGIBLE",
      skipReason,
      skipDetail,
      rankingValue: rankingValue(creator, input.rankingMetric),
      selected: false
    };
  });

  const eligible = creators.filter((creator) => creator.eligibility === "ELIGIBLE");
  const multiplier = input.rankingDirection === "ASC" ? 1 : -1;
  eligible.sort((a, b) => {
    const byMetric = (a.rankingValue - b.rankingValue) * multiplier;
    return byMetric || a.creatorOpenId.localeCompare(b.creatorOpenId);
  });
  eligible.slice(0, input.requested).forEach((creator) => { creator.selected = true; });

  const count = (reason: SkipReason) => creators.filter((creator) => creator.skipReason === reason).length;
  const selected = Math.min(input.requested, eligible.length);
  return {
    creators,
    summary: {
      requested: input.requested,
      fetchedOccurrences: creators.length,
      excludedByFilter: count("FILTER_MISMATCH") + count("INVALID_MESSAGING_ID"),
      skippedDuplicates: count("DUPLICATE"),
      skippedDoNotContact: count("DO_NOT_CONTACT"),
      skippedUnknownDelivery: count("DELIVERY_UNKNOWN"),
      skippedCooldown: count("COOLDOWN"),
      skippedActiveReservation: count("ACTIVE_RESERVATION"),
      eligible: eligible.length,
      selected,
      shortfall: Math.max(0, input.requested - selected),
      truncated: Boolean(input.truncated)
    }
  };
}

export type SafetyLimits = {
  maxRecipientsPerCampaign: number;
  maxDispatchAttemptsPerCampaign: number;
  maxSendsPerDay: number;
  maxDispatchesPerMinute: number;
};

export function assertCampaignWithinLimit(requested: number, limits: SafetyLimits): void {
  if (!Number.isInteger(requested) || requested < 1) throw new Error("Target count must be a positive integer");
  if (requested > limits.maxRecipientsPerCampaign) throw new Error(`Target exceeds the campaign recipient ceiling of ${limits.maxRecipientsPerCampaign}`);
}

export type ReconciliationMessage = {
  id: string;
  conversationId: string;
  direction: "OUTBOUND" | "INBOUND";
  contentHash: string;
  createdAt: Date;
};

export function reconcileUnknownDelivery(input: {
  conversationId: string;
  contentHash: string;
  dispatchedAt: Date;
  messages: ReconciliationMessage[];
  alreadyLinkedMessageIds: Set<string>;
}): { status: "MATCHED"; messageId: string } | { status: "UNRESOLVED"; reason: string } {
  const windowStart = input.dispatchedAt.getTime() - 30_000;
  const windowEnd = input.dispatchedAt.getTime() + 2 * 60 * 60 * 1000;
  const matches = input.messages.filter((message) =>
    message.conversationId === input.conversationId &&
    message.direction === "OUTBOUND" &&
    message.contentHash === input.contentHash &&
    message.createdAt.getTime() >= windowStart &&
    message.createdAt.getTime() <= windowEnd &&
    !input.alreadyLinkedMessageIds.has(message.id)
  );
  if (matches.length === 1) return { status: "MATCHED", messageId: matches[0].id };
  return { status: "UNRESOLVED", reason: matches.length === 0 ? "No exact outbound match" : "Multiple outbound matches" };
}
