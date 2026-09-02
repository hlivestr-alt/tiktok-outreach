import { describe, expect, it } from "vitest";
import { categoryEvidence, designatedFirstG1G2Bucket, followerEvidence, G4_PROBE_CADENCE, g1G2FamilyKey,
  schedulerSlot, scoreSchedulerPriority, selectSchedulerCandidate, softProductivityWeight,
  type ProductivityEvidence, type SchedulerClass, type SchedulerPriorityInput } from "./creator-scheduler";

const globalEvidence: ProductivityEvidence = { rows: 100_000, newCreators: 25_000, yield: 0.25 };
const neutral: ProductivityEvidence = { rows: 0, newCreators: 0, yield: null };

function adaptive(overrides: Partial<SchedulerPriorityInput> = {}) {
  return scoreSchedulerPriority({ partitionType: "ADAPTIVE_FOLLOWER", adaptiveDepth: 2,
    branchClassification: "PRODUCTIVE", expectedYield: 0.30, expectedNewPerSuccessfulPage: 8,
    evidenceRows: 400, observedSaturated: true, gmvBucket: "G1",
    categoryEvidence: neutral, followerEvidence: neutral, globalEvidence, ...overrides });
}

function candidate(id: string, schedulerClass: SchedulerClass, score: number, queuePosition: bigint, gmvBucket = "G1") {
  return { id, queuePosition, gmvBucket, candidate: id, priority: { schedulerClass, score, reason: id, categoryWeight: 0, followerWeight: 0 } };
}

