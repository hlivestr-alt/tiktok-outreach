export const DEFAULT_MARKETPLACE_RETRY_DELAY_SECONDS = 3;
export const MIN_MARKETPLACE_RETRY_DELAY_SECONDS = 1;
export const MAX_MARKETPLACE_RETRY_DELAY_SECONDS = 2_147_483_647;

// Existing delay retained for non-36009002 Marketplace retry/error paths.
export const CREATOR_MARKETPLACE_RETRY_MS = 5_000;

export function marketplaceRetryDelayMs(seconds: number): number {
  return seconds * 1_000;
}

export function parseMarketplaceRetryDelaySeconds(value: unknown): number | undefined {
  const candidate = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  return Number.isSafeInteger(candidate) && candidate >= MIN_MARKETPLACE_RETRY_DELAY_SECONDS
    && candidate <= MAX_MARKETPLACE_RETRY_DELAY_SECONDS ? candidate : undefined;
}
