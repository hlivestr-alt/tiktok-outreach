import { describe, expect, it } from "vitest";
import { categoryEvidence, followerEvidence, schedulerSlot, scoreSchedulerPriority, selectSchedulerCandidate, softProductivityWeight,
  type ProductivityEvidence, type SchedulerPriorityInput } from "./creator-scheduler";

const globalEvidence: ProductivityEvidence = { rows: 100_000, newCreators: 25_000, yield: 0.25 };
const neutral: ProductivityEvidence = { rows: 0, newCreators: 0, yield: null };

function adaptive(overrides: Partial<SchedulerPriorityInput> = {}) {
  return scoreSchedulerPriority({ partitionType: "ADAPTIVE_FOLLOWER", adaptiveDepth: 2,
    branchClassification: "PRODUCTIVE", expectedYield: 0.30, expectedNewPerSuccessfulPage: 8,
    observedSaturated: true, categoryEvidence: neutral, followerEvidence: neutral, globalEvidence, ...overrides });
}

function candidate(id: string, schedulerClass: "HIGH" | "MEDIUM" | "EXPLORATION" | "LOW", score: number, queuePosition: bigint, gmvBucket?: string) {
  return { id, queuePosition, gmvBucket, candidate: id, priority: { schedulerClass, score, reason: id, categoryWeight: 0, followerWeight: 0 } };
}

