import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("campaign same-origin proxy", () => {
  it("keeps all browser requests on /api/v1 and allows long eligibility requests", () => {
    const api = readFileSync(join(process.cwd(), "apps/web/lib/api.ts"), "utf8");
    const config = readFileSync(join(process.cwd(), "apps/web/next.config.ts"), "utf8");
    expect(api).toContain('process.env.NEXT_PUBLIC_API_URL ?? "/api/v1"');
    expect(config).toContain("proxyTimeout: 180_000");
    expect(config).toContain('"http://localhost:4000"');
    expect(api).not.toContain("localhost:4000");
    expect(api).not.toContain("127.0.0.1:4000");
  });
});
