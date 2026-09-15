import { describe, expect, it } from "vitest";
import { allocateCampaignName, campaignDateKeyWib, CAMPAIGN_NAME_TIME_ZONE } from "./campaign-naming";

function fakeTransaction(initialNames: string[] = []) {
  const names = [...initialNames];
  return {
    names,
    tx: {
      $executeRaw: async () => 1,
      campaign: { findMany: async ({ where }: any) => names.filter((name) => name.startsWith(where.name.startsWith)).map((name) => ({ name })) }
    } as any
  };
}

describe("WIB campaign naming", () => {
  it("uses Asia/Jakarta at the UTC date boundary", () => {
    expect(CAMPAIGN_NAME_TIME_ZONE).toBe("Asia/Jakarta");
    expect(campaignDateKeyWib(new Date("2026-09-01T16:59:59.999Z"))).toBe("20260901");
    expect(campaignDateKeyWib(new Date("2026-09-01T17:00:00.000Z"))).toBe("20260902");
  });

  it("starts at 001, increments, resets on the next WIB day, and continues past 999", async () => {
    const firstDay = fakeTransaction();
    const first = await allocateCampaignName(firstDay.tx, new Date("2026-09-02T05:00:00Z"));
    firstDay.names.push(first);
    expect(first).toBe("20260902_001");
    expect(await allocateCampaignName(firstDay.tx, new Date("2026-09-02T16:59:59Z"))).toBe("20260902_002");
    expect(await allocateCampaignName(firstDay.tx, new Date("2026-09-02T17:00:00Z"))).toBe("20260903_001");

    const highVolume = fakeTransaction(["20260902_999"]);
    expect(await allocateCampaignName(highVolume.tx, new Date("2026-09-02T05:00:00Z"))).toBe("20260902_1000");
  });
});

