import { describe, expect, it } from "vitest";
import { publicTikTokConnection, validateTikTokCallbackInput } from "./tiktok.service";

describe("TikTok authorization callback shape", () => {
  it("rejects missing state, rejection, and malformed success", () => {
    expect(() => validateTikTokCallbackInput({ code: "code" })).toThrowError(/state/i);
    expect(() => validateTikTokCallbackInput({ state: "state", error: "auth_denied" })).toThrowError(/rejected/i);
    expect(() => validateTikTokCallbackInput({ state: "state" })).toThrowError(/code/i);
  });
  it("accepts a state-bound code for server-side single-use validation", () => {
    expect(() => validateTikTokCallbackInput({ state: "unguessable", code: "one-time" })).not.toThrow();
  });
});

describe("TikTok connection API redaction", () => {
  it("returns health metadata without stored tokens or ciphertext", () => {
    const source = { status: "HEALTHY", sellerOpenId: "seller", grantedScopes: [], accessTokenExpiresAt: new Date(), refreshTokenExpiresAt: new Date(), lastAuthorizedAt: new Date(), lastRefreshAt: null, lastRefreshFailureAt: null, refreshFailureCount: 0, lastApiRequestAt: null, lastRequestId: null, lastErrorCode: null, lastErrorMessage: null,
      accessTokenCiphertext: "secret-access", refreshTokenCiphertext: "secret-refresh" };
    const result = publicTikTokConnection(source);
    expect(result).not.toHaveProperty("accessTokenCiphertext");
    expect(result).not.toHaveProperty("refreshTokenCiphertext");
    expect(JSON.stringify(result)).not.toContain("secret-");
  });
});
