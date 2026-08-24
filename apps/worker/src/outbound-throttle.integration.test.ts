import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@affiliate/db";
import { OutboundProviderGovernor } from "./outbound-throttle";

const prisma = new PrismaClient();
const shopIds: string[] = [];
const appScope = createHash("sha256").update(`mock-throughput-${Date.now()}`).digest("hex").slice(0, 24);

async function shop() {
  const created = await prisma.shop.create({ data: { name: `provider-governor-${Date.now()}-${Math.random()}`, connectionMode: "MOCK" } });
  shopIds.push(created.id);
  return created;
}

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  await prisma.$disconnect();
});

describe.sequential("durable outbound provider governor", () => {
  it("processes 1000 immediate mock recipients without a local minute/hour/spacing ceiling", async () => {
    const selected = await shop();
    const governor = new OutboundProviderGovernor(prisma, {
      provider: "MOCK_TIKTOK", appScope, initialConcurrency: 4, technicalMaxConcurrency: 16, permitLeaseMs: 120_000, random: () => 0
    });
    let cursor = 0;
    const seen = new Set<number>();
    const started = performance.now();
    await Promise.all(Array.from({ length: 16 }, async (_, workerIndex) => {
      for (;;) {
        const recipient = cursor++;
        if (recipient >= 1_000) return;
        const permit = await governor.waitForPermit(selected.id, "SEND_MESSAGE", `mock-${workerIndex}-${recipient}`);
        expect(seen.has(recipient)).toBe(false);
        seen.add(recipient);
        await governor.healthy(permit, "ACCEPTED", { httpStatus: 200, businessCode: "0" });
      }
    }));
    const elapsedMs = performance.now() - started;
    const limiter = await prisma.providerOutboundLimiter.findUniqueOrThrow({
      where: { provider_appScope_shopId_operation: { provider: "MOCK_TIKTOK", appScope, shopId: selected.id, operation: "SEND_MESSAGE" } }
    });
    const [attempts, accepted, permits] = await Promise.all([
      prisma.providerOutboundEvent.count({ where: { limiterId: limiter.id, outcome: "ATTEMPT" } }),
      prisma.providerOutboundEvent.count({ where: { limiterId: limiter.id, outcome: "ACCEPTED" } }),
      prisma.providerOutboundPermit.count({ where: { limiterId: limiter.id } })
    ]);
    console.log(JSON.stringify({ test: "durable-mock-outbound-throughput", recipients: 1_000, elapsedMs, acceptedPerSecond: 1_000 / (elapsedMs / 1_000), finalConcurrency: limiter.effectiveConcurrency }));
    expect({ attempts, accepted, permits, recipients: seen.size }).toEqual({ attempts: 1_000, accepted: 1_000, permits: 0, recipients: 1_000 });
    expect(limiter.effectiveConcurrency).toBe(16);
    expect(elapsedMs).toBeLessThan(30_000);
  }, 45_000);

  it("coordinates repeated throttles, honors Retry-After, and ramps again after recovery", async () => {
    const selected = await shop();
    const governor = new OutboundProviderGovernor(prisma, {
      provider: "MOCK_TIKTOK", appScope, initialConcurrency: 8, technicalMaxConcurrency: 16, permitLeaseMs: 120_000, random: () => 0
    });
    const base = new Date("2026-08-24T08:00:00.000Z");
    const permits = [];
    for (let index = 0; index < 3; index++) {
      const result = await governor.acquire(selected.id, "SEND_MESSAGE", `throttle-${index}`, base);
      if (!result.acquired) throw new Error("Expected initial permit");
      permits.push(result.permit);
    }
    const first = await governor.throttle(permits[0], { httpStatus: 429, businessCode: "36009002", retryAfterMs: 5_000 }, base);
    const second = await governor.throttle(permits[1], { businessCode: "36009002", retryAfterMs: 5_000 }, base);
    const third = await governor.throttle(permits[2], { httpStatus: 429, retryAfterMs: 5_000 }, base);
    expect([first.effectiveConcurrency, second.effectiveConcurrency, third.effectiveConcurrency]).toEqual([4, 2, 1]);
    expect(first.delayMs).toBe(5_000);
    const blocked = await governor.acquire(selected.id, "SEND_MESSAGE", "blocked", new Date(base.getTime() + 4_999));
    expect(blocked).toMatchObject({ acquired: false, state: "THROTTLED" });

    let fakeNow = new Date(base.getTime() + 5_001);
    for (let index = 0; index < 80; index++) {
      const acquired = await governor.acquire(selected.id, "SEND_MESSAGE", `recovery-${index}`, fakeNow);
      if (!acquired.acquired) throw new Error(`Expected recovery permit: ${acquired.state}`);
      await governor.healthy(acquired.permit, "ACCEPTED", { httpStatus: 200, businessCode: "0" }, fakeNow);
      fakeNow = new Date(fakeNow.getTime() + 1);
    }
    const limiter = await prisma.providerOutboundLimiter.findUniqueOrThrow({
      where: { provider_appScope_shopId_operation: { provider: "MOCK_TIKTOK", appScope, shopId: selected.id, operation: "SEND_MESSAGE" } }
    });
    expect(limiter.effectiveConcurrency).toBeGreaterThan(1);
    expect(limiter.nextPermittedAt).toBeNull();
  }, 15_000);

  it("persists shop IM quota as a hard provider block without hot-loop attempts", async () => {
    const selected = await shop();
    const governor = new OutboundProviderGovernor(prisma, {
      provider: "MOCK_TIKTOK", appScope, initialConcurrency: 4, technicalMaxConcurrency: 16, permitLeaseMs: 120_000
    });
    const acquired = await governor.acquire(selected.id, "CREATE_CONVERSATION", "quota-first");
    if (!acquired.acquired) throw new Error("Expected initial permit");
    await governor.quotaBlocked(acquired.permit, "16030002", "shop has reached IM quota", { httpStatus: 400, businessCode: "16030002" });
    const blocked = await governor.acquire(selected.id, "CREATE_CONVERSATION", "quota-second");
    expect(blocked).toMatchObject({ acquired: false, state: "QUOTA_BLOCKED", quotaCode: "16030002" });
    const limiter = await prisma.providerOutboundLimiter.findUniqueOrThrow({
      where: { provider_appScope_shopId_operation: { provider: "MOCK_TIKTOK", appScope, shopId: selected.id, operation: "CREATE_CONVERSATION" } }
    });
    expect(limiter).toMatchObject({ state: "QUOTA_BLOCKED", quotaCode: "16030002" });
    expect(await prisma.providerOutboundEvent.count({ where: { limiterId: limiter.id, outcome: "ATTEMPT" } })).toBe(1);
  });
});
