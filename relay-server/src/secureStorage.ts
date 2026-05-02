import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

interface EncryptedFileEnvelope {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

const DEFAULT_STATE_DIR = path.join(os.homedir(), ".vaulkyrie", "relay");
const LOCAL_SECRET_FILE = "local-secret.key";

function ensureParentDirectory(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function readOrCreateLocalSecret(filePath: string): string {
  ensureParentDirectory(filePath);
  if (existsSync(filePath)) {
    return readFileSync(filePath, "utf8").trim();
  }

  const secret = randomBytes(32).toString("base64url");
  writeFileSync(filePath, secret, { mode: 0o600 });
  return secret;
}

function resolveSecretMaterial(): string {
  const explicit = process.env.VAULKYRIE_RELAY_SECRET_PASSPHRASE?.trim();
  if (explicit) {
    return explicit;
  }

  const cosignerToken = process.env.COSIGNER_ADMIN_TOKEN?.trim();
  const sponsorToken = process.env.PQC_SPONSOR_ADMIN_TOKEN?.trim();
  if (cosignerToken || sponsorToken) {
    return `${cosignerToken ?? ""}:${sponsorToken ?? ""}`;
  }

  const stateDir = path.resolve(process.env.VAULKYRIE_RELAY_STATE_DIR ?? DEFAULT_STATE_DIR);
  return readOrCreateLocalSecret(path.join(stateDir, LOCAL_SECRET_FILE));
}

function deriveEncryptionKey(salt: Buffer): Buffer {
  return scryptSync(resolveSecretMaterial(), salt, 32);
}

function encryptJson(value: unknown): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveEncryptionKey(salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);

  const payload: EncryptedFileEnvelope = {
    version: 1,
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  return JSON.stringify(payload);
}

function tryDecryptJson(raw: string): unknown {
  const parsed = JSON.parse(raw) as Partial<EncryptedFileEnvelope>;
  if (
    parsed.version !== 1
    || typeof parsed.salt !== "string"
    || typeof parsed.iv !== "string"
    || typeof parsed.tag !== "string"
    || typeof parsed.ciphertext !== "string"
  ) {
    throw new Error("Not an encrypted relay storage envelope.");
  }

  const salt = Buffer.from(parsed.salt, "base64url");
  const iv = Buffer.from(parsed.iv, "base64url");
  const tag = Buffer.from(parsed.tag, "base64url");
  const ciphertext = Buffer.from(parsed.ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", deriveEncryptionKey(salt), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext);
}

function normalizePaths(paths: Array<string | null | undefined>): string[] {
  return [...new Set(paths.filter((candidate): candidate is string => Boolean(candidate)).map((candidate) => path.resolve(candidate)))];
}

export function secureRelayStatePath(fileName: string): string {
  const stateDir = path.resolve(process.env.VAULKYRIE_RELAY_STATE_DIR ?? DEFAULT_STATE_DIR);
  ensureParentDirectory(path.join(stateDir, fileName));
  return path.join(stateDir, fileName);
}

export function writeSecureJsonFile(filePath: string, value: unknown): void {
  ensureParentDirectory(filePath);
  writeFileSync(filePath, encryptJson(value), { mode: 0o600 });
}

export function readSecureJsonFile<T>(
  filePath: string,
  options?: {
    fallback?: T;
    legacyPaths?: Array<string | null | undefined>;
  },
): T {
  const securePath = path.resolve(filePath);
  const fallback = options?.fallback;
  const legacyPaths = normalizePaths(options?.legacyPaths ?? []);

  if (existsSync(securePath)) {
    const raw = readFileSync(securePath, "utf8");
    try {
      return tryDecryptJson(raw) as T;
    } catch {
      const legacyValue = JSON.parse(raw) as T;
      writeSecureJsonFile(securePath, legacyValue);
      return legacyValue;
    }
  }

  for (const legacyPath of legacyPaths) {
    if (!existsSync(legacyPath)) {
      continue;
    }

    const legacyValue = JSON.parse(readFileSync(legacyPath, "utf8")) as T;
    writeSecureJsonFile(securePath, legacyValue);
    rmSync(legacyPath, { force: true });
    return legacyValue;
  }

  if (fallback !== undefined) {
    return fallback;
  }

  throw new Error(`Relay secure storage file not found: ${securePath}`);
}
