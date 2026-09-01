import type { BranchClassification, ProductionPartitionType } from "./marketplace-partitions";

export const CATEGORY_MIN_EVIDENCE_ROWS = 1_000;
export const FOLLOWER_MIN_EVIDENCE_ROWS = 1_000;
export const PRODUCTIVITY_HALF_LIFE_DAYS = 14;

export type SchedulerClass = "HIGH" | "MEDIUM" | "EXPLORATION" | "LOW";
export type SchedulerSlot = "HIGH" | "MEDIUM" | "EXPLORATION";
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

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value: number, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function schedulerSlot(claimSequence: number, explorationInterval = 7): SchedulerSlot {
  if (explorationInterval < 3) throw new Error("Scheduler exploration interval must be at least three claims");
  const position = ((claimSequence - 1) % explorationInterval) + 1;
  if (position === explorationInterval) return "EXPLORATION";
  if (position === Math.ceil(explorationInterval / 2)) return "MEDIUM";
  return "HIGH";
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
  if (input.partitionType === "V2_SEED") {
    const penalty = signalDescription(categoryWeight, "category");
    return { schedulerClass: "EXPLORATION", score: 100, categoryWeight, followerWeight,
      reason: penalty ? `Specific-GMV exploration slot; ${penalty} recorded but quota preserved` : "Specific-GMV exploration slot" };
  }

  const authoritativeLow = input.branchClassification === "LOW_VALUE" || input.branchClassification === "EFFECTIVELY_DEAD";
  const productive = input.branchClassification === "STRONG" || input.branchClassification === "PRODUCTIVE"
    || (input.expectedYield ?? 0) >= 0.10;
  const schedulerClass: SchedulerClass = authoritativeLow ? "LOW"
    : input.adaptiveDepth >= 2 && productive ? "HIGH"
    : input.partitionType === "ADAPTIVE_GMV" && productive ? "HIGH"
    : "MEDIUM";
  const score = 1_000 + depthSignal(input.adaptiveDepth) + classificationSignal(input.branchClassification)
    + clamp(input.expectedYield ?? 0, 0, 0.60) * 1_000
    + clamp(input.expectedNewPerSuccessfulPage ?? 0, 0, 20) * 20
    + (input.observedSaturated ? 75 : 0) + categoryWeight + followerWeight;
  const parts = [
    authoritativeLow ? `${input.branchClassification.replaceAll("_", " ")} branch override`
      : schedulerClass === "HIGH" ? `Depth ${input.adaptiveDepth} productive branch`
      : `Depth ${input.adaptiveDepth} ${productive ? "promising" : "unproven"} adaptive branch`,
    signalDescription(categoryWeight, "category"),
    signalDescription(followerWeight, "follower band")
  ].filter((part): part is string => Boolean(part));
  return { schedulerClass, score: rounded(score), reason: parts.join("; "), categoryWeight, followerWeight };
}

function ordered<C extends ScoredSchedulerCandidate<unknown>>(candidates: readonly C[], schedulerClass: SchedulerClass, targetGmvBucket?: string) {
  return candidates.filter((candidate) => candidate.priority.schedulerClass === schedulerClass).sort((left, right) =>
    (schedulerClass === "EXPLORATION" && targetGmvBucket ? Number(right.gmvBucket === targetGmvBucket) - Number(left.gmvBucket === targetGmvBucket) : 0)
      || right.priority.score - left.priority.score
      || (left.queuePosition < right.queuePosition ? -1 : left.queuePosition > right.queuePosition ? 1 : left.id.localeCompare(right.id)));
}

export function selectSchedulerCandidate<C extends ScoredSchedulerCandidate<unknown>>(candidates: readonly C[], slot: SchedulerSlot,
  explorationGmvBucket?: string) : C | null {
  const fallback: SchedulerClass[] = slot === "EXPLORATION"
    ? ["EXPLORATION", "HIGH", "MEDIUM", "LOW"]
    : slot === "MEDIUM" ? ["MEDIUM", "HIGH", "LOW", "EXPLORATION"]
    : ["HIGH", "MEDIUM", "LOW", "EXPLORATION"];
  for (const schedulerClass of fallback) {
    const candidate = ordered(candidates, schedulerClass, slot === "EXPLORATION" ? explorationGmvBucket : undefined)[0];
    if (candidate) return candidate;
  }
  return null;
}

export function schedulerSelectionMessage(priority: SchedulerPriority, partitionType: ProductionPartitionType, depth: number) {
  if (priority.schedulerClass === "EXPLORATION") return "Selected specific-GMV seed — exploration quota";
  const type = partitionType === "ADAPTIVE_GMV" ? "GMV adaptive" : `adaptive Depth ${depth}`;
  return `Selected ${type} partition — ${priority.schedulerClass.toLowerCase()} expected discovery yield`;
}
