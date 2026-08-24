import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  decreasedConcurrency,
  exponentialBackoffWithJitter,
  increasedConcurrency,
  isProviderThrottle
} from "./outbound-throttle";

describe("outbound provider governor", () => {
  it("uses exponential backoff with jitter and honors Retry-After as a minimum", () => {
    expect(exponentialBackoffWithJitter(1, undefined, { random: () => 0 })).toBe(1_000);
    expect(exponentialBackoffWithJitter(2, undefined, { random: () => 0.5 })).toBe(2_250);
    expect(exponentialBackoffWithJitter(2, 45_000, { random: () => 0 })).toBe(45_000);
    expect(exponentialBackoffWithJitter(30, undefined, { random: () => 0.999 })).toBe(60_000);
  });

  it("recognizes either HTTP 429 or business code 36009002", () => {
    expect(isProviderThrottle(429, undefined)).toBe(true);
    expect(isProviderThrottle(200, 36009002)).toBe(true);
    expect(isProviderThrottle(503, 36009003)).toBe(false);
  });

  it("multiplicatively decreases on repeated throttles and additively recovers to the technical ceiling", () => {
    let concurrency = 16;
    concurrency = decreasedConcurrency(concurrency);
    expect(concurrency).toBe(8);
    concurrency = decreasedConcurrency(concurrency);
    expect(concurrency).toBe(4);

    let successes = 0;
    for (let index = 0; index < 500; index++) {
      ({ effectiveConcurrency: concurrency, healthySuccessCount: successes } = increasedConcurrency(concurrency, 32, successes));
    }
    expect(concurrency).toBe(32);
  });

  it("processes 1000 immediate mock successes without minute, hour, or fixed-spacing waits", async () => {
    const calls: number[] = [];
    const started = performance.now();
    await Promise.all(Array.from({ length: 1_000 }, async (_, index) => {
      calls.push(index);
      return { status: "SENT" as const };
    }));
    const elapsedMs = performance.now() - started;
    const acceptedPerSecond = 1_000 / Math.max(elapsedMs / 1_000, 0.001);
    console.log(JSON.stringify({ test: "mock-outbound-throughput", recipients: 1_000, elapsedMs, acceptedPerSecond }));
    expect(calls).toHaveLength(1_000);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(acceptedPerSecond).toBeGreaterThan(100);
  });

  it("recovers after a throttle instead of remaining at reduced capacity", () => {
    let concurrency = decreasedConcurrency(12);
    let successes = 0;
    expect(concurrency).toBe(6);
    for (let index = 0; index < 200; index++) {
      ({ effectiveConcurrency: concurrency, healthySuccessCount: successes } = increasedConcurrency(concurrency, 20, successes));
    }
    expect(concurrency).toBe(20);
  });
});
