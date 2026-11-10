import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { TokenCryptoError, decryptToken, encryptToken, parseKey } from "../crypto";

const KEY_B64 = randomBytes(32).toString("base64");
const KEY = parseKey(KEY_B64);
const TOKEN = "access-sandbox-12345678-aaaa-bbbb-cccc-1234567890ab";

describe("token encryption (AES-256-GCM)", () => {
  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it("round-trips a token", () => {
    const enc = encryptToken(TOKEN, "item-1", KEY);
    expect(enc.startsWith("v1.")).toBe(true);
    expect(enc).not.toContain(TOKEN);
    expect(decryptToken(enc, "item-1", KEY)).toBe(TOKEN);
  });

  it("uses a fresh IV every time", () => {
    expect(encryptToken(TOKEN, "item-1", KEY)).not.toBe(encryptToken(TOKEN, "item-1", KEY));
  });

  it("reads the key from TOKEN_ENCRYPTION_KEY", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_B64;
    expect(decryptToken(encryptToken(TOKEN, "item-1"), "item-1")).toBe(TOKEN);
  });

  it("fails with the wrong key", () => {
    const enc = encryptToken(TOKEN, "item-1", KEY);
    expect(() => decryptToken(enc, "item-1", randomBytes(32))).toThrow(TokenCryptoError);
  });

  it("fails when the token is moved to another item (associated data)", () => {
    const enc = encryptToken(TOKEN, "item-1", KEY);
    expect(() => decryptToken(enc, "item-2", KEY)).toThrow(TokenCryptoError);
  });

  it("fails when the ciphertext or tag is tampered with", () => {
    const enc = encryptToken(TOKEN, "item-1", KEY);
    const [v, iv, tag, ct] = enc.split(".");
    const flip = (s: string) => {
      const b = Buffer.from(s, "base64url");
      b[0] ^= 1;
      return b.toString("base64url");
    };
    expect(() => decryptToken([v, iv, tag, flip(ct)].join("."), "item-1", KEY)).toThrow(TokenCryptoError);
    expect(() => decryptToken([v, iv, flip(tag), ct].join("."), "item-1", KEY)).toThrow(TokenCryptoError);
    expect(() => decryptToken("v2." + [iv, tag, ct].join("."), "item-1", KEY)).toThrow(TokenCryptoError);
  });

  it("rejects keys that are missing, not base64 or not 32 bytes", () => {
    expect(() => parseKey(undefined)).toThrow(/not set/);
    expect(() => parseKey("not base64 !!")).toThrow(/base64/);
    expect(() => parseKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => encryptToken(TOKEN)).toThrow(/not set/);
  });

  it("error messages never include the token", () => {
    const enc = encryptToken(TOKEN, "item-1", KEY);
    try {
      decryptToken(enc, "other", KEY);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(TOKEN);
    }
  });
});
