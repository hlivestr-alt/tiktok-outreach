import { describe, expect, it } from "vitest";
import { liveOutboundExplicitlyEnabled, loadConfig } from "./index";

const base = { DATABASE_URL: "postgresql://localhost/test" };
describe("outbound activation", () => {
  it("defaults mock and real environments to their safe provider modes", () => {
    expect(loadConfig({ ...base, APP_MODE: "mock" }).OUTBOUND_MODE).toBe("mock");
    expect(loadConfig({ ...base, APP_MODE: "read_only" }).OUTBOUND_MODE).toBe("read_only");
  });
  it("requires both live mode and the exact acknowledgement", () => {
    expect(liveOutboundExplicitlyEnabled(loadConfig({ ...base, APP_MODE: "read_only", OUTBOUND_MODE: "live" }))).toBe(false);
    expect(liveOutboundExplicitlyEnabled(loadConfig({ ...base, APP_MODE: "read_only", OUTBOUND_MODE: "live", ENABLE_LIVE_TIKTOK_OUTBOUND: "I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES" }))).toBe(true);
    expect(liveOutboundExplicitlyEnabled(loadConfig({ ...base, APP_MODE: "mock", OUTBOUND_MODE: "live", ENABLE_LIVE_TIKTOK_OUTBOUND: "I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES" }))).toBe(false);
  });
});