describe("deterministic Creator Database scheduler", () => {
  it("ranks productive Depth 2 and 3 work above an ordinary V2 seed", () => {
    const seed = scoreSchedulerPriority({ partitionType: "V2_SEED", adaptiveDepth: 0, branchClassification: "UNCLASSIFIED",
      expectedYield: null, expectedNewPerSuccessfulPage: null, observedSaturated: false,
      categoryEvidence: neutral, followerEvidence: neutral, globalEvidence });
    expect(adaptive({ adaptiveDepth: 2 }).schedulerClass).toBe("HIGH");
    expect(adaptive({ adaptiveDepth: 3 }).score).toBeGreaterThan(seed.score);
  });

  it("forces V2 exploration on one of every seven configured claims", () => {
    const candidates = [candidate("high", "HIGH", 2_000, 1n), candidate("medium", "MEDIUM", 1_000, 2n),
      candidate("seed", "EXPLORATION", 100, 3n)];
    const selected = Array.from({ length: 700 }, (_, index) =>
      selectSchedulerCandidate(candidates, schedulerSlot(index + 1, 7))!.priority.schedulerClass);
    expect(selected.filter((value) => value === "EXPLORATION")).toHaveLength(100);
    expect(selected.filter((value) => value === "MEDIUM")).toHaveLength(100);
    expect(selected.filter((value) => value === "HIGH")).toHaveLength(500);
  });

  it("gives high, medium, and exploration pools opportunities without randomness", () => {
    expect(Array.from({ length: 7 }, (_, index) => schedulerSlot(index + 1, 7)))
      .toEqual(["HIGH", "HIGH", "HIGH", "MEDIUM", "HIGH", "HIGH", "EXPLORATION"]);
  });

  it("applies a substantial soft weak-category penalty without excluding the candidate", () => {
    const weak = { rows: 8_824, newCreators: 220, yield: 220 / 8_824 };
    const priority = adaptive({ adaptiveDepth: 1, branchClassification: "UNCLASSIFIED", expectedYield: null,
      expectedNewPerSuccessfulPage: null, categoryEvidence: weak });
    expect(priority.categoryWeight).toBeLessThan(-300);
    expect(priority.reason).toContain("weak category penalty");
    const selected = selectSchedulerCandidate([candidate("weak", priority.schedulerClass, priority.score, 1n)], "HIGH");
    expect(selected?.candidate).toBe("weak");
  });

  it("does not apply category weighting below the persisted evidence threshold", () => {
    expect(softProductivityWeight({ rows: 999, newCreators: 0, yield: 0 }, globalEvidence, "CATEGORY")).toBe(0);
  });

  it("lets authoritative LOW_VALUE branch evidence override a strong category", () => {
    const strong = { rows: 10_000, newCreators: 5_000, yield: 0.50 };
    const priority = adaptive({ branchClassification: "LOW_VALUE", categoryEvidence: strong });
    expect(priority.schedulerClass).toBe("LOW");
    expect(priority.reason).toContain("LOW VALUE branch override");
  });

  it("keeps productive work high regardless of raw throttle history", () => {
    const base = { partitionType: "ADAPTIVE_FOLLOWER", adaptiveDepth: 3, branchClassification: "STRONG",
      expectedYield: 0.45, expectedNewPerSuccessfulPage: 10, observedSaturated: true,
      categoryEvidence: neutral, followerEvidence: neutral, globalEvidence } as const;
    const clean = scoreSchedulerPriority(base);
    const throttled = scoreSchedulerPriority({ ...base, marketplaceRequests: 10_000, throttleAttempts: 9_999 } as SchedulerPriorityInput);
    expect(throttled).toEqual(clean);
    expect(throttled.schedulerClass).toBe("HIGH");
  });

  it("uses follower-band history as a soft signal", () => {
    const productiveBand = { rows: 10_000, newCreators: 4_500, yield: 0.45 };
    const weakBand = { rows: 10_000, newCreators: 300, yield: 0.03 };
    expect(adaptive({ followerEvidence: productiveBand }).followerWeight).toBeGreaterThan(0);
    expect(adaptive({ followerEvidence: weakBand }).followerWeight).toBeLessThan(0);
  });

  it("does not penalize Depth 4+ solely for depth", () => {
    expect(adaptive({ adaptiveDepth: 5, branchClassification: "STRONG", expectedYield: 0.40 }).schedulerClass).toBe("HIGH");
    expect(adaptive({ adaptiveDepth: 5, branchClassification: "UNCLASSIFIED", expectedYield: null }).schedulerClass).toBe("MEDIUM");
  });

  it("uses score, queue position, and id as deterministic tie breakers", () => {
    const candidates = [candidate("b", "HIGH", 10, 1n), candidate("a", "HIGH", 10, 1n), candidate("c", "HIGH", 11, 9n)];
    expect(selectSchedulerCandidate(candidates, "HIGH")?.candidate).toBe("c");
    expect(selectSchedulerCandidate(candidates.slice(0, 2), "HIGH")?.candidate).toBe("a");
  });

  it("keeps category and follower evidence inside the GMV branch", () => {
    const now = new Date("2026-08-26T00:00:00Z");
    const observations = [
      { categoryChildId: "child", followersMin: 1_000, followersMax: 1_499, gmvBucket: "G1", rowsReturned: 10_000, uniqueCreatorsAdded: 5_000, lastSuccessAt: now },
      { categoryChildId: "child", followersMin: 1_000, followersMax: 1_499, gmvBucket: "G2", rowsReturned: 10_000, uniqueCreatorsAdded: 100, lastSuccessAt: now }
    ];
    expect(categoryEvidence(observations, "child", now, "G1").yield).toBe(0.5);
    expect(categoryEvidence(observations, "child", now, "G2").yield).toBe(0.01);
    expect(followerEvidence(observations, 1_000, 1_499, now, "G1").yield).toBe(0.5);
    expect(followerEvidence(observations, 1_000, 1_499, now, "G2").yield).toBe(0.01);
  });

  it("gives each untested GMV bucket a deterministic exploration opportunity", () => {
    const candidates = [
      candidate("low", "EXPLORATION", 100, 1n, "G1"), candidate("medium", "EXPLORATION", 100, 2n, "G2"),
      candidate("high", "EXPLORATION", 100, 3n, "G3"), candidate("very-high", "EXPLORATION", 100, 4n, "G4")
    ];
    expect(selectSchedulerCandidate(candidates, "EXPLORATION", "G4")?.candidate).toBe("very-high");
    expect(selectSchedulerCandidate(candidates, "EXPLORATION", "G2")?.candidate).toBe("medium");
  });
});
