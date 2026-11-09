/**
 * AES-256-GCM encryption for Plaid access tokens.
 *
 * Key: TOKEN_ENCRYPTION_KEY, base64 of exactly 32 random bytes.
 *   Generate one with: openssl rand -base64 32
 *
 * Output format: "v1.<iv>.<tag>.<ciphertext>", each part base64url.
 * A fresh 12-byte IV is used for every encryption. Optional associated data
 * (we pass the Plaid item_id) binds a ciphertext to its row, so a token copied
 * onto another item fails to decrypt.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoError";
  }
}

/** Parse and check a base64 key. Throws if it is not exactly 32 bytes. */
export function parseKey(b64: string | undefined | null): Buffer {
  if (!b64) throw new TokenCryptoError("TOKEN_ENCRYPTION_KEY is not set");
  const trimmed = b64.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) throw new TokenCryptoError("TOKEN_ENCRYPTION_KEY must be base64");
  const key = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) throw new TokenCryptoError(`TOKEN_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length})`);
  return key;
}

function keyFromEnv(): Buffer {
  return parseKey(process.env.TOKEN_ENCRYPTION_KEY);
}

export function encryptToken(plaintext: string, aad?: string, key: Buffer = keyFromEnv()): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) throw new TokenCryptoError("Nothing to encrypt");
  if (key.length !== 32) throw new TokenCryptoError("Key must be 32 bytes");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptToken(payload: string, aad?: string, key: Buffer = keyFromEnv()): string {
  if (typeof payload !== "string") throw new TokenCryptoError("Bad payload");
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new TokenCryptoError("Unknown token format");
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const ct = Buffer.from(parts[3], "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ct.length === 0) throw new TokenCryptoError("Malformed token");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    // Never echo the payload or the key.
    throw new TokenCryptoError("Could not decrypt the token (wrong key, wrong item, or tampered)");
  }
}
