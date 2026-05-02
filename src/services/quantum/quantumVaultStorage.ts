import { decryptString, encryptString } from "@/lib/crypto";
import {
  deriveWotsKeyPairFromMnemonic,
  deriveWotsKeyPairFromSeed,
  generateWotsKeyPair,
  nextPqcSigningPosition,
  type PqcSigningPosition,
  type WotsKeyPair,
  serializeWotsKeyPair,
  deserializeWotsKeyPair,
} from "@/services/quantum/wots";
import type { QuantumVaultEncryptedKeyRecord, QuantumVaultStoredKey } from "@/store/walletStore";

type QuantumVaultSecretPayload =
  | {
      version: 1;
      source: "random";
      walletIdHex: string;
      currentKeyPair: string;
    }
  | {
      version: 1;
      source: "bip39";
      walletIdHex: string;
      mnemonic: string;
      position: PqcSigningPosition;
    }
  | {
      version: 1;
      source: "legacy-seed";
      walletIdHex: string;
      seedHex: string;
      position: PqcSigningPosition;
    };

export interface QuantumVaultWorkingState {
  walletId: Uint8Array;
  walletIdHex: string;
  currentKeyPair: WotsKeyPair;
  source: QuantumVaultEncryptedKeyRecord["source"];
  recoverableWithMnemonic: boolean;
  position?: PqcSigningPosition;
  mnemonic?: string;
  seedHex?: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Expected an even-length hex string.");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function createRecordFromPayload(
  payload: QuantumVaultSecretPayload,
  currentKeyPair: WotsKeyPair,
  encrypted: Awaited<ReturnType<typeof encryptString>>,
): QuantumVaultEncryptedKeyRecord {
  return {
    kind: "quantum-vault-key",
    version: 1,
    source: payload.source,
    walletIdHex: payload.walletIdHex,
    currentPublicKeyHashHex: bytesToHex(currentKeyPair.publicKeyHash),
    position: "position" in payload ? payload.position : undefined,
    recoverableWithMnemonic: payload.source === "bip39",
    createdAt: Date.now(),
    ...encrypted,
  };
}

export async function createEncryptedQuantumVaultRecordFromRandomKeyPair(
  walletId: Uint8Array,
  currentKeyPair: WotsKeyPair,
  password: string,
): Promise<QuantumVaultEncryptedKeyRecord> {
  const payload: QuantumVaultSecretPayload = {
    version: 1,
    source: "random",
    walletIdHex: bytesToHex(walletId),
    currentKeyPair: serializeWotsKeyPair(currentKeyPair),
  };
  const encrypted = await encryptString(JSON.stringify(payload), password);
  return createRecordFromPayload(payload, currentKeyPair, encrypted);
}

export async function createEncryptedQuantumVaultRecordFromMnemonic(
  mnemonic: string,
  position: PqcSigningPosition,
  password: string,
): Promise<{ keyRecord: QuantumVaultEncryptedKeyRecord; currentKeyPair: WotsKeyPair; walletIdHex: string }> {
  const currentKeyPair = await deriveWotsKeyPairFromMnemonic(mnemonic, position);
  const payload: QuantumVaultSecretPayload = {
    version: 1,
    source: "bip39",
    walletIdHex: bytesToHex(currentKeyPair.publicKeyHash),
    mnemonic,
    position,
  };
  const encrypted = await encryptString(JSON.stringify(payload), password);
  return {
    keyRecord: createRecordFromPayload(payload, currentKeyPair, encrypted),
    currentKeyPair,
    walletIdHex: payload.walletIdHex,
  };
}

