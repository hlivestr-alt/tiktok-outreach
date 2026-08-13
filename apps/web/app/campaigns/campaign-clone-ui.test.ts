import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "apps/web/app/campaigns/[id]/page.tsx"), "utf8");

describe("PREVIEW_READY clone UI", () => {
  it("renders the minimal clone control and local-only explanation", () => {
    expect(page).toContain("Clone campaign");
    expect(page).toContain("LOCAL_CLONE_EXPLANATION");
    expect(page).toContain('campaign.state === "PREVIEW_READY"');
  });

  it("navigates to the returned campaign only after PREVIEW_READY", () => {
    expect(page).toContain('result.state !== "PREVIEW_READY"');
    expect(page).toContain("router.push(`/campaigns/${result.id}`)");
  });
});
