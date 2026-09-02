import type { BranchClassification, ProductionPartitionType } from "./marketplace-partitions";
import { createHash } from "node:crypto";

export const CATEGORY_MIN_EVIDENCE_ROWS = 1_000;
export const FOLLOWER_MIN_EVIDENCE_ROWS = 1_000;
export const PRODUCTIVITY_HALF_LIFE_DAYS = 14;

export const G4_PROBE_CADENCE = 100;
export const PRIMARY_SCHEDULER_CYCLE = 10;
export const BRANCH_EVIDENCE_MIN_ROWS = 200;

export type SchedulerClass = "HIGH" | "MEDIUM" | "EXPLORATION" | "LOW" | "EXPERIMENT_ONLY";
export type SchedulerSlot = "PRIMARY_PRODUCTIVE" | "PRIMARY_EXPLORATION" | "G3_EXPLORATION" | "G4_PROBE";
export type ProductivityEvidence = { rows: number; newCreators: number; yield: number | null };
export type SchedulerObservation = {
  categoryChildId: string | null;
  followersMin: number | null;
  followersMax: number | null;
  gmvBucket?: string | null;
  rowsReturned: number;
  uniqueCreatorsAdded: number;
  lastSuccessAt: Date | null;
};

export type SchedulerPriorityInput = {
  partitionType: ProductionPartitionType;
  adaptiveDepth: number;
  branchClassification: BranchClassification;
  expectedYield: number | null;
  expectedNewPerSuccessfulPage: number | null;
  observedSaturated: boolean;
  evidenceRows?: number;
  gmvBucket?: string | null;
  categoryEvidence: ProductivityEvidence;
  followerEvidence: ProductivityEvidence;
  globalEvidence: ProductivityEvidence;
};

export type SchedulerPriority = {
  schedulerClass: SchedulerClass;
  score: number;
  reason: string;
  categoryWeight: number;
  followerWeight: number;
};

export type ScoredSchedulerCandidate<T> = {
  candidate: T;
  priority: SchedulerPriority;
  queuePosition: bigint;
  id: string;
  gmvBucket?: string | null;
};

export function g1G2FamilyKey(input: { categoryId: string | null; categoryChildId: string | null;
  followersMin: number | null; followersMax: number | null }) {
  if (!input.categoryId || !input.categoryChildId || input.followersMin == null) return null;
  return `${input.categoryId.toLowerCase()}:${input.categoryChildId.toLowerCase()}:${input.followersMin}:${input.followersMax ?? "plus"}`;
}