export function getQuantumVaultRecordSummary(record: QuantumVaultStoredKey | null | undefined): {
  exists: boolean;
  walletIdHex?: string;
  currentPublicKeyHashHex?: string;
  source?: QuantumVaultEncryptedKeyRecord["source"];
  recoverableWithMnemonic?: boolean;
  position?: PqcSigningPosition;
} {
  if (!record) {
    return { exists: false };
  }

  if (typeof record !== "string") {
    return {
      exists: true,
      walletIdHex: record.walletIdHex,
      currentPublicKeyHashHex: record.currentPublicKeyHashHex,
      source: record.source,
      recoverableWithMnemonic: record.recoverableWithMnemonic,
      position: record.position,
    };
  }

  const parsed = JSON.parse(record) as {
    version?: number;
    walletIdHex?: string;
    currentKeyPair?: unknown;
    source?: "random" | "bip39";
    seedHex?: string;
    position?: PqcSigningPosition;
  };
  if ((parsed.version === 2 || parsed.version === 3) && parsed.walletIdHex && parsed.currentKeyPair) {
    const currentKeyPair = deserializeWotsKeyPair(JSON.stringify(parsed.currentKeyPair));
    return {
      exists: true,
      walletIdHex: parsed.walletIdHex,
      currentPublicKeyHashHex: bytesToHex(currentKeyPair.publicKeyHash),
      source: parsed.version === 3
        ? parsed.seedHex && parsed.position
          ? "legacy-seed"
          : parsed.source ?? "random"
        : "random",
      recoverableWithMnemonic: parsed.version === 3 && parsed.source === "bip39" && !parsed.seedHex,
      position: parsed.position,
    };
  }

  const currentKeyPair = deserializeWotsKeyPair(record);
  return {
    exists: true,
    walletIdHex: bytesToHex(currentKeyPair.publicKeyHash),
    currentPublicKeyHashHex: bytesToHex(currentKeyPair.publicKeyHash),
    source: "random",
    recoverableWithMnemonic: false,
  };
}

export async function loadQuantumVaultWorkingState(
  record: QuantumVaultStoredKey,
  password: string,
): Promise<{ workingState: QuantumVaultWorkingState; normalizedKeyRecord?: QuantumVaultEncryptedKeyRecord }> {
  if (typeof record !== "string") {
    const plaintext = await decryptString(record, password);
    const payload = JSON.parse(plaintext) as QuantumVaultSecretPayload;
    if (payload.version !== 1) {
      throw new Error("Unsupported encrypted PQC key format.");
    }
    if (payload.source === "random") {
      const currentKeyPair = deserializeWotsKeyPair(payload.currentKeyPair);
      return {
        workingState: {
          walletId: hexToBytes(payload.walletIdHex),
          walletIdHex: payload.walletIdHex,
          currentKeyPair,
          source: "random",
          recoverableWithMnemonic: false,
        },
      };
    }
    if (payload.source === "bip39") {
      const currentKeyPair = await deriveWotsKeyPairFromMnemonic(payload.mnemonic, payload.position);
      return {
        workingState: {
          walletId: hexToBytes(payload.walletIdHex),
          walletIdHex: payload.walletIdHex,
          currentKeyPair,
          source: "bip39",
          recoverableWithMnemonic: true,
          position: payload.position,
          mnemonic: payload.mnemonic,
        },
      };
    }
    const currentKeyPair = await deriveWotsKeyPairFromSeed(hexToBytes(payload.seedHex), payload.position);
    return {
      workingState: {
        walletId: hexToBytes(payload.walletIdHex),
        walletIdHex: payload.walletIdHex,
        currentKeyPair,
        source: "legacy-seed",
        recoverableWithMnemonic: false,
        position: payload.position,
        seedHex: payload.seedHex,
      },
    };
  }

  const parsed = JSON.parse(record) as {
    version?: number;
    walletIdHex?: string;
    currentKeyPair?: unknown;
    source?: "random" | "bip39";
    seedHex?: string;
    position?: PqcSigningPosition;
  };
  if ((parsed.version === 2 || parsed.version === 3) && parsed.walletIdHex && parsed.currentKeyPair) {
    const currentKeyPair = deserializeWotsKeyPair(JSON.stringify(parsed.currentKeyPair));
    const walletIdHex = parsed.walletIdHex;
    if (parsed.version === 3 && parsed.seedHex && parsed.position) {
      const payload: QuantumVaultSecretPayload = {
        version: 1,
        source: "legacy-seed",
        walletIdHex,
        seedHex: parsed.seedHex,
        position: parsed.position,
      };
      const normalizedKeyRecord = createRecordFromPayload(
        payload,
        currentKeyPair,
        await encryptString(JSON.stringify(payload), password),
      );
      return {
        workingState: {
          walletId: hexToBytes(walletIdHex),
          walletIdHex,
          currentKeyPair,
          source: "legacy-seed",
          recoverableWithMnemonic: false,
          position: parsed.position,
          seedHex: parsed.seedHex,
        },
        normalizedKeyRecord,
      };
    }
    const payload: QuantumVaultSecretPayload = {
      version: 1,
      source: "random",
      walletIdHex,
      currentKeyPair: serializeWotsKeyPair(currentKeyPair),
    };
    const normalizedKeyRecord = createRecordFromPayload(
      payload,
      currentKeyPair,
      await encryptString(JSON.stringify(payload), password),
    );
    return {
      workingState: {
        walletId: hexToBytes(walletIdHex),
        walletIdHex,
        currentKeyPair,
        source: "random",
        recoverableWithMnemonic: false,
      },
      normalizedKeyRecord,
    };
  }

  const currentKeyPair = deserializeWotsKeyPair(record);
  const payload: QuantumVaultSecretPayload = {
    version: 1,
    source: "random",
    walletIdHex: bytesToHex(currentKeyPair.publicKeyHash),
    currentKeyPair: serializeWotsKeyPair(currentKeyPair),
  };
  const normalizedKeyRecord = createRecordFromPayload(
    payload,
    currentKeyPair,
    await encryptString(JSON.stringify(payload), password),
  );
  return {
    workingState: {
      walletId: currentKeyPair.publicKeyHash,
      walletIdHex: payload.walletIdHex,
      currentKeyPair,
      source: "random",
      recoverableWithMnemonic: false,
    },
    normalizedKeyRecord,
  };
}

