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
    await expect(adapter.sendMessage("c", "u", "message")).rejects.toThrow("not implemented");
  });

  it("returns paginated mock creators", async () => {
    const page = await new MockTikTokAffiliateAdapter().searchCreators({}, { pageSize: 20 });
    expect(page.creators).toHaveLength(20);
    expect(page.hasMore).toBe(true);
  });

  it("simulates a retryable provider error before succeeding", async () => {
    const adapter = new MockTikTokAffiliateAdapter();
    await expect(adapter.sendMessage("c", "mock_creator_00041", "message")).resolves.toMatchObject({ status: "RETRYABLE_ERROR" });
    await expect(adapter.sendMessage("c", "mock_creator_00041", "message")).resolves.toMatchObject({ status: "SENT" });
  });

  it("simulates ambiguous network outcomes for reconciliation", async () => {
    const adapter = new MockTikTokAffiliateAdapter();
    await expect(adapter.sendMessage("c", "mock_creator_00053", "message")).rejects.toThrow("NETWORK_TIMEOUT");
  });
});
