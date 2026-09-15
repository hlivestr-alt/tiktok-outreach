import { describe, expect, it } from "vitest";
import { SHEETS_BLOCKED_RETRY_MS, sheetsRetryDelayMs } from "./creator-sync.processor";

describe("Creator Database Google Sheets retry backoff", () => {
  it.each([
    [1, 5_000],
    [2, 10_000],
    [3, 20_000],
    [4, 40_000],
    [5, 60_000],
    [6, 120_000],
    [7, 300_000],
    [10, 300_000],
    [50, 300_000],
    [100, 300_000],
    [5_000, 300_000]
  ])("uses bounded backoff for attempt %i", (attempt, expected) => {
    expect(sheetsRetryDelayMs(attempt, true, () => 0)).toBe(expected);
  });

  it("adds at most ten percent jitter without exceeding five minutes", () => {
    expect(sheetsRetryDelayMs(1, true, () => 1)).toBe(5_500);
    expect(sheetsRetryDelayMs(6, true, () => 1)).toBe(132_000);
    expect(sheetsRetryDelayMs(7, true, () => 1)).toBe(SHEETS_BLOCKED_RETRY_MS);
  });

  it("retries authentication and permission blocks every five minutes", () => {
    expect(sheetsRetryDelayMs(1, false, () => 0)).toBe(SHEETS_BLOCKED_RETRY_MS);
    expect(sheetsRetryDelayMs(100, false, () => 1)).toBe(SHEETS_BLOCKED_RETRY_MS);
  });
});
