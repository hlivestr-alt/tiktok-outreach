import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_OUTREACH_MESSAGE_TEMPLATE } from "../../../../packages/domain/src/index";

const page = readFileSync(join(process.cwd(), "apps/web/app/campaigns/new/page.tsx"), "utf8");

describe("simplified New Campaign form", () => {
  it("starts with the one canonical editable default message", () => {
    expect(DEFAULT_OUTREACH_MESSAGE_TEMPLATE).toContain("Halo kak {{creator_display_name}}");
    expect(page).toContain('messageTemplate: DEFAULT_OUTREACH_MESSAGE_TEMPLATE');
    expect(page).toContain('data-testid="message-template"');
    expect(page).toContain('onChange={(event) => set("messageTemplate", event.target.value)}');
  });

  it("does not render or submit Campaign Name or Product inputs", () => {
    expect(page).not.toContain("<span>Campaign name</span>");
    expect(page).not.toContain("<span>Product</span>");
    expect(page).not.toContain("form.name");
    expect(page).not.toContain("form.productName");
  });

  it("defaults the target to 500 and retains the existing filter mapping", () => {
    expect(page).toContain('targetCount: "500"');
    expect(page).toContain("...followerFilters(form.followerBucket)");
    expect(page).toContain("...gmvFilters(form.gmvBucket)");
  });
});
