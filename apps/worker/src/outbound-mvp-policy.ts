import { randomBytes } from "node:crypto";

export type LeaseStore = {
  find(shopId: string): Promise<{ owner: string; expiresAt: Date } | null>;
  put(shopId: string, owner: string, expiresAt: Date): Promise<void>;
  remove(shopId: string, owner: string): Promise<void>;
};

/** Small deterministic model used by the database implementation and tests. */
export async function withShopMutationLease<T>(store: LeaseStore, shopId: string, now: Date, task: () => Promise<T>): Promise<T> {
  const existing = await store.find(shopId);
  if (existing && existing.expiresAt > now) throw new Error("SHOP_OUTBOUND_SEQUENCE_BUSY");
  const owner = randomBytes(12).toString("hex");
  await store.put(shopId, owner, new Date(now.getTime() + 120_000));
  try { return await task(); }
  finally { await store.remove(shopId, owner); }
}

export function classifySendException(transmitted: boolean, responseKnown: boolean): "RETRYABLE_PRE_SEND" | "UNKNOWN" {
  return transmitted && !responseKnown ? "UNKNOWN" : "RETRYABLE_PRE_SEND";
}

export function shouldAutoRetryDelivery(state: string): boolean {
  return ["PENDING", "FAILED_RETRYABLE"].includes(state);
}

export function completionState(states: string[]): "COMPLETED" | "COMPLETED_WITH_ERRORS" | null {
  if (!states.length || states.some((state) => ["RESERVED", "QUEUED", "PROCESSING", "DELIVERY_UNKNOWN"].includes(state))) return null;
  return states.every((state) => state === "SENT") ? "COMPLETED" : "COMPLETED_WITH_ERRORS";
}