export function designatedFirstG1G2Bucket(familyKey: string): "G1" | "G2" {
  return createHash("md5").update(familyKey, "utf8").digest()[0] % 2 === 0 ? "G1" : "G2";
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value: number, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function schedulerSlot(claimSequence: number, g4ProbeCadence = G4_PROBE_CADENCE, primaryCycle = PRIMARY_SCHEDULER_CYCLE): SchedulerSlot {
  if (!Number.isInteger(claimSequence) || claimSequence < 1) throw new Error("Scheduler claim sequence must be a positive integer");
  if (!Number.isInteger(g4ProbeCadence) || g4ProbeCadence < 100) throw new Error("G4 probe cadence must be at least 100 claims");
  if (!Number.isInteger(primaryCycle) || primaryCycle < 10) throw new Error("Primary scheduler cycle must be at least ten claims");
  if (claimSequence % g4ProbeCadence === 0) return "G4_PROBE";
  const position = ((claimSequence - 1) % primaryCycle) + 1;
  if (position <= Math.floor(primaryCycle * 0.6)) return "PRIMARY_PRODUCTIVE";
  if (position <= Math.floor(primaryCycle * 0.9)) return "PRIMARY_EXPLORATION";
  return "G3_EXPLORATION";
}

function decayFactor(lastSuccessAt: Date | null, now: Date) {
  if (!lastSuccessAt) return 1;
  const ageDays = Math.max(0, now.getTime() - lastSuccessAt.getTime()) / 86_400_000;
  return 2 ** (-ageDays / PRODUCTIVITY_HALF_LIFE_DAYS);
}

export function followerOverlapWeight(targetMin: number | null, targetMax: number | null,
  observedMin: number | null, observedMax: number | null) {
  if (targetMin == null || observedMin == null) return 0;
  if (targetMax == null && observedMax == null) return targetMin === observedMin ? 1 : 0;
  if (observedMax == null) return 0;
  const overlapMin = Math.max(targetMin, observedMin);
  const overlapMax = Math.min(targetMax ?? observedMax, observedMax);
  if (overlapMax < overlapMin) return 0;
  return (overlapMax - overlapMin + 1) / (observedMax - observedMin + 1);
}

export function aggregateEvidence(observations: readonly SchedulerObservation[], now: Date,
  contribution: (observation: SchedulerObservation) => number = () => 1): ProductivityEvidence {
  let rows = 0, newCreators = 0;
  for (const observation of observations) {
    const share = clamp(contribution(observation), 0, 1);
    if (!share || observation.rowsReturned <= 0) continue;
    const weight = share * decayFactor(observation.lastSuccessAt, now);
    rows += observation.rowsReturned * weight;
    newCreators += observation.uniqueCreatorsAdded * weight;
  }
  return { rows, newCreators, yield: rows > 0 ? newCreators / rows : null };
}

function branchObservations(observations: readonly SchedulerObservation[], gmvBucket?: string | null) {
  return gmvBucket ? observations.filter((observation) => observation.gmvBucket === gmvBucket) : observations;
}

export function categoryEvidence(observations: readonly SchedulerObservation[], categoryChildId: string | null, now: Date, gmvBucket?: string | null) {
  return aggregateEvidence(branchObservations(observations, gmvBucket), now,
    (observation) => categoryChildId != null && observation.categoryChildId === categoryChildId ? 1 : 0);
}

export function followerEvidence(observations: readonly SchedulerObservation[], followersMin: number | null,
  followersMax: number | null, now: Date, gmvBucket?: string | null) {
  return aggregateEvidence(branchObservations(observations, gmvBucket), now,
    (observation) => followerOverlapWeight(followersMin, followersMax, observation.followersMin, observation.followersMax));
}

export function softProductivityWeight(evidence: ProductivityEvidence, globalEvidence: ProductivityEvidence,
  kind: "CATEGORY" | "FOLLOWER") {
  const minimumRows = kind === "CATEGORY" ? CATEGORY_MIN_EVIDENCE_ROWS : FOLLOWER_MIN_EVIDENCE_ROWS;
  if (evidence.rows < minimumRows || evidence.yield == null || globalEvidence.yield == null) return 0;
  const confidence = clamp(evidence.rows / 5_000, 0, 1);
  const relative = (evidence.yield - globalEvidence.yield) / Math.max(0.05, globalEvidence.yield);
  const raw = relative * (kind === "CATEGORY" ? 400 : 250) * confidence;
  return rounded(clamp(raw, kind === "CATEGORY" ? -450 : -250, kind === "CATEGORY" ? 250 : 200));
}

function classificationSignal(classification: BranchClassification) {
  switch (classification) {
    case "STRONG": return 500;
    case "PRODUCTIVE": return 250;
    case "MARGINAL": return -100;
    case "LOW_VALUE": return -1_200;
    case "EFFECTIVELY_DEAD": return -1_800;
    default: return 0;
  }
}

function depthSignal(depth: number) {
  if (depth <= 0) return 0;
  if (depth === 1) return 100;
  if (depth === 2) return 300;
  if (depth === 3) return 325;
  return 100;
}

function signalDescription(weight: number, noun: string) {
  if (weight <= -150) return `weak ${noun} penalty`;
  if (weight >= 100) return `strong ${noun} signal`;
  return null;
}

export function scoreSchedulerPriority(input: SchedulerPriorityInput): SchedulerPriority {
  const categoryWeight = softProductivityWeight(input.categoryEvidence, input.globalEvidence, "CATEGORY");
  const followerWeight = softProductivityWeight(input.followerEvidence, input.globalEvidence, "FOLLOWER");
  if (input.gmvBucket === "G4") return { schedulerClass: "EXPERIMENT_ONLY", score: -10_000, categoryWeight, followerWeight,
    reason: "Very High retained for deterministic rare probing only" };
  if (input.partitionType === "V2_SEED") {
    const penalty = signalDescription(categoryWeight, "category");
    if (input.gmvBucket === "G3") return { schedulerClass: "LOW", score: -500, categoryWeight, followerWeight,
      reason: "High GMV lower-priority exploration" };
    return { schedulerClass: "EXPLORATION", score: 100, categoryWeight, followerWeight,
      reason: penalty ? `Low/Medium exploration slot; ${penalty} recorded but quota preserved` : "Low/Medium exploration slot" };
  }

  const authoritativeLow = input.branchClassification === "LOW_VALUE" || input.branchClassification === "EFFECTIVELY_DEAD";
  const meaningful = (input.evidenceRows ?? 0) >= BRANCH_EVIDENCE_MIN_ROWS;
  const productive = meaningful && (input.expectedYield ?? 0) >= 0.10 && (input.expectedNewPerSuccessfulPage ?? 0) >= 4;
  const strongG3 = meaningful && (input.expectedYield ?? 0) >= 0.20 && (input.expectedNewPerSuccessfulPage ?? 0) >= 4;
  const schedulerClass: SchedulerClass = authoritativeLow ? "LOW"
    : input.gmvBucket === "G3" ? strongG3 ? "MEDIUM" : "LOW"
    : productive ? "HIGH" : "MEDIUM";
  const score = 1_000 + depthSignal(input.adaptiveDepth) + classificationSignal(input.branchClassification)
    + clamp(input.expectedYield ?? 0, 0, 0.60) * 1_000
    + clamp(input.expectedNewPerSuccessfulPage ?? 0, 0, 20) * 20
    + (input.observedSaturated ? 75 : 0) + categoryWeight + followerWeight;
  const parts = [
    authoritativeLow ? `${input.branchClassification.replaceAll("_", " ")} branch override`
      : input.gmvBucket === "G3" && schedulerClass === "MEDIUM" ? `High GMV branch promoted by ${Math.round(input.evidenceRows ?? 0)} local rows`
      : schedulerClass === "HIGH" ? `Depth ${input.adaptiveDepth} productive Low/Medium branch`
      : `Depth ${input.adaptiveDepth} ${productive ? "promising" : "unproven"} adaptive branch`,
    signalDescription(categoryWeight, "category"),
    signalDescription(followerWeight, "follower band")
  ].filter((part): part is string => Boolean(part));
  return { schedulerClass, score: rounded(score), reason: parts.join("; "), categoryWeight, followerWeight };
}

function ordered<C extends ScoredSchedulerCandidate<unknown>>(candidates: readonly C[], classes?: readonly SchedulerClass[]) {
  return candidates.filter((candidate) => !classes || classes.includes(candidate.priority.schedulerClass)).sort((left, right) =>
    (classes ? classes.indexOf(left.priority.schedulerClass) - classes.indexOf(right.priority.schedulerClass) : 0)
    || right.priority.score - left.priority.score
    || (left.queuePosition < right.queuePosition ? -1 : left.queuePosition > right.queuePosition ? 1 : left.id.localeCompare(right.id)));
}

export function selectSchedulerCandidate<C extends ScoredSchedulerCandidate<unknown>>(candidates: readonly C[], slot: SchedulerSlot) : C | null {
  const primary = candidates.filter((candidate) => candidate.gmvBucket === "G1" || candidate.gmvBucket === "G2");
  const g3 = candidates.filter((candidate) => candidate.gmvBucket === "G3");
  const g4 = candidates.filter((candidate) => candidate.gmvBucket === "G4");
  const productivePrimary = ordered(primary, ["HIGH"]);
  const unknownPrimary = ordered(primary, slot === "PRIMARY_EXPLORATION" ? ["EXPLORATION", "MEDIUM"] : ["MEDIUM", "EXPLORATION"]);
  const productiveG3 = ordered(g3, ["HIGH", "MEDIUM"]);
  const generalG3 = ordered(g3, ["EXPLORATION", "LOW"]);
  const lowPrimary = ordered(primary, ["LOW"]);
  const pools = slot === "G4_PROBE" ? [ordered(g4, ["EXPERIMENT_ONLY"]), productivePrimary, unknownPrimary, productiveG3, generalG3, lowPrimary]
    : slot === "G3_EXPLORATION" ? [productiveG3, generalG3, productivePrimary, unknownPrimary, lowPrimary]
    : slot === "PRIMARY_EXPLORATION" ? [unknownPrimary, productivePrimary, productiveG3, generalG3, lowPrimary]
    : [productivePrimary, unknownPrimary, productiveG3, generalG3, lowPrimary];
  return pools.find((pool) => pool.length)?.[0] ?? null;
}

export function schedulerSelectionMessage(priority: SchedulerPriority, partitionType: ProductionPartitionType, depth: number) {
  if (priority.schedulerClass === "EXPERIMENT_ONLY") return "Selected Very High partition — deterministic rare probe";
  if (priority.schedulerClass === "EXPLORATION") return "Selected Low/Medium seed — exploration quota";
  const type = partitionType === "ADAPTIVE_GMV" ? "GMV adaptive" : `adaptive Depth ${depth}`;
  return `Selected ${type} partition — ${priority.schedulerClass.toLowerCase()} expected discovery yield`;
}
