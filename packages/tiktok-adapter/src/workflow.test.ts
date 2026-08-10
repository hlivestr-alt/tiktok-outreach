import { describe, expect, it } from "vitest";
import { buildPreview, type ContactState } from "@affiliate/domain";
import { generateMockCreators } from "./index";

describe("canonical outreach fixture", () => {
  it("produces the approved 1,540 / 40 / 230 / 1,270 / 1,000 summary", () => {
    const creators = generateMockCreators();
    const contacts = new Map<string, ContactState>();
    const now = new Date("2026-08-10T00:00:00Z");
    for (const creator of creators.slice(0, 230)) contacts.set(creator.creatorOpenId, {
      contactCount: 1, historical: true, lastContactedAt: new Date("2026-08-01T00:00:00Z")
    });
    const result = buildPreview({ creators, filters: {}, contacts, activeReservations: new Set(), requested: 1000, cooldownDays: 30, rankingMetric: "GMV", now });
    expect(result.summary).toMatchObject({ fetchedOccurrences: 1540, skippedDuplicates: 40, skippedCooldown: 230, eligible: 1270, selected: 1000 });
  });
});

