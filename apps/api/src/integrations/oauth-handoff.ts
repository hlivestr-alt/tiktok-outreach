import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const REGISTER_PATH = "/api/outreach/tiktok/native/register";
export const COMPLETE_PATH = "/api/v1/integrations/tiktok/private-completion";
export const NATIVE_START_PATH = "/api/outreach/tiktok/native/start";
export const NATIVE_COOKIE = "native_oauth_browser";
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const opaque = () => randomBytes(32).toString("base64url");
export const isOpaque = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function canonicalBody(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalBody).join(",") + "]";
  const object = value as Record<string, unknown>;
  return "{" + Object.keys(object).sort().map(k => JSON.stringify(k) + ":" + canonicalBody(object[k])).join(",") + "}";
}
function signature(key: string, path: string, timestamp: string, nonce: string, body: unknown) {
  if (!isDigest(key)) throw new Error("OAUTH_PRIVATE_CONFIGURATION_UNAVAILABLE");
  return createHmac("sha256", Buffer.from(key, "hex")).update(canonicalBody(["OUTREACH_PRIVATE_HANDOFF_V1", "POST", path, timestamp, nonce, digest(canonicalBody(body))])).digest("hex");
}
export function signHandoff(key: string, path: string, body: unknown, now = Date.now(), nonce = opaque()) {
  const timestamp = String(Math.floor(now / 1000));
  return { "x-oauth-time": timestamp, "x-oauth-nonce": nonce, "x-oauth-signature": signature(key, path, timestamp, nonce, body) };
}
export function verifyHandoff(key: string, path: string, body: unknown, headers: { get(name: string): string | null }, now = Date.now()) {
  const timestamp = headers.get("x-oauth-time") || "", nonce = headers.get("x-oauth-nonce") || "", mac = headers.get("x-oauth-signature") || "";
  if (!/^\d{10}$/.test(timestamp) || !isOpaque(nonce) || Math.abs(now - Number(timestamp) * 1000) > 60000 || canonicalBody(body).length > 12000 || !isDigest(mac) || !timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(signature(key, path, timestamp, nonce, body), "hex"))) throw new Error("OAUTH_PRIVATE_HANDOFF_REJECTED");
  return { nonceHash: digest(nonce), expiresAt: new Date(now + 120000) };
}
export function browserCookie(headers: { cookie?: string }) {
  return (headers.cookie || "").split(";").map(v => v.trim()).find(v => v.startsWith(NATIVE_COOKIE + "="))?.slice(NATIVE_COOKIE.length + 1);
}
export function operatorOrigin(origin: string | undefined, configured: string | undefined) {
  if (!configured || origin !== configured) throw new Error("OAUTH_OPERATOR_ORIGIN_REJECTED");
  const u = new URL(configured);
  if (u.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new Error("OAUTH_OPERATOR_ORIGIN_REJECTED");
}
export function routerOrigin(value: string | undefined, test: boolean) {
  if (!value) throw new Error("OAUTH_ROUTER_UNAVAILABLE");
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/" || !(u.protocol === "https:" || test && u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) throw new Error("OAUTH_ROUTER_UNAVAILABLE");
  return u;
}
