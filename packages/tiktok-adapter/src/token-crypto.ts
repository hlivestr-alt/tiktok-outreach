import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const decodeKey = (encoded: string): Buffer => {
  const key = /^[0-9a-f]{64}$/i.test(encoded) ? Buffer.from(encoded, "hex") : Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("TIKTOK_TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes");
  return key;
};

export function encryptTikTokToken(plaintext: string, encodedKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(encodedKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}
export function decryptTikTokToken(envelope: string, encodedKey: string): string {
  const [version, ivText, tagText, ciphertextText] = envelope.split(".");
  if (version !== "v1" || !ivText || !tagText || ciphertextText == null) throw new Error("Unsupported TikTok token envelope");
  const decipher = createDecipheriv("aes-256-gcm", decodeKey(encodedKey), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}