describe("deterministic Creator Database scheduler", () => {
  it("uses a persisted 60/30/9/1 claim cadence with one G4 probe per 100 claims", () => {
    const slots = Array.from({ length: 1_000 }, (_, index) => schedulerSlot(index + 1));
    expect(slots.filter((value) => value === "PRIMARY_PRODUCTIVE")).toHaveLength(600);
    expect(slots.filter((value) => value === "PRIMARY_EXPLORATION")).toHaveLength(300);
    expect(slots.filter((value) => value === "G3_EXPLORATION")).toHaveLength(90);
    expect(slots.filter((value) => value === "G4_PROBE")).toHaveLength(10);
    expect(G4_PROBE_CADENCE).toBe(100);
    expect(schedulerSlot(100)).toBe("G4_PROBE");
    expect(schedulerSlot(101)).toBe("PRIMARY_PRODUCTIVE");
  });

  it("keeps G4 out of normal HIGH and MEDIUM pools and selects it only in the probe slot", () => {
    const priority = adaptive({ gmvBucket: "G4", expectedYield: 0.9, expectedNewPerSuccessfulPage: 18 });
    expect(priority.schedulerClass).toBe("EXPERIMENT_ONLY");
    const candidates = [candidate("primary", "HIGH", 2_000, 1n, "G1"),
      candidate("very-high", "EXPERIMENT_ONLY", -10_000, 2n, "G4")];
    expect(selectSchedulerCandidate(candidates, "PRIMARY_PRODUCTIVE")?.candidate).toBe("primary");
    expect(selectSchedulerCandidate(candidates, "PRIMARY_EXPLORATION")?.candidate).toBe("primary");
    expect(selectSchedulerCandidate(candidates, "G4_PROBE")?.candidate).toBe("very-high");
  });

  it("prioritizes productive G1/G2, then unknown G1/G2, then productive and general G3", () => {
    const candidates = [candidate("primary-productive", "HIGH", 2_000, 1n, "G1"),
      candidate("primary-unknown", "EXPLORATION", 100, 2n, "G2"),
      candidate("g3-productive", "MEDIUM", 1_500, 3n, "G3"), candidate("g3-general", "LOW", -500, 4n, "G3")];
    expect(selectSchedulerCandidate(candidates, "PRIMARY_PRODUCTIVE")?.candidate).toBe("primary-productive");
    expect(selectSchedulerCandidate(candidates, "PRIMARY_EXPLORATION")?.candidate).toBe("primary-unknown");
    expect(selectSchedulerCandidate(candidates, "G3_EXPLORATION")?.candidate).toBe("g3-productive");
    expect(selectSchedulerCandidate(candidates.filter((value) => value.candidate !== "g3-productive"), "G3_EXPLORATION")?.candidate).toBe("g3-general");
  });

  it("promotes G3 only with a meaningful, locally strong sample", () => {
    expect(adaptive({ gmvBucket: "G3", evidenceRows: 199, expectedYield: 0.50, expectedNewPerSuccessfulPage: 10 }).schedulerClass).toBe("LOW");
    expect(adaptive({ gmvBucket: "G3", evidenceRows: 200, expectedYield: 0.199, expectedNewPerSuccessfulPage: 10 }).schedulerClass).toBe("LOW");
    expect(adaptive({ gmvBucket: "G3", evidenceRows: 200, expectedYield: 0.20, expectedNewPerSuccessfulPage: 4 }).schedulerClass).toBe("MEDIUM");
  });

  it("does not classify a tiny G1/G2 sample as productive", () => {
    expect(adaptive({ evidenceRows: 199, expectedYield: 0.80, expectedNewPerSuccessfulPage: 16 }).schedulerClass).toBe("MEDIUM");
    expect(adaptive({ evidenceRows: 200, expectedYield: 0.10, expectedNewPerSuccessfulPage: 4 }).schedulerClass).toBe("HIGH");
  });

  it("balances untouched G1/G2 families stably across a deterministic sample", () => {
    const designations = Array.from({ length: 10_000 }, (_, index) => {
      const key = g1G2FamilyKey({ categoryId: `parent-${Math.floor(index / 25)}`, categoryChildId: `child-${index}`,
        followersMin: 600 + index, followersMax: 799 + index })!;
      expect(designatedFirstG1G2Bucket(key)).toBe(designatedFirstG1G2Bucket(key));
      return designatedFirstG1G2Bucket(key);
    });
    const g1 = designations.filter((value) => value === "G1").length;
    expect(g1 / designations.length).toBeGreaterThanOrEqual(0.48);
    expect(g1 / designations.length).toBeLessThanOrEqual(0.52);
  });

  it("applies soft evidence only after its larger aggregate guard", () => {
    expect(softProductivityWeight({ rows: 999, newCreators: 0, yield: 0 }, globalEvidence, "CATEGORY")).toBe(0);
    expect(adaptive({ categoryEvidence: { rows: 8_824, newCreators: 220, yield: 220 / 8_824 } }).categoryWeight).toBeLessThan(-300);
  });

  it("lets authoritative low-value evidence override a strong category", () => {
    const priority = adaptive({ branchClassification: "LOW_VALUE",
      categoryEvidence: { rows: 10_000, newCreators: 5_000, yield: 0.50 } });
    expect(priority.schedulerClass).toBe("LOW");
    expect(priority.reason).toContain("LOW VALUE branch override");
  });

  it("keeps raw throttle history out of productivity classification", () => {
    const base = { partitionType: "ADAPTIVE_FOLLOWER", adaptiveDepth: 3, branchClassification: "STRONG",
      expectedYield: 0.45, expectedNewPerSuccessfulPage: 10, evidenceRows: 400, observedSaturated: true, gmvBucket: "G1",
      categoryEvidence: neutral, followerEvidence: neutral, globalEvidence } as const;
    expect(scoreSchedulerPriority({ ...base, marketplaceRequests: 10_000, throttleAttempts: 9_999 } as SchedulerPriorityInput))
      .toEqual(scoreSchedulerPriority(base));
  });

  it("uses score, queue position, and id as deterministic tie breakers", () => {
    const candidates = [candidate("b", "HIGH", 10, 1n), candidate("a", "HIGH", 10, 1n), candidate("c", "HIGH", 11, 9n)];
    expect(selectSchedulerCandidate(candidates, "PRIMARY_PRODUCTIVE")?.candidate).toBe("c");
    expect(selectSchedulerCandidate(candidates.slice(0, 2), "PRIMARY_PRODUCTIVE")?.candidate).toBe("a");
  });

  it("keeps category and follower evidence inside the exact GMV branch", () => {
    const now = new Date("2026-08-26T00:00:00Z");
    const observations = [
      { categoryChildId: "child", followersMin: 1_000, followersMax: 1_499, gmvBucket: "G1", rowsReturned: 10_000, uniqueCreatorsAdded: 5_000, lastSuccessAt: now },
      { categoryChildId: "child", followersMin: 1_000, followersMax: 1_499, gmvBucket: "G2", rowsReturned: 10_000, uniqueCreatorsAdded: 100, lastSuccessAt: now }
    ];
    expect(categoryEvidence(observations, "child", now, "G1").yield).toBe(0.5);
    expect(categoryEvidence(observations, "child", now, "G2").yield).toBe(0.01);
    expect(followerEvidence(observations, 1_000, 1_499, now, "G1").yield).toBe(0.5);
  });
});
