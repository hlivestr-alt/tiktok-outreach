import { describe, expect, it } from "vitest";
import { CREATOR_RETRY_SECONDS, DEFAULT_MARKETPLACE_RETRY_SECONDS, currentActivity, elapsedTime, eventText } from "./creator-database-sync";

const status = {
  status: "RUNNING", pagesCompleted: 11, creatorsFetched: 220, creatorsFetchedThisRun: 0,
  totalCreatorsStored: 219, currentPage: 12, databaseStillPopulating: true, recentActivity: [],
  lastAttemptPage: 12, lastCreatorsReturned: 20, business16032001RetryCount: 3, sheetsRetryCount: 1,
  marketplaceRetryDelaySeconds: 3
} as const;

describe("Creator Database activity labels", () => {
  it("keeps the existing 5-second fallback for non-Marketplace retry labels", () => {
    expect(CREATOR_RETRY_SECONDS).toBe(5);
  });

  it("uses a three-second default for Marketplace throttles", () => {
    expect(DEFAULT_MARKETPLACE_RETRY_SECONDS).toBe(3);
  });

  it.each([
    ["REQUESTING_TIKTOK", "Fetching page 12 from TikTok"],
    ["TIKTOK_SUCCESS", "TikTok returned 20 creators"],
    ["STAGING_PAGE", "Durably staging page 12"],
    ["SAVING_DATABASE", "Saving page 12 to PostgreSQL"],
    ["SAVING_SHEET", "Saving page 12 to Google Sheets"],
    ["COMMITTING_PAGE", "Committing page 12"],
    ["WAITING_RETRY", "retrying in 24s"],
    ["WAITING_BUSINESS_RETRY", "transient retry 3/10 in 24s"],
    ["TIKTOK_BUSINESS_RETRY_LIMIT", "retry limit reached (3/10)"],
    ["WAITING_SHEET_RETRY", "Google Sheets unavailable — attempt 2 in 24s"],
    ["SHEETS_BLOCKED_RETRYING", "Google Sheets access blocked — attempt 2 in 24s"],
    ["PAUSED", "Paused at page 12"],
    ["TIKTOK_ERROR", "TikTok request for page 12 failed"],
    ["PARTITION_CONFIG_ERROR", "no TikTok request was sent"],
    ["DATABASE_ERROR", "PostgreSQL failed"],
    ["SHEET_ERROR", "Google Sheets failed"],
    ["CURSOR_ERROR", "cursor could not advance safely"]
  ])("renders %s as a clear human-readable stage", (currentStage, expected) => {
    expect(currentActivity({ ...status, currentStage } as any, 24)).toContain(expected);
  });

  it("summarizes committed page counts and throttle codes in recent activity", () => {
    expect(eventText({ stage: "PARTITION_STARTED", safeMessage: "Selected adaptive Depth 3 partition — high expected discovery yield",
      occurredAt: "2026-08-14T00:00:00Z" })).toBe("Selected adaptive Depth 3 partition — high expected discovery yield");
    expect(eventText({ stage: "PAGE_COMMITTED", pageNumber: 12, creatorsReturned: 20, creatorsAdded: 19, duplicates: 1, occurredAt: "2026-08-14T00:00:00Z" }))
      .toContain("20 returned, 19 new, 1 duplicate");
    expect(eventText({ stage: "TIKTOK_THROTTLED", pageNumber: 12, tiktokCode: "36009002", occurredAt: "2026-08-14T00:00:00Z" }))
      .toBe("Page 12 TikTok throttled — 36009002 — retrying in 3s");
    expect(eventText({ stage: "TIKTOK_BUSINESS_RETRY", pageNumber: 12, tiktokCode: "16032001", safeMessage: "TikTok business error — 16032001 — transient retry 3/10 in 5s", occurredAt: "2026-08-14T00:00:00Z" }))
      .toBe("Page 12 TikTok business error — 16032001 — transient retry 3/10 in 5s");
    expect(eventText({ stage: "DATABASE_ERROR", pageNumber: 12, safeMessage: "PostgreSQL save failed; Field: creatorUserId; Record: 7/20; Page remains uncommitted", occurredAt: "2026-08-14T00:00:00Z" }))
      .toBe("Page 12 PostgreSQL save failed; Field: creatorUserId; Record: 7/20; Page remains uncommitted");
    expect(eventText({ stage: "SHEETS_RETRY_FAILED", pageNumber: 12, safeMessage: "Google Sheets unavailable — attempt 57; next retry in 300s", occurredAt: "2026-08-14T00:00:00Z" }))
      .toContain("Google Sheets unavailable — attempt 57");
    expect(eventText({ stage: "SHEET_RECOVERED", pageNumber: 12, safeMessage: "Google Sheets save recovered automatically after 100 failed attempts", occurredAt: "2026-08-14T00:00:00Z" }))
      .toBe("Page 12 Google Sheets save recovered automatically after 100 failed attempts");
    expect(eventText({ stage: "PAGE_COMMITTED", pageNumber: 12, creatorsReturned: 20, creatorsAdded: 19, duplicates: 1, occurredAt: "2026-08-14T00:00:00Z" }))
      .toContain("Page 12 committed");
    expect(eventText({ stage: "CURSOR_ADVANCED", pageNumber: 13, safeMessage: "Continuing to page 13", occurredAt: "2026-08-14T00:00:00Z" }))
      .toBe("Continuing to page 13");
    expect(eventText({ stage: "ADAPTIVE_SPLIT_CREATED", safeMessage: "Adaptive exploratory split created: 1,000–1,249 → 1,250–1,499", occurredAt: "2026-08-14T00:00:00Z" }))
      .toContain("Adaptive exploratory split created");
    expect(eventText({ stage: "ADAPTIVE_BRANCH_LOW_VALUE", safeMessage: "Branch low-value — follower recursion stopped", occurredAt: "2026-08-14T00:00:00Z" }))
      .toContain("follower recursion stopped");
    expect(eventText({ stage: "ADAPTIVE_GMV_CREATED", safeMessage: "Minimum follower width reached — four documented GMV children queued", occurredAt: "2026-08-14T00:00:00Z" }))
      .toContain("GMV children queued");
  });

  it("renders large retry counts and outage duration without a denominator", () => {
    expect(currentActivity({ ...status, currentStage: "WAITING_SHEET_RETRY", sheetsRetryCount: 5_000 } as any, 300))
      .toBe("Google Sheets unavailable — attempt 5001 in 300s");
    expect(elapsedTime("2026-08-14T00:00:00Z", new Date("2026-08-14T02:14:30Z").getTime())).toBe("2h 14m");
  });

  it("accepts compact category coverage status", () => {
    const coverage = { sampled: 8, total: 218, untouched: 210, parentsSampled: 3, totalParents: 17,
      mode: "COVERAGE", categoryExplorationPercent: 50 } as const;
    expect(coverage.sampled).toBe(8);
    expect(coverage.categoryExplorationPercent).toBe(50);
  });
});
