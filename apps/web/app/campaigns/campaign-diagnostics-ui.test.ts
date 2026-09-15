import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "apps/web/app/campaigns/[id]/page.tsx"), "utf8");

describe("campaign diagnostics progressive disclosure", () => {
  it("keeps normal and data-quality diagnostics out of giant banners", () => {
    expect(page).not.toContain("HISTORY IDENTITY COVERAGE INCOMPLETE");
    expect(page).not.toContain("APP-ORIGINATED DEDUPE SAFE");
    expect(page).not.toContain("Mixed Marketplace GMV currencies observed");
    expect(page).not.toContain("Unexpected GMV currency excluded");
    expect(page).not.toContain("<strong>Discovery complete</strong>");
  });

  it("keeps the underlying information accessible under Data notes", () => {
    expect(page).toContain('<details className="data-notes">');
    expect(page).toContain("Historical identity coverage");
    expect(page).toContain("Dedupe protection");
    expect(page).toContain("GMV currencies");
    expect(page).toContain("Internal exclusions");
    expect(page).toContain('label: "Discovery"');
  });

  it("still renders genuine blockers prominently", () => {
    expect(page).toContain('<div className="alert error"><AlertTriangle/><div><strong>Outbound unavailable</strong>');
    expect(page).toContain('<div className="alert error"><AlertTriangle/><div><strong>No eligible creators are available</strong>');
    expect(page).toContain("Discovery failed — operator action required");
    expect(page).toContain("Campaign stopped by a provider safety condition");
  });
});
