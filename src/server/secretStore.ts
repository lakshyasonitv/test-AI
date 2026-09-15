import crypto from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/**
 * Encryption for per-organisation secrets — today, an organisation's own Gemini API key.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: the key that decrypts the ciphertext must not live in the
 * same database as the ciphertext, and must not sit in `.env` beside every other setting. A
 * database dump must not be sufficient to read the secrets, and neither must a leaked `.env`.
 *
 * So custody is an INTERFACE with one implementation today and an obvious second one later:
 *
 *   - `FileCustody` (now) — a 32-byte key in a file outside the repo, referenced by PATH in the
 *     environment. The env var holds where the key is, never the key itself, which is the whole
 *     point: `.env` leaking does not leak the key, and the file can be `chmod 600` and owned by
 *     a different user than the app's config.
 *   - `KmsCustody` (later) — AWS KMS envelope encryption, where the master key never exists in
 *     this process at all. Slots in as another `KeyCustody` with no change to any caller, which
 *     is why `encryptSecret`/`decryptSecret` take custody rather than reading the environment.
 *
 * AES-256-GCM, so the ciphertext is authenticated: a tampered row fails to decrypt rather than
 * decrypting to something else. The IV is random per encryption and stored beside the ciphertext
 * (it is not secret; reusing one would be the bug).
 */

/** Where a decryption key comes from. One method, so a second provider is cheap to add. */
export interface KeyCustody {
  /** The 32-byte data key used for AES-256-GCM. Throws if custody is not configured. */
  dataKey(): Buffer;
  /** Human-readable, for diagnostics. NEVER includes key material. */
  describe(): string;
}

export class SecretConfigError extends Error {
  readonly isSecretConfigError = true;
}

/**
 * A key read from a file whose PATH is in `LLM_KEY_FILE`.
 *
 * Deliberately not cached across calls beyond one process lifetime: rotating the key is then
 * "replace the file, restart", with no stale copy held anywhere. Reading a small file per
 * encryption is irrelevant next to an LLM call.
 */
export class FileCustody implements KeyCustody {
  constructor(private readonly path: string) { }

  dataKey(): Buffer {
    let raw: Buffer;
    try {
      raw = readFileSync(this.path);
    } catch (err) {
      throw new SecretConfigError(
        `could not read the secret key file at ${this.path}: ${(err as Error)?.message ?? err}. ` +
        `Per-organisation API keys cannot be encrypted or decrypted without it.`,
      );
    }

    // Accept raw 32 bytes or a hex/base64 string, so operators can generate it whichever way is
    // natural (`openssl rand -hex 32`, `head -c 32 /dev/urandom > file`) without a silent
    // mismatch — a wrong-length key would otherwise fail deep inside createCipheriv.
    const text = raw.toString("utf8").trim();
    let key: Buffer;
    if (raw.length === 32) key = raw;
    else if (/^[0-9a-f]{64}$/i.test(text)) key = Buffer.from(text, "hex");
    else if (/^[A-Za-z0-9+/=]{44}$/.test(text)) key = Buffer.from(text, "base64");
    else {
      throw new SecretConfigError(
        `the secret key file at ${this.path} is not a 32-byte key. Expected 32 raw bytes, 64 hex ` +
        `characters, or 44 base64 characters; found ${raw.length} bytes. ` +
        `Generate one with: openssl rand -hex 32`,
      );
    }
    if (key.length !== 32) {
      throw new SecretConfigError(`the secret key at ${this.path} decoded to ${key.length} bytes, not 32`);
    }

    // A world-readable key file defeats the point of keeping it out of the database and out of
    // .env. Warned rather than refused: permissions on Windows and in containers do not map
    // cleanly, and refusing to boot over a mode bit would be worse than saying so loudly.
    try {
      const mode = statSync(this.path).mode & 0o077;
      if (mode !== 0 && process.platform !== "win32") {
        console.warn(
          `[secrets] WARNING: ${this.path} is readable by group or others (mode ${(statSync(this.path).mode & 0o777).toString(8)}). ` +
          `chmod 600 it — this key decrypts every organisation's stored API key.`,
        );
      }
    } catch { /* diagnostics only */ }

    return key;
  }

  describe(): string { return `file:${this.path}`; }
}

/**
 * The custody this server is configured for, or null when none is.
 *
 * Null is not an error here — it is the ordinary state of a server that has not enabled
 * per-organisation keys. It becomes an error only when something actually tries to store one,
 * which is where the message belongs.
 */
export function custodyFromEnv(): KeyCustody | null {
  const file = process.env.LLM_KEY_FILE;
  if (file && file.trim()) return new FileCustody(file.trim());
  return null;
}

/** The custody, or a clear refusal naming what to configure. */
export function requireCustody(): KeyCustody {
  const custody = custodyFromEnv();
  if (!custody) {
    throw new SecretConfigError(
      "no secret key custody is configured, so an organisation API key cannot be stored. " +
      "Set LLM_KEY_FILE to the path of a 32-byte key file (generate one with `openssl rand -hex 32`), " +
      "kept outside the repository and outside .env. The variable holds the PATH, never the key.",
    );
  }
  return custody;
}

/** An encrypted secret as it is stored: all three parts are needed, none of them is secret alone. */
export interface SealedSecret {
  /** base64 ciphertext */
  ct: string;
  /** base64 12-byte random IV */
  iv: string;
  /** base64 16-byte GCM auth tag */
  tag: string;
  /** Which custody sealed it, so a later reader can tell why it cannot open it. */
  custody: string;
}

export function encryptSecret(plaintext: string, custody: KeyCustody = requireCustody()): SealedSecret {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", custody.dataKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ct: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    custody: custody.describe(),
  };
}

export function decryptSecret(sealed: SealedSecret, custody: KeyCustody = requireCustody()): string {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm", custody.dataKey(), Buffer.from(sealed.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ct, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    // Never include the ciphertext, the key path's contents, or any partial plaintext.
    throw new SecretConfigError(
      `a stored organisation API key could not be decrypted (sealed by ${sealed.custody}, ` +
      `opening with ${custody.describe()}). The key file has probably changed or been replaced; ` +
      `the organisation must set its API key again.`,
    );
  }
}

/**
 * A non-reversible fingerprint of a secret, safe to log, cache-key and return to a client.
 *
 * Exists so "is this the same key as before?" is answerable — by the cache, and by a person
 * looking at two organisations — without the value ever being exposed. Truncated because a full
 * digest of a low-entropy secret is closer to the secret than people assume.
 */
export function secretFingerprint(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

/** The last four characters, for a UI that must show *which* key is set without revealing it. */
export function secretHint(secret: string): string {
  const tail = secret.trim().slice(-4);
  return tail ? `••••${tail}` : "••••";
}
