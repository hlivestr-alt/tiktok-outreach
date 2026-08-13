import { beforeAll, describe, expect, it, vi } from "vitest";

describe("proactive token maintenance", () => {
  beforeAll(() => {
    process.env.DATABASE_URL ??= "postgresql://localhost/test";
  });

  it("refreshes a due healthy connection through the single coordinator", async () => {
    const { TokenMaintenanceService } = await import("./token-maintenance.service");
    const due = { shopId: "shop-1" };
    const prisma = { shop: { findFirst: vi.fn().mockResolvedValue({ id: "shop-1" }) }, integrationConnection: { findFirst: vi.fn().mockResolvedValue(due) } };
    const integration = { refreshToken: vi.fn().mockResolvedValue("not-exposed") };
    const service = new TokenMaintenanceService(prisma as any, integration as any);
    (service as any).running = false;
    await expect(service.sweep(new Date("2026-08-13T10:00:00Z"), true)).resolves.toBe("REFRESHED");
    expect(integration.refreshToken).toHaveBeenCalledWith("shop-1", "AUTO");
  });

  it("does not call TikTok when no token is due", async () => {
    const { TokenMaintenanceService } = await import("./token-maintenance.service");
    const prisma = { shop: { findFirst: vi.fn().mockResolvedValue({ id: "shop-1" }) }, integrationConnection: { findFirst: vi.fn().mockResolvedValue(null) } };
    const integration = { refreshToken: vi.fn() };
    const service = new TokenMaintenanceService(prisma as any, integration as any);
    await expect(service.sweep(new Date(), true)).resolves.toBe("NOT_DUE");
    expect(integration.refreshToken).not.toHaveBeenCalled();
  });
});
