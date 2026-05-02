import { Buffer } from "buffer";
import { Keypair } from "@solana/web3.js";
import { decryptString, encryptString } from "@/lib/crypto";
import type { PrivacyVaultEncryptedKeyRecord } from "@/store/walletStore";
import {
  derivePrivacyVaultKeypairFromMnemonic,
  normalizePrivacyVaultMnemonic,
  PRIVACY_VAULT_DERIVATION_PATH,
} from "@/services/privacyVault/mnemonic";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

type PrivacyVaultSecretPayload =
  | {
      version: 2;
      recoveryModel: "legacy-private-key";
      secretKeyBase64: string;
    }
  | {
      version: 2;
      recoveryModel: "mnemonic";
      mnemonic: string;
      derivationPath: string;
    };

export interface PrivacyVaultWorkingKey {
  keypair: Keypair;
  recoveryModel: "legacy-private-key" | "mnemonic";
  derivationPath?: string;
  mnemonic?: string;
}

function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }

  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let leadingZeroCount = 0;
  while (leadingZeroCount < bytes.length && bytes[leadingZeroCount] === 0) {
    leadingZeroCount += 1;
  }

  let encoded = "1".repeat(leadingZeroCount);
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    encoded += BASE58_ALPHABET[digits[index]];
  }
  return encoded;
}

function createPrivacyVaultRecord(
  payload: PrivacyVaultSecretPayload,
  encrypted: Awaited<ReturnType<typeof encryptString>>,
): PrivacyVaultEncryptedKeyRecord {
  return {
    kind: "privacy-vault-key",
    version: 2,
    recoveryModel: payload.recoveryModel,
    derivationPath: payload.recoveryModel === "mnemonic" ? payload.derivationPath : null,
    createdAt: Date.now(),
    ...encrypted,
  };
}

export async function createEncryptedPrivacyVaultKeyRecord(
  secretKey: Uint8Array,
  password: string,
): Promise<PrivacyVaultEncryptedKeyRecord> {
  const payload: PrivacyVaultSecretPayload = {
    version: 2,
    recoveryModel: "legacy-private-key",
    secretKeyBase64: Buffer.from(secretKey).toString("base64"),
  };
  const encrypted = await encryptString(JSON.stringify(payload), password);
  return createPrivacyVaultRecord(payload, encrypted);
}

export async function createEncryptedPrivacyVaultMnemonicRecord(
  mnemonic: string,
  password: string,
  derivationPath: string = PRIVACY_VAULT_DERIVATION_PATH,
): Promise<{ keyRecord: PrivacyVaultEncryptedKeyRecord; keypair: Keypair; mnemonic: string }> {
  const normalized = normalizePrivacyVaultMnemonic(mnemonic);
  const payload: PrivacyVaultSecretPayload = {
    version: 2,
    recoveryModel: "mnemonic",
    mnemonic: normalized,
    derivationPath,
  };
  const encrypted = await encryptString(JSON.stringify(payload), password);
  return {
    keyRecord: createPrivacyVaultRecord(payload, encrypted),
    keypair: await derivePrivacyVaultKeypairFromMnemonic(normalized, derivationPath),
    mnemonic: normalized,
  };
}

export async function loadPrivacyVaultWorkingKey(
  keyRecord: PrivacyVaultEncryptedKeyRecord,
  password: string,
): Promise<{ workingKey: PrivacyVaultWorkingKey; normalizedKeyRecord?: PrivacyVaultEncryptedKeyRecord }> {
  if (keyRecord.version === 1) {
    const plaintext = await decryptString(keyRecord, password);
    const secretKey = Uint8Array.from(Buffer.from(plaintext, "base64"));
    const normalizedKeyRecord = await createEncryptedPrivacyVaultKeyRecord(secretKey, password);
    return {
      workingKey: {
        keypair: Keypair.fromSecretKey(secretKey),
        recoveryModel: "legacy-private-key",
      },
      normalizedKeyRecord,
    };
  }

  const plaintext = await decryptString(keyRecord, password);
  const payload = JSON.parse(plaintext) as PrivacyVaultSecretPayload;
  if (payload.version !== 2) {
    throw new Error("Unsupported Privacy Vault key format.");
  }

  if (payload.recoveryModel === "legacy-private-key") {
    const secretKey = Uint8Array.from(Buffer.from(payload.secretKeyBase64, "base64"));
    return {
      workingKey: {
        keypair: Keypair.fromSecretKey(secretKey),
        recoveryModel: "legacy-private-key",
      },
    };
  }

  return {
    workingKey: {
      keypair: await derivePrivacyVaultKeypairFromMnemonic(payload.mnemonic, payload.derivationPath),
      recoveryModel: "mnemonic",
      derivationPath: payload.derivationPath,
      mnemonic: payload.mnemonic,
    },
  };
}

export async function revealPrivacyVaultRecoveryMaterial(
  keyRecord: PrivacyVaultEncryptedKeyRecord,
  password: string,
): Promise<
  | { model: "mnemonic"; mnemonic: string; derivationPath: string; privateKeyBase58: string }
  | { model: "private-key"; privateKeyBase58: string }
> {
  const { workingKey } = await loadPrivacyVaultWorkingKey(keyRecord, password);
  const privateKeyBase58 = encodeBase58(workingKey.keypair.secretKey);
  if (workingKey.recoveryModel === "mnemonic" && workingKey.mnemonic && workingKey.derivationPath) {
    return {
      model: "mnemonic",
      mnemonic: workingKey.mnemonic,
      derivationPath: workingKey.derivationPath,
      privateKeyBase58,
    };
  }

  return {
    model: "private-key",
    privateKeyBase58,
  };
}
