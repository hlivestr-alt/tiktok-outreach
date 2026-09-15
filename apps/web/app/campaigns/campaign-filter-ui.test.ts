import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "apps/web/app/campaigns/new/page.tsx"), "utf8");

describe("New Campaign finite filter controls", () => {
  it("renders follower and GMV selects from shared definitions", () => {
    expect(page).toContain('data-testid="follower-range"');
    expect(page).toContain('data-testid="gmv-range"');
    expect(page).toContain("CAMPAIGN_FOLLOWER_RANGES.map");
    expect(page).toContain("CAMPAIGN_GMV_OPTIONS.map");
    expect(page).not.toContain("Any follower count");
  });
  it("maps selections to existing min/max fields and cannot submit typed ranges", () => {
    expect(page).toContain("...followerFilters(form.followerBucket)");
    expect(page).toContain("...gmvFilters(form.gmvBucket)");
    expect(page).not.toContain('set("minFollowers"');
    expect(page).not.toContain('set("maxFollowers"');
    expect(page).not.toContain('set("minGmv"');
    expect(page).not.toContain('set("maxGmv"');
  });

  it("offers only named GMV levels and no currency control", () => {
    expect(page).not.toContain("Any GMV");
    expect(page).not.toContain("GMV currency");
    expect(page).not.toContain("form.gmvCurrency");
    expect(page).not.toContain("selected currency");
  });

  it("keeps contact cooldown directly editable as whole days", () => {
    expect(page).toContain('data-testid="contact-cooldown"');
    expect(page).toContain('cooldownDays: "30"');
    expect(page).toContain('step="1"');
    expect(page).toContain("MAX_CONTACT_COOLDOWN_DAYS");
    expect(page).not.toContain("cooldownDays.map");
  });
});
