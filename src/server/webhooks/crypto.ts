import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { AppError } from "@/lib/errors";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type WebhookKeyring = {
  currentVersion: string;
  keys: ReadonlyMap<string, Buffer>;
};

export type EncryptedWebhookSecret = {
  secretCiphertext: string;
  secretIv: string;
  secretAuthTag: string;
  encryptionKeyVersion: string;
};

export type WebhookSecretBinding = { organizationId: string; endpointId: string };

function unavailable(): AppError {
  return new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
}

function decodeKey(raw: string): Buffer {
  const value = raw.trim();
  let key: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(value)) key = Buffer.from(value, "hex");
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) key = Buffer.from(value.replace(/=$/, ""), "base64url");
  if (!key || key.length !== KEY_BYTES) throw unavailable();
  return key;
}

/**
 * `WEBHOOK_ENCRYPTION_KEY` is the current key and `WEBHOOK_ENCRYPTION_KEY_VERSION`
 * (default `v1`) names it. Keys kept only for decrypting older rows are read
 * from `WEBHOOK_ENCRYPTION_KEY_<VERSION>` (for example `WEBHOOK_ENCRYPTION_KEY_V1`).
 */
export function loadWebhookKeyring(environment: NodeJS.ProcessEnv = process.env): WebhookKeyring {
  const currentVersion = (environment.WEBHOOK_ENCRYPTION_KEY_VERSION ?? "v1").trim() || "v1";
  if (!VERSION_PATTERN.test(currentVersion)) throw unavailable();
  const current = environment.WEBHOOK_ENCRYPTION_KEY;
  if (!current?.trim()) throw unavailable();
  const keys = new Map<string, Buffer>([[currentVersion, decodeKey(current)]]);
  const prefix = "WEBHOOK_ENCRYPTION_KEY_";
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith(prefix) || name === "WEBHOOK_ENCRYPTION_KEY_VERSION" || !value?.trim()) continue;
    const version = name.slice(prefix.length).toLowerCase();
    if (!VERSION_PATTERN.test(version) || keys.has(version)) continue;
    keys.set(version, decodeKey(value));
  }
  return { currentVersion, keys };
}

function additionalData(binding: WebhookSecretBinding, version: string): Buffer {
  return Buffer.from(JSON.stringify(["uno.webhook-secret", version, binding.organizationId, binding.endpointId]), "utf8");
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export function encryptWebhookSecret(secret: string, binding: WebhookSecretBinding, keyring: WebhookKeyring): EncryptedWebhookSecret {
  const key = keyring.keys.get(keyring.currentVersion);
  if (!key) throw unavailable();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(binding, keyring.currentVersion));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    secretCiphertext: ciphertext.toString("base64"),
    secretIv: iv.toString("base64"),
    secretAuthTag: cipher.getAuthTag().toString("base64"),
    encryptionKeyVersion: keyring.currentVersion,
  };
}

/** Fails closed: any tampering, wrong organization/endpoint or unknown key version throws. */
export function decryptWebhookSecret(encrypted: EncryptedWebhookSecret, binding: WebhookSecretBinding, keyring: WebhookKeyring): string {
  const key = keyring.keys.get(encrypted.encryptionKeyVersion);
  const iv = Buffer.from(encrypted.secretIv, "base64");
  const tag = Buffer.from(encrypted.secretAuthTag, "base64");
  if (!key || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new AppError("webhook_secret_unavailable", "Segredo do webhook indisponível.", 500);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(additionalData(binding, encrypted.encryptionKeyVersion));
    decipher.setAuthTag(tag);
    const secret = Buffer.concat([decipher.update(Buffer.from(encrypted.secretCiphertext, "base64")), decipher.final()]).toString("utf8");
    if (!secret) throw new Error("empty");
    return secret;
  } catch {
    throw new AppError("webhook_secret_unavailable", "Segredo do webhook indisponível.", 500);
  }
}

/** `v1=<lowercase hex HMAC-SHA256(secret, "<timestamp>.<exact body bytes>")>`. */
export function signWebhookBody(secret: string, timestampSeconds: number, body: string): string {
  const digest = createHmac("sha256", secret).update(`${timestampSeconds}.`, "utf8").update(body, "utf8").digest("hex");
  return `v1=${digest}`;
}
