import { describe, expect, it } from "vitest";
import { DEFAULT_MARKETPLACE_RETRY_DELAY_SECONDS, parseMarketplaceRetryDelaySeconds } from "./retry-settings";

describe("Marketplace retry delay setting", () => {
  it("defaults to three seconds and accepts integer seconds at or above one", () => {
    expect(DEFAULT_MARKETPLACE_RETRY_DELAY_SECONDS).toBe(3);
    expect(parseMarketplaceRetryDelaySeconds(1)).toBe(1);
    expect(parseMarketplaceRetryDelaySeconds(3)).toBe(3);
    expect(parseMarketplaceRetryDelaySeconds("12")).toBe(12);
  });

  it("rejects zero, decimals, and non-numeric values", () => {
    expect(parseMarketplaceRetryDelaySeconds(0)).toBeUndefined();
    expect(parseMarketplaceRetryDelaySeconds(3.5)).toBeUndefined();
    expect(parseMarketplaceRetryDelaySeconds("3.5")).toBeUndefined();
    expect(parseMarketplaceRetryDelaySeconds("seconds")).toBeUndefined();
  });
});
