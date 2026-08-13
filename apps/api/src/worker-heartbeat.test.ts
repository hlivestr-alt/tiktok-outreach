import { beforeAll, describe, expect, it } from "vitest";

describe("worker heartbeat state", () => {
  beforeAll(() => {
    process.env.DATABASE_URL ??= "postgresql://localhost/test";
  });

  it("distinguishes running, stale, and stopped workers", async () => {
    const { workerOperationalState } = await import("./worker-heartbeat");
    const now = new Date("2026-08-13T10:00:00.000Z");
    expect(workerOperationalState({ status: "RUNNING", lastSeenAt: new Date(now.getTime() - 1000) }, now)).toBe("RUNNING");
    expect(workerOperationalState({ status: "RUNNING", lastSeenAt: new Date(now.getTime() - 120000) }, now)).toBe("STALE");
    expect(workerOperationalState({ status: "STOPPED", lastSeenAt: now }, now)).toBe("STOPPED");
    expect(workerOperationalState(null, now)).toBe("STOPPED");
  });
});
