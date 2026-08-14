import { describe, expect, it } from "vitest";
import { CREATOR_RETRY_SECONDS, currentActivity, eventText } from "./creator-database-sync";

const status = {
  status: "RUNNING", pagesCompleted: 11, creatorsFetched: 220, creatorsFetchedThisRun: 0,
  totalCreatorsStored: 219, currentPage: 12, databaseStillPopulating: true, recentActivity: [],
  lastAttemptPage: 12, lastCreatorsReturned: 20
} as const;

describe("Creator Database activity labels", () => {
  it("uses the fixed 5-second Creator Database retry interval", () => {
    expect(CREATOR_RETRY_SECONDS).toBe(5);
  });

  it.each([
    ["REQUESTING_TIKTOK", "Fetching page 12 from TikTok"],
    ["TIKTOK_SUCCESS", "TikTok returned 20 creators"],
    ["SAVING_DATABASE", "Saving page 12 to PostgreSQL"],
    ["SAVING_SHEET", "Saving page 12 to Google Sheets"],
    ["COMMITTING_PAGE", "Committing page 12"],
    ["WAITING_RETRY", "retrying in 24s"],
    ["PAUSED", "Paused at page 12"],
    ["TIKTOK_ERROR", "TikTok request for page 12 failed"],
    ["DATABASE_ERROR", "PostgreSQL failed"],
    ["SHEET_ERROR", "Google Sheets failed"],
    ["CURSOR_ERROR", "cursor could not advance safely"]
  ])("renders %s as a clear human-readable stage", (currentStage, expected) => {
    expect(currentActivity({ ...status, currentStage } as any, 24)).toContain(expected);
  });

  it("summarizes committed page counts and throttle codes in recent activity", () => {
    expect(eventText({ stage: "PAGE_COMMITTED", pageNumber: 12, creatorsReturned: 20, creatorsAdded: 19, duplicates: 1, occurredAt: "2026-08-14T00:00:00Z" }))
      .toContain("20 returned, 19 new, 1 duplicate");
    expect(eventText({ stage: "TIKTOK_THROTTLED", pageNumber: 12, tiktokCode: "36009002", occurredAt: "2026-08-14T00:00:00Z" }))
      .toBe("Page 12 throttled — 36009002");
  });
});
