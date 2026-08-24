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
