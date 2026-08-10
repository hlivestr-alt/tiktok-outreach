import { describe, expect, it } from "vitest";
import { DisabledTikTokAffiliateAdapter, MockTikTokAffiliateAdapter, generateMockCreators } from "./index";

describe("mock TikTok adapter", () => {
  it("provides 1,540 deterministic occurrences including 40 duplicates", () => {
    const creators = generateMockCreators();
    expect(creators).toHaveLength(1540);
    expect(new Set(creators.map((creator) => creator.creatorOpenId)).size).toBe(1500);
  });

  it("never permits the disabled adapter to reach a provider", async () => {
    const adapter = new DisabledTikTokAffiliateAdapter();
    await expect(adapter.sendMessage("c", "u", "message", { idempotencyKey: "delivery-1" })).rejects.toThrow("not implemented");
  });

  it("returns paginated mock creators", async () => {
    const page = await new MockTikTokAffiliateAdapter().searchCreators({}, { pageSize: 20 });
    expect(page.creators).toHaveLength(20);
    expect(page.hasMore).toBe(true);
  });

  it("simulates a retryable provider error before succeeding", async () => {
    const adapter = new MockTikTokAffiliateAdapter();
    await expect(adapter.sendMessage("c", "mock_creator_00041", "message", { idempotencyKey: "delivery-1" })).resolves.toMatchObject({ status: "RETRYABLE_ERROR" });
    await expect(adapter.sendMessage("c", "mock_creator_00041", "message", { idempotencyKey: "delivery-1" })).resolves.toMatchObject({ status: "SENT" });
  });

  it("simulates ambiguous network outcomes for reconciliation", async () => {
    const adapter = new MockTikTokAffiliateAdapter();
    await expect(adapter.sendMessage("c", "mock_creator_00053", "message", { idempotencyKey: "delivery-1" })).rejects.toThrow("NETWORK_TIMEOUT");
  });

  it("uses the delivery idempotency key so identical text in separate campaigns gets unique provider ids", async () => {
    const adapter = new MockTikTokAffiliateAdapter();
    const first = await adapter.sendMessage("c", "mock_creator_00001", "same text", { idempotencyKey: "campaign-1:creator-1" });
    const second = await adapter.sendMessage("c", "mock_creator_00001", "same text", { idempotencyKey: "campaign-2:creator-1" });
    expect(first).toMatchObject({ status: "SENT" });
    expect(second).toMatchObject({ status: "SENT" });
    if (first.status === "SENT" && second.status === "SENT") expect(first.messageId).not.toBe(second.messageId);
  });

  it("paginates conversation and message history", async () => {
    const adapter = new MockTikTokAffiliateAdapter();
    const conversations = await adapter.listConversations({ pageSize: 2 });
    expect(conversations.items).toHaveLength(2);
    expect(conversations.nextPageToken).toBe("2");
    const messages = await adapter.listMessages(conversations.items[0].id, { pageSize: 1 });
    expect(messages.items).toHaveLength(1);
  });
});
