import { createHmac } from "node:crypto";

export type SigningInput = {
  path: string;
  query: Record<string, string | number | boolean | undefined>;
  body?: string;
  contentType?: string;
  appSecret: string;
};

/** Implements TikTok Shop's documented HMAC-SHA256 canonical request algorithm. */
export function signTikTokShopRequest(input: SigningInput): string {
  const parameterString = Object.entries(input.query)
    .filter(([key, value]) => key !== "sign" && key !== "access_token" && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}${String(value)}`)
    .join("");
  const includeBody = input.contentType?.toLowerCase() !== "multipart/form-data";
  const canonical = `${input.path}${parameterString}${includeBody ? input.body ?? "" : ""}`;
  const wrapped = `${input.appSecret}${canonical}${input.appSecret}`;
  return createHmac("sha256", input.appSecret).update(wrapped).digest("hex");
}
