import { describe, expect, it, vi } from "vitest";
import type { CreatorCandidate } from "@affiliate/domain";
import {
  matchesFollowerRange,
  parseArguments,
  ProbeRequestFailure,
  runMarketplaceProbe,
  sanitizeCreator,
  type ProbeRequest,
  type ProbeRequestSuccess
} from "./marketplace-discovery-probe";

function creator(id: string, followerCount: number): CreatorCandidate {
  return {
    creatorOpenId: id,
    username: `test-user-${followerCount}`,
    nickname: `Test Creator ${followerCount}`,
    categoryIds: ["60001"],
    followerCount,
    gmv: { amount: "12.50", currency: "IDR" },
    unitsSold: null,
    avgVideoViews: null,
    avgLiveViewers: null,
    selectionRegion: "ID",
    discoveryOrdinal: 0
  };
}

function page(creators: CreatorCandidate[], options: { searchKey?: string; nextPageToken?: string } = {}): ProbeRequestSuccess {
  return {
    creators,
    searchKey: options.searchKey ?? "search-key-exact",
    nextPageToken: options.nextPageToken,
    timestamp: "2026-08-13T00:00:00.000Z",
    durationMs: 10,
    httpStatus: 200,
    providerCode: 0,
    requestId: "safe-request"
  };
}

describe("Marketplace discovery probe", () => {
  it("filters followers locally with inclusive 1000 and 1500 boundaries", () => {
    expect(matchesFollowerRange(creator("below", 999))).toBe(false);
    expect(matchesFollowerRange(creator("minimum", 1000))).toBe(true);
    expect(matchesFollowerRange(creator("middle", 1250))).toBe(true);
    expect(matchesFollowerRange(creator("maximum", 1500))).toBe(true);
    expect(matchesFollowerRange(creator("above", 1501))).toBe(false);
  });

  it("enforces the controlled diagnostic safety ceilings", () => {
    expect(() => parseArguments(["--target", "20", "--max-pages", "13", "--delay-ms", "3000"])).toThrow(/cannot exceed/i);
    expect(() => parseArguments(["--target", "20", "--max-pages", "12", "--delay-ms", "2999"])).toThrow(/at least 3000/i);
    expect(parseArguments(["--target", "20", "--max-pages", "12", "--delay-ms", "3000"])).toMatchObject({
      mode: "PAGINATED", target: 20, maxPages: 12, delayMs: 3000
    });
  });

  it("deduplicates exact Creator Open IDs and stops at target 20", async () => {
    const first = Array.from({ length: 15 }, (_, index) => creator(`id-${index}`, 1200));
    const second = [first[0], ...Array.from({ length: 10 }, (_, index) => creator(`id-next-${index}`, 1300))];
    const request = vi.fn<ProbeRequest>()
      .mockResolvedValueOnce(page(first, { nextPageToken: "token-2" }))
      .mockResolvedValueOnce(page(second, { nextPageToken: "token-3" }));
    const result = await runMarketplaceProbe({ mode: "PAGINATED", target: 20, maxPages: 12, delayMs: 0 }, { request });
    expect(result.stopReason).toBe("TARGET_REACHED");
    expect(result.matchedCreators).toHaveLength(20);
    expect(new Set(result.matchedCreators.map((item) => item.creatorOpenId))).toHaveLength(20);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("stops at max pages", async () => {
    const request = vi.fn<ProbeRequest>().mockResolvedValue(page([], { nextPageToken: "another" }));
    const result = await runMarketplaceProbe({ mode: "PAGINATED", target: 20, maxPages: 3, delayMs: 0 }, { request });
    expect(result.stopReason).toBe("MAX_PAGES_REACHED");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("stops immediately on 36009002 with no retry", async () => {
    const request = vi.fn<ProbeRequest>().mockRejectedValue(new ProbeRequestFailure({
      timestamp: "2026-08-13T00:00:00.000Z",
      durationMs: 10,
      httpStatus: 429,
      providerCode: 36009002,
      requestId: "throttle-request"
    }, "too many requests"));
    const result = await runMarketplaceProbe({ mode: "PAGINATED", target: 20, maxPages: 12, delayMs: 0 }, { request });
    expect(result.stopReason).toBe("THROTTLED_AT_PAGE_1");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reports 45101004 as daily quota reached even when HTTP status is 429", async () => {
    const request = vi.fn<ProbeRequest>().mockRejectedValue(new ProbeRequestFailure({
      timestamp: "2026-08-13T00:00:00.000Z",
      durationMs: 10,
      httpStatus: 429,
      providerCode: 45101004,
      requestId: "quota-request"
    }, "quota reached"));
    const result = await runMarketplaceProbe({ mode: "PAGINATED", target: 20, maxPages: 12, delayMs: 0 }, { request });
    expect(result.stopReason).toBe("DAILY_QUOTA_REACHED_AT_PAGE_1");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reuses the first search_key and each previous next_page_token exactly", async () => {
    const request = vi.fn<ProbeRequest>()
      .mockResolvedValueOnce(page([], { searchKey: "opaque search key", nextPageToken: "opaque/token/2==" }))
      .mockResolvedValueOnce(page([], { searchKey: "must-be-ignored", nextPageToken: "opaque/token/3==" }))
      .mockResolvedValueOnce(page([]));
    await runMarketplaceProbe({ mode: "PAGINATED", target: 20, maxPages: 3, delayMs: 0 }, { request });
    expect(request.mock.calls[0][0]).toMatchObject({ searchKey: undefined, pageToken: undefined });
    expect(request.mock.calls[1][0]).toMatchObject({ searchKey: "opaque search key", pageToken: "opaque/token/2==" });
    expect(request.mock.calls[2][0]).toMatchObject({ searchKey: "opaque search key", pageToken: "opaque/token/3==" });
  });

  it("never includes Creator Open ID in sanitized creator output or logs", async () => {
    const providerIdentity = "creator-open-secret-123456789";
    const lines: string[] = [];
    const request = vi.fn<ProbeRequest>().mockResolvedValue(page([creator(providerIdentity, 1200)]));
    const result = await runMarketplaceProbe({ mode: "SINGLE", target: 20, maxPages: 12, delayMs: 3000 }, {
      request,
      log: (line) => lines.push(line)
    });
    const serialized = JSON.stringify({ lines, creator: sanitizeCreator(result.matchedCreators[0]) });
    expect(serialized).not.toContain(providerIdentity);
    expect(serialized).not.toContain("creatorOpenId");
  });
});
