import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("historical sync UI safety", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/app/contact-history/page.tsx"), "utf8");
  it("uses local job controls and never renders private provider cursors", () => {
    expect(source).toContain("/contact-history/sync-job/");
    expect(source).not.toContain("pageToken");
    expect(source).not.toContain("privateBackfillPageToken");
    expect(source).not.toContain("privateMessagePageToken");
  });
  it("shows honest counts and explicitly avoids a fake completion percentage", () => {
    expect(source).toContain("Conversations imported");
    expect(source).toContain("Messages imported");
    expect(source).toContain("no completion percentage is invented");
  });
});
