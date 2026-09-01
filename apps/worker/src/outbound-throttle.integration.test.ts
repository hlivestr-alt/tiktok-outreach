import { createHash } from "node:crypto";
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
  it("admits at most one Send Message per 1000ms across concurrent callers", async () => {
    const selected = await shop();
    const governor = new OutboundProviderGovernor(prisma, {
      provider: "MOCK_TIKTOK", appScope, initialConcurrency: 16, technicalMaxConcurrency: 16,
      permitLeaseMs: 120_000, sendMessageIntervalMs: 1_000, random: () => 0
    });
    const base = new Date("2026-08-29T00:00:00.000Z");
    const simultaneous = await Promise.all(Array.from({ length: 16 }, (_, index) =>
      governor.acquire(selected.id, "SEND_MESSAGE", `campaign-a-${index}`, base)
    ));
    const admitted = simultaneous.filter((result) => result.acquired);
    expect(admitted).toHaveLength(1);
    if (!admitted[0]?.acquired) throw new Error("Expected one permit");
    await governor.healthy(admitted[0].permit, "ACCEPTED", { httpStatus: 200, businessCode: "0" }, base);

    const admissionTimes = [base.getTime()];
    for (let index = 1; index < 10; index++) {
      const tooSoon = await governor.acquire(selected.id, "SEND_MESSAGE", `retry-${index}`, new Date(base.getTime() + index * 1_000 - 1));
      expect(tooSoon.acquired).toBe(false);
      const now = new Date(base.getTime() + index * 1_000);
      const next = await governor.acquire(selected.id, "SEND_MESSAGE", `campaign-b-${index}`, now);
      if (!next.acquired) throw new Error(`Expected admission ${index}: ${next.state}`);
      admissionTimes.push(now.getTime());
      await governor.healthy(next.permit, "ACCEPTED", { httpStatus: 200, businessCode: "0" }, now);
    }
    expect(admissionTimes.at(-1)! - admissionTimes[0]).toBe(9_000);
    const limiter = await prisma.providerOutboundLimiter.findUniqueOrThrow({
      where: { provider_appScope_shopId_operation: { provider: "MOCK_TIKTOK", appScope, shopId: selected.id, operation: "SEND_MESSAGE" } }
    });
    expect(limiter).toMatchObject({ effectiveConcurrency: 1, technicalMaxConcurrency: 1 });
  }, 15_000);

  it("persists pacing across governor restarts and never catches up after Retry-After", async () => {
    const selected = await shop();
    const options = { provider: "MOCK_TIKTOK", appScope, initialConcurrency: 8, technicalMaxConcurrency: 16, permitLeaseMs: 120_000, sendMessageIntervalMs: 1_000, random: () => 0 };
    const governor = new OutboundProviderGovernor(prisma, options);
    const base = new Date("2026-08-24T08:00:00.000Z");
    const first = await governor.acquire(selected.id, "SEND_MESSAGE", "initial", base);
    if (!first.acquired) throw new Error("Expected initial permit");
    await governor.throttle(first.permit, { httpStatus: 429, businessCode: "36009002", retryAfterMs: 10_000 }, base);

    const restartedGovernor = new OutboundProviderGovernor(prisma, options);
    const blocked = await restartedGovernor.acquire(selected.id, "SEND_MESSAGE", "after-restart", new Date(base.getTime() + 9_999));
    expect(blocked).toMatchObject({ acquired: false, state: "THROTTLED" });

    const recoveryAt = new Date(base.getTime() + 10_000);
    const recovered = await restartedGovernor.acquire(selected.id, "SEND_MESSAGE", "recovered", recoveryAt);
    if (!recovered.acquired) throw new Error(`Expected recovery permit: ${recovered.state}`);
    await restartedGovernor.healthy(recovered.permit, "ACCEPTED", { httpStatus: 200, businessCode: "0" }, recoveryAt);
    const catchUp = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      restartedGovernor.acquire(selected.id, "SEND_MESSAGE", `catch-up-${index}`, recoveryAt)
    ));
    expect(catchUp.filter((result) => result.acquired)).toHaveLength(0);
    const next = await restartedGovernor.acquire(selected.id, "SEND_MESSAGE", "next-paced", new Date(recoveryAt.getTime() + 1_000));
    expect(next.acquired).toBe(true);
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