export async function buildNextQuantumVaultRecord(
  workingState: QuantumVaultWorkingState,
  password: string,
): Promise<{ nextKeyRecord: QuantumVaultEncryptedKeyRecord; nextKeyPair: WotsKeyPair }> {
  if (workingState.source === "bip39") {
    if (!workingState.position || !workingState.mnemonic) {
      throw new Error("Missing BIP39 derivation data for this PQC wallet.");
    }
    const nextPosition = nextPqcSigningPosition(workingState.position);
    const nextKeyPair = await deriveWotsKeyPairFromMnemonic(workingState.mnemonic, nextPosition);
    const payload: QuantumVaultSecretPayload = {
      version: 1,
      source: "bip39",
      walletIdHex: workingState.walletIdHex,
      mnemonic: workingState.mnemonic,
      position: nextPosition,
    };
    return {
      nextKeyRecord: createRecordFromPayload(
        payload,
        nextKeyPair,
        await encryptString(JSON.stringify(payload), password),
      ),
      nextKeyPair,
    };
  }

  if (workingState.source === "legacy-seed") {
    if (!workingState.position || !workingState.seedHex) {
      throw new Error("Missing legacy PQC seed data for this wallet.");
    }
    const nextPosition = nextPqcSigningPosition(workingState.position);
    const nextKeyPair = await deriveWotsKeyPairFromSeed(hexToBytes(workingState.seedHex), nextPosition);
    const payload: QuantumVaultSecretPayload = {
      version: 1,
      source: "legacy-seed",
      walletIdHex: workingState.walletIdHex,
      seedHex: workingState.seedHex,
      position: nextPosition,
    };
    return {
      nextKeyRecord: createRecordFromPayload(
        payload,
        nextKeyPair,
        await encryptString(JSON.stringify(payload), password),
      ),
      nextKeyPair,
    };
  }

  const nextKeyPair = await generateWotsKeyPair();
  return {
    nextKeyRecord: await createEncryptedQuantumVaultRecordFromRandomKeyPair(
      workingState.walletId,
      nextKeyPair,
      password,
    ),
    nextKeyPair,
  };
}

export async function revealQuantumVaultRecoveryMaterial(
  record: QuantumVaultStoredKey,
  password: string,
): Promise<
  | { model: "mnemonic"; walletIdHex: string; mnemonic: string; position: PqcSigningPosition }
  | { model: "backup-only"; walletIdHex: string; reason: string }
> {
  const { workingState } = await loadQuantumVaultWorkingState(record, password);
  if (typeof record !== "string") {
    const plaintext = await decryptString(record, password);
    const payload = JSON.parse(plaintext) as QuantumVaultSecretPayload;
    if (payload.source === "bip39") {
      return {
        model: "mnemonic",
        walletIdHex: payload.walletIdHex,
        mnemonic: payload.mnemonic,
        position: payload.position,
      };
    }
  }

  return {
    model: "backup-only",
    walletIdHex: workingState.walletIdHex,
    reason:
      workingState.source === "legacy-seed"
        ? "This PQC wallet was created before phrase-backed secure storage. Its original phrase cannot be reconstructed; use an encrypted backup or rotate to a new mnemonic-backed PQC wallet."
        : "This PQC wallet uses local one-time key material only. Use an encrypted wallet backup to preserve it.",
  };
}
