import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import {
  createEncryptedQuantumVaultRecordFromMnemonic,
  createEncryptedQuantumVaultRecordFromRandomKeyPair,
  buildNextQuantumVaultRecord,
  loadQuantumVaultWorkingState,
  revealQuantumVaultRecoveryMaterial,
} from "@/services/quantum/quantumVaultStorage";
import {
  bytesToHex,
  generatePqcMnemonic,
  generateWotsKeyPair,
  pqcWalletAdvanceMessage,
  serializeWotsSignature,
  validatePqcMnemonic,
  wotsSignMessage,
  wotsVerifyMessage,
  type PqcSigningPosition,
} from "@/services/quantum/wots";
import {
  WALLET_STORAGE_KEY,
  readWalletPersistedEnvelope,
  writeWalletPersistedEnvelope,
} from "@/lib/walletPersistStorage";
import type { PersistedWalletState, QuantumVaultEncryptedKeyRecord } from "@/store/walletStore";
import {
  assertWalletPasswordInBackground,
  readPersistedWalletState,
  requireUnlockedPassword,
} from "@/background/sessionState";

const INITIAL_PQC_POSITION: PqcSigningPosition = { wallet: 0, parent: 0, child: 0 };

async function writePersistedWalletState(state: PersistedWalletState): Promise<void> {
  const existingEnvelope = await readWalletPersistedEnvelope<PersistedWalletState>(WALLET_STORAGE_KEY);
  await writeWalletPersistedEnvelope(
    {
      ...(existingEnvelope ?? {}),
      state,
    },
    WALLET_STORAGE_KEY,
  );
}

export async function createQuantumVaultKeyInBackground(options: {
  mode: "generated" | "imported" | "random";
  mnemonic?: string;
}): Promise<{
  keyRecord: QuantumVaultEncryptedKeyRecord;
  walletIdHex: string;
  currentRootHex: string;
  recoveryPhrase?: string;
}> {
  const password = requireUnlockedPassword();

  if (options.mode === "generated") {
    const recoveryPhrase = generatePqcMnemonic();
    const { keyRecord, currentKeyPair, walletIdHex } = await createEncryptedQuantumVaultRecordFromMnemonic(
      recoveryPhrase,
      INITIAL_PQC_POSITION,
      password,
    );
    return {
      keyRecord,
      walletIdHex,
      currentRootHex: bytesToHex(currentKeyPair.publicKeyHash),
      recoveryPhrase,
    };
  }

  if (options.mode === "imported") {
    const normalizedMnemonic = options.mnemonic?.trim() ?? "";
    if (!validatePqcMnemonic(normalizedMnemonic)) {
      throw new Error("Enter a valid BIP39 recovery phrase before importing.");
    }
    const { keyRecord, currentKeyPair, walletIdHex } = await createEncryptedQuantumVaultRecordFromMnemonic(
      normalizedMnemonic,
      INITIAL_PQC_POSITION,
      password,
    );
    return {
      keyRecord,
      walletIdHex,
      currentRootHex: bytesToHex(currentKeyPair.publicKeyHash),
    };
  }

  const currentKeyPair = await generateWotsKeyPair();
  const walletIdHex = bytesToHex(currentKeyPair.publicKeyHash);
  return {
    keyRecord: await createEncryptedQuantumVaultRecordFromRandomKeyPair(
      currentKeyPair.publicKeyHash,
      currentKeyPair,
      password,
    ),
    walletIdHex,
    currentRootHex: walletIdHex,
  };
}

export async function prepareQuantumVaultAdvanceInBackground(params: {
  walletPublicKey: string;
  currentRootHex: string;
  destinationAddress: string;
  amountLamports: string;
  sequence: string;
}): Promise<{
  walletIdHex: string;
  signature: string;
  nextRootHex: string;
  proofPreviewHex: string;
  nextKeyRecord: QuantumVaultEncryptedKeyRecord;
}> {
  const password = requireUnlockedPassword();
  const state = await readPersistedWalletState();
  const storedRecord = state.quantumVaultKeys[params.walletPublicKey];
  if (!storedRecord) {
    throw new Error("No local Winternitz key is stored for this PQC wallet.");
  }

  const { workingState, normalizedKeyRecord } = await loadQuantumVaultWorkingState(storedRecord, password);
  if (normalizedKeyRecord) {
    state.quantumVaultKeys[params.walletPublicKey] = normalizedKeyRecord;
    await writePersistedWalletState(state);
  }

  if (bytesToHex(workingState.currentKeyPair.publicKeyHash) !== params.currentRootHex) {
    throw new Error("Stored Winternitz key does not match the current onchain wallet root.");
  }

  const { nextKeyRecord, nextKeyPair } = await buildNextQuantumVaultRecord(workingState, password);
  const message = await pqcWalletAdvanceMessage(
    workingState.walletId,
    workingState.currentKeyPair.publicKeyHash,
    nextKeyPair.publicKeyHash,
    new PublicKey(params.destinationAddress).toBytes(),
    BigInt(params.amountLamports),
    BigInt(params.sequence),
  );
  const signature = await wotsSignMessage(message, workingState.currentKeyPair.secretKey);
  const valid = await wotsVerifyMessage(message, signature, workingState.currentKeyPair.publicKey);
  if (!valid) {
    throw new Error("PQC signature verification failed.");
  }

  const signatureBytes = serializeWotsSignature(signature);
  return {
    walletIdHex: workingState.walletIdHex,
    signature: Buffer.from(signatureBytes).toString("base64"),
    nextRootHex: bytesToHex(nextKeyPair.publicKeyHash),
    proofPreviewHex: `${bytesToHex(signatureBytes).slice(0, 64)}...`,
    nextKeyRecord,
  };
}

export async function revealQuantumVaultRecoveryMaterialInBackground(
  walletPublicKey: string,
  password: string,
): Promise<
  | { model: "mnemonic"; walletIdHex: string; mnemonic: string; position: PqcSigningPosition }
  | { model: "backup-only"; walletIdHex: string; reason: string }
> {
  await assertWalletPasswordInBackground(password);
  const state = await readPersistedWalletState();
  const storedRecord = state.quantumVaultKeys[walletPublicKey];
  if (!storedRecord) {
    throw new Error("No local PQC wallet secret is stored for this account.");
  }
  return revealQuantumVaultRecoveryMaterial(storedRecord, password);
}

export async function migrateQuantumVaultRecordsInBackground(): Promise<void> {
  const password = requireUnlockedPassword();
  const state = await readPersistedWalletState();
  let changed = false;

  for (const [walletPublicKey, storedRecord] of Object.entries(state.quantumVaultKeys)) {
    if (typeof storedRecord !== "string") {
      continue;
    }
    const { normalizedKeyRecord } = await loadQuantumVaultWorkingState(storedRecord, password);
    if (normalizedKeyRecord) {
      state.quantumVaultKeys[walletPublicKey] = normalizedKeyRecord;
      changed = true;
    }
  }

  if (changed) {
    await writePersistedWalletState(state);
  }
}
